# Wultra Infrastructure _[Mobile edition]_

This branch hosts shared scripts and source-level utilities that support Wultra's mobile SDKs (iOS, Android, Flutter, React Native, …). Everything is fetched directly from this repository (via `curl` or a build-phase script) and executed on the consumer's CI or developer machine. Individual SDK repositories don't have to vendor and maintain their own copies.

> [!NOTE]
> This branch is not being synced with develop, and all changes have to be done via pull requests.

## Repository layout

- All shared assets live under the [`mobile/`](./mobile) folder.
- Each asset is versioned by its path segment (`v1`, `v2`, …). A new major version is introduced whenever a breaking change is made; older versions remain available so existing consumers keep working.
- Scripts and source files are fetched from the `mobile` branch via `raw.githubusercontent.com`, e.g.:
  ```
  https://raw.githubusercontent.com/wultra/wultra-infrastructure/refs/heads/mobile/mobile/<area>/<script>/<version>/<file>
  ```

## Requirements

- **Node.js** – required for the Node-based scripts (no external npm dependencies).
- **Bash** – the snippets below assume a POSIX shell (macOS / Linux / GitHub Actions runners).
- **Xcode 15+** – required when using the iOS test integration proxy.

## Versioning policy

A version (`v1`, `v2`, …) is **frozen** once published. Bug-fix and backwards-compatible changes are made in place; any breaking change is shipped as a new `vN+1` folder.

---

# Available scripts and utilities

## Prepare release [v1]

Prepares (or verifies) an SDK repository for a new release: bumps version numbers in the project files declared by the definition file, validates the git state, and reports any inconsistencies.

