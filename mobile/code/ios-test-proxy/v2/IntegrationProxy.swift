@@ -0,0 +1,544 @@
//
// Copyright 2026 Wultra s.r.o.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions
// and limitations under the License.
//

// Requires PowerAuth SDK 2.0.x

import Foundation
import PowerAuth2

/// Standalone test SDK that orchestrates PowerAuth activations and PowerAuth
/// Cloud server interactions for integration tests.
///
/// The proxy is a test target that links `PowerAuth2`. Supply a
/// `Config` instance, and use it to drive cloud-side fixtures (operations,
/// inbox messages, OIDC providers) and a fully activated `PowerAuthSDK`
/// instance. When `WultraPowerAuthNetworking` is also linked, the proxy
/// additionally exposes a `createNetworkingService(url:serviceName:)` helper
/// for building `WPNNetworkingService` instances on top of the activation.
///
/// ## How to use
///
/// 1. Construct a `Config` with your PowerAuth Cloud credentials, application
///    id and enrollment server URL (e.g. by loading a JSON file bundled with
///    your tests). `sdkConfig` is **not** part of `Config` — it is fetched on
///    demand from the cloud server.
/// 2. Create the proxy:
///    ```swift
///    let proxy = IntegrationProxy(config: config)
///    ```
///    The init is non-throwing; nothing is contacted at this point.
/// 3. Initialize PowerAuth before any activation or networking call:
///    ```swift
///    try await proxy.initializePowerauth()
///    ```
///    This calls `GET /admin/applications/{cloudApplicationId}` and uses the
///    returned `mobileSdkConfig` to instantiate `proxy.powerAuth`. Any local
///    activation is cleared. The instance is *not* activated yet.
/// 4. (Optional) Activate the instance against the cloud server when the
///    test needs a signed/token-signed/E2EE flow:
///    ```swift
///    try await proxy.prepareActivation()
///    ```
/// 5. Use the proxy to drive cloud-side fixtures and SDK calls, e.g.:
///    ```swift
///    let op = try await proxy.createOperation()
///    let service = try proxy.createNetworkingService(url: "https://...")
///    ```
/// 6. Tear the activation down at the end of the test:
///    ```swift
///    await proxy.cleanup()
///    ```
///
/// ## Lifecycle expectations
///
/// - `powerAuth`, `createNetworkingService(...)` and `prepareActivation()`
///   require `initializePowerauth()` to have been called first; otherwise the
///   proxy throws `IntegrationError.powerAuthNotInitialized`.
/// - QR-related operation helpers (`getQROperation`, `verifyQROperation`)
///   require an active activation; otherwise the proxy throws
///   `IntegrationError.activationRequired`.
/// - `cleanup()` is a no-op when no activation has been created.
public class IntegrationProxy {

    // MARK: - Public state

    /// PIN used when persisting and removing the local activation. Random by
    /// default; pass a custom value to the init when a test needs a specific
    /// PIN (for example to assert wrong-PIN behavior).
    public let pin: String

    /// PowerAuth instance backing the proxy. `nil` until
    /// `initializePowerauth()` succeeds.
    public private(set) var powerAuth: PowerAuthSDK?

    /// Server-side activation (registration) id. `nil` until
    /// `prepareActivation()` succeeds.
    public private(set) var activationId: String?

    public let activationName = UUID().uuidString
    public let config: Config

    // MARK: - Inits

    /// Creates a proxy bound to the given `Config`. The PowerAuth instance is
    /// not created yet; call `initializePowerauth()` to fetch the SDK
    /// configuration from the cloud server and instantiate `powerAuth`.
    public init(config: Config, pin: String = UUID().uuidString) {
        self.pin = pin
        self.config = config
    }

    // MARK: - PowerAuth setup

    /// Fetches the application detail from the PowerAuth Cloud admin API and
    /// uses its `mobileSdkConfig` to instantiate `powerAuth`. Any local
    /// activation is cleared. Does **not** activate the instance — call
    /// `prepareActivation()` afterwards if the test needs an activation.
    public func initializePowerauth() async throws {
        let detail = try await getApplicationDetail()
        let pa = try PowerAuthSDK(configuration: .init(
            instanceId: "integration-test",
            baseEndpointUrl: config.enrollmentServerUrl,
            configuration: detail.mobileSdkConfig
        ))
        pa.removeActivationLocal()
        self.powerAuth = pa
        log("PowerAuthSDK initialized with baseEndpointUrl: \(config.enrollmentServerUrl)")
    }

