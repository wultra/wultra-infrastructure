
/**
 * prepare-release.js
 * 
 * This script prepares a new release of the sdk based on the definition file.
 * It supports both stable versions (e.g., 1.2.3) and SNAPSHOT versions (e.g., 2.0.0-SNAPSHOT).
 * It can also run in "verify" mode, which means it will read the version from the library definition file
 * and check if the release is prepared.
 * 
 * Verify mode can be triggered by not providing the version number - in that case the version from the library definition file is used.
 * Or you can specify the --verify option to run the script in verify mode.
 * 
 * --------------------------------------------------------------
 * 
 * Usage:
 *   node scripts/prepare-release.js -p <path> -v <version>
 *  -p <path>            Path to the project root (required).
 *  -v <version>         Set the desired version number (e.g., 1.4.2 or 2.0.0-SNAPSHOT) to prepare
 *                       If the version is not set, it will be read from the definition file and run in "verify" mode.
 *  -h, --help           Show this help message.
 *  --ignore-git-clean   Ignore the git clean state check.
 *  --verify             Run the script in verify mode.
 * 
 * --------------------------------------------------------------
 * 
 * The script expects the project to be in a clean git state, meaning there are no uncommitted changes.
 * 
 * This script does not commit or push any changes to the repository nor create any tags.
 * 
 * This script expects a definition file `.prepare-release.json` in the project root.
 * You can visit the example definition file in the mtoken-sdk-flutter repository to see what it should look like.
 * https://github.com/wultra/mtoken-sdk-flutter/
 * 
 * --------------------------------------------------------------
 * 
 * Example definition file:
 * {
 *   "library": {
 *     "type": "flutter" // or: "ios-oss", "android-oss", "npm", "yarn"
 *   },
 *   "files": [
 *     {
 *       "path": "pubspec.yaml",
 *       "type": "version_replace", // replace the version in the pubspec.yaml file
 *       "match": "version: %VERSION%"
 *     },
 *     {
 *       "path": "CHANGELOG.md",
 *       "type": "version_verify", // verify that the CHANGELOG.md file contains the version
 *       "match": "## %VERSION%"
 *     },
 *     {
 *       "path": "docs/Readme.md",
 *       "type": "versionstream_verify", // verify that the Readme.md file contains the version stream (e.g. 1.2.x)
 *       "match": "| `%VERSION_STREAM%`"
 *     },
 *  ],
 *  "scripts": [
 *    {
 *      "type": "bash", // only bash scripts are supported for now
 *      "description": "Update the version in all relevant files",
 *      "script": "cd example/ios && pod install && cd ../.."
 *    }
 *  ]
 */

const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')

let projectRoot = null
let givenVersion = null
let verifyGitClean = true
let forceVerifyMode = false

// Parse command line arguments
for (i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === '--help' || process.argv[i] === '-h') {   
        helpAndExit(0)
    } else if (process.argv[i] === '-p') {
        // Next argument should be the project path
        projectRoot = process.argv[i + 1]
    } else if (process.argv[i] === '-v') {
        // Next argument should be the desired version
        givenVersion = process.argv[i + 1]
    } else if (process.argv[i] === '--ignore-git-clean') {
        // Ignore the git clean state check
        verifyGitClean = false
    } else if (process.argv[i] === '--verify') {
        // Force the script to run in verify mode
        forceVerifyMode = true
    }
}

// Check if project path is provided or exit
if (projectRoot === null) {
    console.error('ERROR: You must specify the project path using -p option.')
    helpAndExit()
}

// Check if the script is run in a clean git state
if (verifyGitClean && !isGitClean(projectRoot)) {
    logError('ERROR: The git repository is not clean. Please commit or stash your changes before running this script.')
}

// Call the main function with the parsed arguments
main(projectRoot, givenVersion, forceVerifyMode)

// MAIN FUNCTION