- Runs in **prepare** mode when a version is supplied (`-v <version>`).
- Runs in **verify** mode when no version is supplied or `--verify` is used – the version is read from the library's definition file and the repository is checked against it.
- The script does **not** commit, push, or tag anything; that is the caller's responsibility.
- Expects a `.prepare-release.json` definition file in the repository root. See the [mtoken-sdk-flutter](https://github.com/wultra/mtoken-sdk-flutter/) repository for a real-world example.

**Arguments**

| Flag | Description |
| --- | --- |
| `-p <path>` | Path to the project root (required). |
| `-v <version>` | Target version (e.g. `1.4.2`). When omitted, the script runs in verify mode. |
| `--verify` | Force verify mode even when a version is provided. |
| `--ignore-git-clean` | Skip the "clean git working tree" check. |
| `-h`, `--help` | Print usage. |

**Example usage**

```bash
# path to the script folder
SCRIPT_FOLDER=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )

# URL of the prepare-release script in the Wultra infrastructure repository
URL="https://raw.githubusercontent.com/wultra/wultra-infrastructure/refs/heads/mobile/mobile/release/prepare/v1/prepare-release.js"

# Pipe the remote script into Node and forward all arguments,
# while pinning the project root to the parent of the script folder.
curl -fsSL "${URL}" | node - -p "${SCRIPT_FOLDER}/.." "${@}"
```


## Get iOS Simulator [v1]

Resolves the newest iOS Simulator destination that is compatible with a given Xcode project scheme. Useful for keeping CI test runs working as Xcode and simulator runtimes change over time.

**Arguments**

| Position | Description |
| --- | --- |
| `-p <path>` | Path to the project root (required). |
| `<xcodeproj-path>` | Path to the `.xcodeproj` (relative to the project root). |
| `<scheme-name>` | Xcode scheme to resolve a destination for. |

The script prints a single `-destination` value (e.g. `platform=iOS Simulator,id=…`) on stdout, suitable for being captured into a shell variable and passed to `xcodebuild`.

**Example usage**

```bash
SCRIPT_FOLDER=$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )
XCODE_PROJECT="MyAwesomeSDK.xcodeproj"
XCODE_SCHEME="MyAwesomeSDKTest"

# Function that resolves the best available simulator for the test run
function getSimulatorDestination {
  local scriptUrl="https://raw.githubusercontent.com/wultra/wultra-infrastructure/refs/heads/mobile/mobile/utils/ios-get-simulator/v1/get-ios-sim.js"
  curl -fsSL "${scriptUrl}" | node - -p "${SCRIPT_FOLDER}/.." "${XCODE_PROJECT}" "${XCODE_SCHEME}"
}

echo "Resolving the best simulator for the ${XCODE_SCHEME}..."
DESTINATION=$(getSimulatorDestination)

echo "Simulator to use: ${DESTINATION}"
```

**Real-life example**

- [wultra/networking-apple – `scripts/test.sh`](https://github.com/wultra/networking-apple/blob/develop/scripts/test.sh)


## iOS Test Integration Proxy

A single-file Swift utility (`IntegrationProxy.swift`) that orchestrates PowerAuth activations and PowerAuth Cloud server interactions for integration tests of Wultra's iOS SDKs. The file is downloaded directly from this repository and added to your test target — no package manager dependency is required.

Sources live under [`mobile/code/ios-test-proxy/`](./mobile/code/ios-test-proxy/).

| Version | Path | PowerAuth SDK compatibility |
| --- | --- | --- |
| **v1** | [`mobile/code/ios-test-proxy/v1/IntegrationProxy.swift`](./mobile/code/ios-test-proxy/v1/IntegrationProxy.swift) | PowerAuth SDK `1.9.x` |
| **v2** | [`mobile/code/ios-test-proxy/v2/IntegrationProxy.swift`](./mobile/code/ios-test-proxy/v2/IntegrationProxy.swift) | PowerAuth SDK `2.0.x` |

**What it provides**

- `IntegrationProxy` – drives PowerAuth Cloud fixtures (operations, inbox messages, OIDC providers) and a fully activated `PowerAuthSDK` instance.
- `Config` – connection details (cloud server URL & credentials, application id, enrollment server URL, optional OIDC providers). The mobile SDK configuration is fetched at runtime, not stored in `Config`.

**Adding to your project**

Download the file into your test target's source tree. You can do this manually or automate it with an Xcode build phase (see below).

Raw download URL (replace `<version>` with `v1` or `v2`):

```
https://raw.githubusercontent.com/wultra/wultra-infrastructure/refs/heads/mobile/mobile/code/ios-test-proxy/<version>/IntegrationProxy.swift
```

### Xcode scheme pre-action integration

You can add the download script as a **Build Pre-action** in your test scheme so that `IntegrationProxy.swift` is fetched automatically before compilation. This way new contributors and CI runners get the file without manual steps.

**How to set it up:**

1. Click on the scheme name (e.g. `MySDKTests`) at the top of the Xcode window.
2. Select **Edit Scheme…**
3. Expand the **Build** item on the left side of the editor.
4. Select **Pre-actions**.
5. Click **+** → **New Run Script Action**.
6. Set **Provide build settings from** to your test target.
7. Paste the script below.

```bash
set -e
set -x

# ---- CONFIG ----
FILE_NAME="IntegrationProxy.swift"
FILE_PATH="${SRCROOT}/WultraPowerAuthNetworkingTests/IntegrationTests/IntegrationProxy/${FILE_NAME}"
DOWNLOAD_URL="https://raw.githubusercontent.com/wultra/wultra-infrastructure/refs/heads/mobile/mobile/code/ios-test-proxy/v1/${FILE_NAME}"

# ---- LOGGING ----
echo "Checking for required file at: ${FILE_PATH}"

# ---- CHECK + DOWNLOAD ----
if [ -f "${FILE_PATH}" ]; then
    # print it as a warning just to be sure the runner will be notified
    echo "warning: ${FILE_NAME} already exists. Skipping download. Be aware that this script does not check for new versions of the file. To update the file, delete it from the project first."
else
    echo "File not found. Downloading..."

    # Download using curl
    curl -L --fail --silent --show-error "${DOWNLOAD_URL}" -o "${FILE_PATH}"

    echo "Download completed."

    # Verify that the file exists
    if [ -f "${FILE_PATH}" ]; then
        echo "File is present: ${FILE_PATH}"
        sleep 3 # wait for 3 seconds to be sure xcode picks-up the file
    else
        echo "ERROR: File is still missing after download attempt."
        exit 1
    fi
fi
```

> Adjust `FILE_PATH` and `DOWNLOAD_URL` (version) to match your project layout and required proxy version.

**Example usage**

```swift
let config = Config(
    cloudServerUrl: "https://cloud.example.com",
    cloudServerLogin: "login",
    cloudServerPassword: "password",
    cloudApplicationId: "app-id",
    enrollmentServerUrl: "https://enrollment.example.com"
)

let proxy = IntegrationProxy(config: config)
try await proxy.initializePowerauth()
try await proxy.prepareActivation()

let operation = try await proxy.createOperation()
// ... drive your test ...

await proxy.cleanup()
```

> [!NOTE]
> **Why not Swift Package Manager?** SPM adds unnecessary overhead for a single utility file — it introduces an extra dependency to resolve, slows down package resolution, and complicates version management. Distributing the file directly makes it trivial to drop into any test target and easy to edit or replace locally when needed.