    /// Returns application detail from PowerAuth Cloud admin API
    /// (`GET /admin/applications/{id}`).
    public func getApplicationDetail() async throws -> ApplicationDetail {
        return try await makeCloudRequest(
            path: "/admin/applications/\(config.cloudApplicationId)",
            method: "GET"
        )
    }

    // MARK: - Activation

    /// Creates a PowerAuth activation against the cloud server.
    /// Requires `initializePowerauth()` to have been called first.
    public func prepareActivation() async throws {

        guard let pa = powerAuth else {
            throw IntegrationError.powerAuthNotInitialized
        }

        log("Creating server activation...")
        let activation = try await createServerActivation(config: config)
        self.activationId = activation.activationId
        log("Server activation created: \(activation.activationId)")

        let paActivation = try PowerAuthActivation(activationCode: activation.activationCode, name: UUID().uuidString)

        log("Creating local activation...")
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            pa.createActivation(paActivation) { [self] _, error in
                if let error {
                    log("Local activation failed: \(error.localizedDescription)")
                    continuation.resume(throwing: error)
                } else {
                    do {
                        try pa.persistActivation(withPassword: self.pin)
                        log("Activation persisted successfully")
                        continuation.resume()
                    } catch {
                        log("Persist activation failed: \(error.localizedDescription)")
                        continuation.resume(throwing: error)
                    }
                }
            }
        }
    }

    /// Removes the activation from the server and clears local data. No-op
    /// when the proxy has not yet initialized PowerAuth or has no activation.
    public func cleanup() async {
        log("Cleaning up activation")
        guard let powerAuth else { return }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            powerAuth.removeActivation(with: .possessionWithPassword(password: pin)) { error in
                if error != nil {
                    // on error, at least remove the activation locally
                    powerAuth.removeActivationLocal()
                }
                continuation.resume()
            }
        }
    }

    // MARK: - Operations

    /// Two-factor authentication factor combinations supported by the proxy
    /// when creating operations.
    public enum Factors {
        case F_2FA
    }

    /// Creates a personalised operation on the cloud server for the proxy's
    /// user (the activation owner).
    public func createOperation(_ factors: Factors = .F_2FA) async throws -> OperationObject {
        let body: String
        switch factors {
        case .F_2FA:
            body = """
            {
              "userId": "\(activationName)",
              "template": "login",
              "parameters": {
                "party.id": "666",
                "party.name": "Datová schránka",
                "session.id": "123",
                "session.ip-address": "192.168.0.1"
              }
            }
            """
        }
        return try await makeCloudRequest(path: "/v2/operations", jsonBody: body)
    }

    /// Cancels an operation on the cloud server with the given reason.
    public func cancelOperation(operationId: String, reason: String) async throws -> CancelObject {
        return try await makeCloudRequest(
            path: "/v2/operations/\(operationId)?statusReason=\(reason)",
            method: "DELETE"
        )
    }

    /// Creates a non-personalised proximity-check operation on the cloud server.
    public func createNonPersonalisedPACOperation(_ factors: Factors = .F_2FA) async throws -> OperationObject {
        let body: String
        switch factors {
        case .F_2FA:
            body = """
            {
              "template": "login_preApproval",
              "proximityCheckEnabled": true,
              "parameters": {
                "party.id": "666",
                "party.name": "Datová schránka",
                "session.id": "123",
                "session.ip-address": "192.168.0.1"
              }
            }
            """
        }
        return try await makeCloudRequest(path: "/v2/operations", jsonBody: body)
    }

    /// Fetches operation details by id.
    public func getOperation(operationId: String) async throws -> OperationObject {
        return try await makeCloudRequest(path: "/v2/operations/\(operationId)", method: "GET")
    }

    /// Fetches QR-code (offline) data for an operation. Requires an activation.
    public func getQROperation(operationId: String) async throws -> QROperationData {
        guard let activationId else { throw IntegrationError.activationRequired }
        return try await makeCloudRequest(
            path: "/v2/operations/\(operationId)/offline/qr?registrationId=\(activationId)",
            method: "GET"
        )
    }

    /// Verifies the OTP produced from a QR operation. Requires an activation.
    public func verifyQROperation(operationId: String, operationData: QROperationData, otp: String) async throws -> QROperationVerify {
        guard let activationId else { throw IntegrationError.activationRequired }
        let body = """
        {
          "otp": "\(otp)",
          "nonce": "\(operationData.nonce)",
          "registrationId": "\(activationId)"
        }
        """
        return try await makeCloudRequest(path: "/v2/operations/\(operationId)/offline/otp", jsonBody: body)
    }

    // MARK: - Inbox

    /// Creates `count` inbox messages for the proxy's user. Returns details
    /// for successfully created messages; failures are logged and skipped so
    /// that a single bad message does not abort the batch.
    public func createInboxMessages(
        count: Int,
        defaultType: String = "text",
        createFunc: ((Int) -> InboxMessage)? = nil
    ) async throws -> [InboxMessageDetail] {

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .millisecondsSince1970

        var result: [InboxMessageDetail] = []
        for index in 1...count {
            let message = createFunc?(index) ?? InboxMessage(
                subject: "Message #\(index)",
                summary: "This is body for message \(index).",
                body: "This is body for message \(index).",
                type: defaultType
            )
            let body = """
            {
                "userId":"\(activationName)",
                "subject":"\(message.subject)",
                "summary":"\(message.summary)",
                "body":"\(message.body)",
                "type":"\(message.type)",
                "silent":true
            }
            """
            do {
                let detail: InboxMessageDetail = try await makeCloudRequest(
                    path: "/v2/inbox/messages",
                    jsonBody: body,
                    decoder: decoder
                )
                result.append(detail)
            } catch {
                log("ERROR: Failed to create message #\(index): \(error)")
            }
        }
        return result
    }

    // MARK: - OIDC

    /// Returns OIDC provider properties from the configuration, when present.
    public func getOIDCProviders() -> OIDCProperties? {
        guard
            let providerId = config.oidcProviderId,
            let providerIdPkce = config.oidcProviderIdPkce
        else {
            return nil
        }
        return OIDCProperties(providerId: providerId, providerIdPkce: providerIdPkce)
    }

    // MARK: - Helpers

    private struct ActivationData {
        let activationId: String
        let activationCode: String
    }

    private func createServerActivation(config: Config) async throws -> ActivationData {
        let body = """
        {
          "appId": "\(config.cloudApplicationId)",
          "userId": "\(activationName)",
          "commitPhase": "ON_KEY_EXCHANGE"
        }
        """
        struct RegistrationResponse: Decodable {
            let registrationId: String
            let activationCode: String
        }
        let response: RegistrationResponse = try await makeCloudRequest(path: "/v2/registrations", jsonBody: body)
        return ActivationData(activationId: response.registrationId, activationCode: response.activationCode)
    }

    private func makeCloudRequest<T: Decodable>(
        path: String,
        method: String = "POST",
        jsonBody: String = "",
        decoder: JSONDecoder = JSONDecoder()
    ) async throws -> T {

        let url = URL(string: "\(config.cloudServerUrl)\(path)")!
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !jsonBody.isEmpty {
            request.httpBody = jsonBody.data(using: .utf8)
        }

        let credentials = "\(config.cloudServerLogin):\(config.cloudServerPassword)"
        let base64 = Data(credentials.utf8).base64EncodedString()
        request.setValue("Basic \(base64)", forHTTPHeaderField: "Authorization")

        log("\(method) \(url.absoluteString)")
        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            log("No HTTP response from \(url.absoluteString)")
            throw IntegrationError.cloudServerError
        }

        log("Response \(httpResponse.statusCode) from \(url.absoluteString)")

        guard httpResponse.statusCode == 200 else {
            log("Response body: \(String(decoding: data, as: UTF8.self))")
            throw IntegrationError.cloudServerError
        }

        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            log("Failed to decode response: \(String(decoding: data, as: UTF8.self))")
            throw error
        }
    }

    private func log(_ message: String) {
        print("[IntegrationProxy] \(message)")
    }
}