function main(projectPath, desiredVersion, verifyMode) {

    // If the desired version is not provided, we will run in "verify" mode
    verifyMode = verifyMode || desiredVersion == null
    // full path to the project root
    const fullPath = path.resolve(projectPath)
    // we expect the definition file to be in the project root
    const definitionFilePath = path.join(fullPath, '.prepare-release.json')

    logHeader('Preparing release script started')
    logInfo(` - Using project path: ${fullPath}`)
    logInfo(` - Reading definition file: ${definitionFilePath}`)

    // read and parse the definition file
    const definition = JSON.parse(fs.readFileSync(definitionFilePath, 'utf8'))

    // Make sure the definition files contain some files to prepare
    if (definition.files == null || definition.files.length === 0) {
        logError('ERROR: The definition file does not contain any files to prepare.')
    }

    // If the version was not specified, read it from the definition file
    // according to the library type
    if (desiredVersion == null) {

        logHeader('No version specified, retrieving from definition file')
        let versionFile = null
        let matchRegex = null

        switch (definition.library.type) {
            case 'flutter':
                versionFile = 'pubspec.yaml'
                matchRegex = /^\s*version\s*:\s*([^\s#]+)/m
                break
            case 'npm':
                versionFile = 'package.json'
                matchRegex = /^\s*"version"\s*:\s*"([^\s#]+)"/m
                break
            case 'yarn':
                versionFile = 'package.json'
                matchRegex = /^\s*"version"\s*:\s*"([^\s#]+)"/m
                break
            case 'ios-oss':
                versionFile = definition.library.podspec
                matchRegex = /s\.version\s*=\s*'([^']+)'/m
                break
            case 'android-oss':
                versionFile = definition.library.versionFile || 'library/gradle.properties' 
                matchRegex = /^VERSION_NAME=([\d.]+(?:-[A-Za-z0-9._]+)?)$/m
                break
            default:
                logError(`ERROR: Unsupported library type: ${definition.library.type}.`)
        }
        logInfo(` - ${definition.library.type} library detected, reading version from ${versionFile}...`)
        try {
            const fileContents = fs.readFileSync(path.join(projectPath, versionFile), 'utf8')

            // Match "version: x.y.z+build" allowing for spaces
            const match = fileContents.match(matchRegex)

            if (match) {
                desiredVersion = match[1]
                logInfo(` - Parsed version: ${desiredVersion}`)
            } else {
                logError(` - No version found in ${versionFile}. Please ensure the file contains a valid version definition.`)
            }
        } catch (err) {
            logError(` - Error reading ${versionFile}: ${err.message}`)
        }
    }

    // verify that the version is in the correct format (major.minor.patch or major.minor.patch-SNAPSHOT)
    if (/^\d+\.\d+\.\d+(-SNAPSHOT)?$/.test(desiredVersion) === false) {
        logError(`ERROR: Invalid release version format: ${desiredVersion}. Expected format is "major.minor.patch" (e.g. "1.2.3") or "major.minor.patch-SNAPSHOT" (e.g. "2.0.0-SNAPSHOT").`)
    }

    // Create a masked version stream (e.g., 1.2.x from 1.2.3) for version verification
    const versionStream = maskPatch(desiredVersion)

    // If the script is not in the verify mode, modify the files according to the definition
    if (!verifyMode) {
        logHeader(`Preparing release for version: ${desiredVersion} (stream: ${versionStream})\n`)
        prepareRelease(definition, fullPath, desiredVersion, versionStream)
    }

    logHeader('Verifying that all required files are present and contain the expected content')
    verifyReleasePrepared(definition, fullPath, desiredVersion, versionStream)

    if (definition.scripts && definition.scripts.length > 0) {
        let hasErrors = false
        logHeader('Run scripts from the definition file')
        for (const script of definition.scripts) {
            switch (script.type) {
                case 'bash':
                    logInfo(` - Running bash script: ${script.script}`)
                    try {
                        execSync(`cd ${fullPath} && ${script.script}`)
                    } catch (error) {
                        logError(`  - ERROR: Script failed with error: ${error.message}`, false)
                    }
                    break
                default:
                    logError(`  - ERROR: Unsupported script type: ${script.type}`, true)
            }
        }
        if (hasErrors) {
            logError(' - Some scripts failed to execute. Please check the errors above.')
        } else {
            logSuccess(' - All scripts executed successfully.')
        }
    }

    // If we're in a "verify mode" and the git is not clean, it's an error
    if (verifyMode && verifyGitClean && !isGitClean(projectRoot)) {
        logError('ERROR: The git repository is not clean. Files were created during the verification - that is an error.')
    }
}

// HELPER FUNCTIONS

