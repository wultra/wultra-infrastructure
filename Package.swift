// swift-tools-version:5.9

import PackageDescription

let package = Package(
    name: "WultraPowerAuthTestIntegrationProxyV1",
    platforms: [
        .iOS(.v13),
        .tvOS(.v13)
    ],
    products: [
        .library(
            name: "WultraPowerAuthTestIntegrationProxyV1",
            type: .dynamic,
            targets: ["WultraPowerAuthTestIntegrationProxyV1"])
    ],
    dependencies: [
        .package(url: "https://github.com/wultra/powerauth-mobile-sdk-spm.git", .upToNextMinor(from: "1.9.2"))
    ],
    targets: [
        .target(
            name: "WultraPowerAuthTestIntegrationProxyV1",
            dependencies: [
                .product(name: "PowerAuth2", package: "powerauth-mobile-sdk-spm"),
                .product(name: "PowerAuthCore", package: "powerauth-mobile-sdk-spm")
            ],
            path: "mobile/utils/ios-test-proxy/v1")
    ],
    swiftLanguageVersions: [.v5]
)