// MARK: - Errors

/// Errors thrown by `IntegrationProxy` when a precondition is not met or when
/// the cloud server returns a non-success response.
public enum IntegrationError: Error, CustomStringConvertible {
    case powerAuthCreationFailed
    case powerAuthNotInitialized
    case activationFailed
    case activationRequired
    case cloudServerError

    public var description: String {
        switch self {
        case .powerAuthCreationFailed: return "Failed to create PowerAuthSDK instance"
        case .powerAuthNotInitialized: return "PowerAuth has not been initialized; call initializePowerauth() first"
        case .activationFailed: return "Failed to create or commit activation"
        case .activationRequired: return "Operation requires an active activation; call prepareActivation() first"
        case .cloudServerError: return "Cloud server request failed"
        }
    }
}

// MARK: - Config

/// Connection details consumed by `IntegrationProxy`. The mobile SDK
/// configuration is intentionally **not** part of this struct — it is fetched
/// at runtime via `IntegrationProxy.getApplicationDetail()`.
public struct Config: Decodable {
    public let cloudServerUrl: String
    public let cloudServerLogin: String
    public let cloudServerPassword: String
    public let cloudApplicationId: String
    public let enrollmentServerUrl: String
    public let oidcProviderId: String?
    public let oidcProviderIdPkce: String?

