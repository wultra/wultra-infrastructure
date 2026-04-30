# Wultra Infrastructure _[Mobile edition]_

This branch hosts shared scripts that support Wultra's mobile SDKs (iOS, Android, Flutter, React Native, …). The scripts are meant to be fetched directly from this repository (via `curl`) and executed on the consumer's CI or developer machine, so individual SDK repositories don't have to vendor and maintain their own copies.

> [!NOTE]
> This branch is not being synced with develop, and all changes have to be done via pull requests.

## Repository layout

- All scripts live under the [`mobile/`](./mobile) folder.
- Each script is versioned by its path segment (`v1`, `v2`, …). A new major version is introduced whenever a breaking change is made; older versions remain available so existing consumers keep working.
- Scripts are fetched from the `mobile` branch via `raw.githubusercontent.com`, e.g.:
  ```
  https://raw.githubusercontent.com/wultra/wultra-infrastructure/refs/heads/mobile/mobile/<area>/<script>/<version>/<file>
  ```

## Requirements

- **Node.js** – all current scripts are plain Node.js-based and have no external npm dependencies.
- **Bash** – the snippets below assume a POSIX shell (macOS / Linux / GitHub Actions runners).

## Versioning policy

A script version (`v1`, `v2`, …) is **frozen** once published. Bug-fix and backwards-compatible changes are made in place; any breaking change is shipped as a new `vN+1` folder.

---

# Available scripts

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
  local scriptUrl="https://raw.githubusercontent.com/wultra/wultra-infrastructure/refs/heads/mobile/mobile/utils/get-ios-simulator/v1/get-ios-sim.js"
  curl -fsSL "${scriptUrl}" | node - -p "${SCRIPT_FOLDER}/.." "${XCODE_PROJECT}" "${XCODE_SCHEME}"
}

echo "Resolving the best simulator for the ${XCODE_SCHEME}..."
DESTINATION=$(getSimulatorDestination)

echo "Simulator to use: ${DESTINATION}"
```

**Real-life example**

- [wultra/networking-apple – `scripts/test.sh`](https://github.com/wultra/networking-apple/blob/develop/scripts/test.sh)