function prepareRelease(definition, projectFullPath, version, versionStream) {
    let hasErrors = false
    for (const file of definition.files) {
        logInfo(` - Preparing file: ${file.path}`)
        const filePath = path.join(projectFullPath, file.path)
        if (!fs.existsSync(filePath)) {
            logError(`  - ERROR: The file does not exist!`, false)
            hasErrors = true
            continue
        }
        if (file.type === 'version_replace') {
            const semverPattern = "(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?"
            const template = file.match.replace("%VERSION%", semverPattern)
            const finalRegex = new RegExp(template, "g")
            const fileContent = fs.readFileSync(filePath, 'utf8')
            const newContent = fileContent.replace(finalRegex, resolveMatch(file.match, version, versionStream))
            fs.writeFileSync(filePath, newContent, 'utf8')
            logSuccess(`  - File updated successfully!`)

        } else if (file.type === 'version_verify' || file.type === 'versionstream_verify') {
            logInfo(`  - This file needs to be updated manually`)
        } else {
            logError(`  - ERROR: Unsupported file type: ${file.type}`, false)
            hasErrors = true
        }
    }
    if (hasErrors) {
        logError(' - Release is not prepared. See the errors above.')
    }
}

function verifyReleasePrepared(definition, projectFullPath, version, versionStream) {
    let hasErrors = false
    for (const file of definition.files) {
        logInfo(` - Verifying required file: ${file.path}`)
        const filePath = path.join(projectFullPath, file.path)
        if (!fs.existsSync(filePath)) {
            logError(`  - ERROR: The file does not exist!`, false)
            hasErrors = true
            continue
        }
        const fileContent = fs.readFileSync(filePath, 'utf8')
        const match = resolveMatch(file.match, version, versionStream)
        if (fileContent.indexOf(match) === -1) {
            logError(`  - ERROR: does not contain required match: ${match}`, false)
            if (file.type === 'version_verify' || file.type === 'versionstream_verify') {
                logWarning('  - This file requires manual update, please update it to match the desired version.')
            }
            hasErrors = true
            continue
        }
        logSuccess(`  - OK: contains: \"${match}\"`)
    }
    logHeader('Release preparation verification completed:')
    if (hasErrors) {
        logError(' - Release is not prepared, some required files are missing or do not contain the required content.')
    } else {
        logSuccess(' - Release is prepared successfully! All required files are present and contain the expected content.')
    }
}

function resolveMatch(match, version, versionStream) {
    return match.replace("%VERSION%", version).replace("%VERSION_STREAM%", versionStream)
}

function maskPatch(version) {
  // Match X.Y.Z or X.Y.Z-SNAPSHOT where X,Y,Z are numbers
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(-SNAPSHOT)?$/)
  if (!match) {
    throw new Error(`Invalid version format: ${version}`)
  }
  const [, major, minor] = match
  return `${major}.${minor}.x`
}

function isGitClean() {
  try {
    const output = execSync(`cd ${projectRoot} && git status --porcelain`, { encoding: 'utf8' })
    return output.trim().length === 0
  } catch (err) {
    console.error('Error checking git status:', err.message)
    return false
  }
}

function helpAndExit() {
    console.log(`
------ prepare-release.js HELP ------

This script prepares a new release of the sdk based on the definition file.

If a version is not provided, the script will run in "verify" mode, which means it will read the version from the definition file and check if the release is prepared.

Options:
  -v                        Set the desired version number (e.g., 1.4.2 or 2.0.0-SNAPSHOT).
                            If the version is not set, it will be read from the definition file, 
                            and the script will turn into a "verify" mode.
  -p <path>                 Path to the project root (required).
  -h, --help                Show this help message.

Example usage: prepare-release -p /path/to/project -v 1.4.2
               prepare-release -p /path/to/project -v 2.0.0-SNAPSHOT
------------------------------------
`)
    process.exit(1)
}

function color(text, color) {
    const colors = {
        red: '\x1b[31m',
        green: '\x1b[32m',
        yellow: '\x1b[33m',
        blue: '\x1b[34m',
        magenta: '\x1b[35m',
        bold: '\x1b[1m',
    }
    return `${colors[color] || ''}${text}\x1b[0m`
}

function log(text, clr) {
    console.log(color(text, clr))
}

function logError(message, exit = true) {
    log(message, 'red')
    if (exit) {
        process.exit(1)
    }
}

function logSuccess(message) {
    log(message, 'green')
}

function logInfo(message) {
    console.log(message)
}

function logHeader(message) {
    log(`\n${color(color(message, 'bold'), 'magenta')}`)
}

function logWarning(message) {
    log(message, 'yellow')
}