    public init(
        cloudServerUrl: String,
        cloudServerLogin: String,
        cloudServerPassword: String,
        cloudApplicationId: String,
        enrollmentServerUrl: String,
        oidcProviderId: String? = nil,
        oidcProviderIdPkce: String? = nil
    ) {
        self.cloudServerUrl = cloudServerUrl
        self.cloudServerLogin = cloudServerLogin
        self.cloudServerPassword = cloudServerPassword
        self.cloudApplicationId = cloudApplicationId
        self.enrollmentServerUrl = enrollmentServerUrl
        self.oidcProviderId = oidcProviderId
        self.oidcProviderIdPkce = oidcProviderIdPkce
    }
}

// MARK: - Cloud server models

/// Response of `GET /admin/applications/{id}` on the PowerAuth Cloud admin
/// API.
public struct ApplicationDetail: Decodable {
    public let id: String
    public let serviceBaseUrl: String
    public let appKey: String
    public let appSecret: String
    public let mobileSdkConfig: String
}

public struct OperationObject: Decodable {
    public let operationId: String
    public let userId: String?
    public let status: String
    public let operationType: String
    public let failureCount: Int
    public let maxFailureCount: Int
    public let timestampCreated: Int
    public let timestampExpires: Int
    public let proximityOtp: String?
    /// Additional data is a dictionary of `[String: Any]` on the server, but
    /// we expose `TestAdditionalData` for non-generic decoding. Extend that
    /// type if your tests need more fields.
    public let additionalData: TestAdditionalData?
}

public struct TestAdditionalData: Decodable {
    public let mobileTokenData: TestMobileTokenData?
}

public struct TestMobileTokenData: Decodable {
    public let test1: Int?
    public let test2: Double?
    public let test3: String?
    public let test4: [String: Bool]?

    public let preApprovalScreens: [TestPreApprovalVisit]?
    public let customRecord: CustomRecordData?
}

public struct TestPreApprovalVisit: Decodable {
    public let screen: String?
    public let timestampOpened: String?
    public let timestampClosed: String?
    public let action: String?
}

public struct CustomRecordData: Decodable {
    public let flag: Bool?
    public let mode: String?
}

public struct CancelObject: Decodable {
    public let status: String
}

public struct QROperationData: Decodable {
    public let operationQrCodeData: String
    public let nonce: String
}

public struct QROperationVerify: Decodable {
    public let otpValid: Bool
    public let userId: String
    public let registrationId: String
    public let registrationStatus: String
    public let signatureType: String
    public let remainingAttempts: Int
}

public struct InboxMessage: Codable {
    public let subject: String
    public let summary: String
    public let body: String
    public let type: String
}

public struct InboxMessageDetail: Decodable {
    public let id: String
    public let subject: String
    public let summary: String
    public let body: String
    public let type: String
    public let timestamp: Date
    public let read: Bool
}

public struct OIDCProperties {
    public let providerId: String
    public let providerIdPkce: String
}
