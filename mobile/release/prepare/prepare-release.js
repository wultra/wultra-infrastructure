/**
 * prepare-release.js
 *
 * Resolves `scriptVersion` from `.prepare-release.json` and executes the matching
 * prepare-release implementation from this repository.
 *
 * `scriptVersion` must be a positive integer. When omitted, version 1 is used
 * for backwards compatibility. Implementations live under
 * `v<version>/prepare-release.js`, so future versions require no dispatcher changes.
 *
 * Usage:
 *   curl -fsSL <dispatcher URL> | node - -p <project-path> [prepare-release options]
 *   node prepare-release.js --dispatch-local -p <project-path> [prepare-release options]
 */

const fs = require('fs')
const https = require('https')
const path = require('path')
const { execFileSync } = require('child_process')

const RAW_REPOSITORY_URL =
    'https://raw.githubusercontent.com/wultra/wultra-infrastructure/refs/heads/mobile/mobile/release/prepare'
const DEFAULT_SCRIPT_VERSION = 1
const MAX_REDIRECTS = 5

class DispatcherError extends Error {}

/**
 * Reads only the arguments needed before handing control to a versioned script.
 */
class DispatcherOptions {
    constructor(projectRoot, showHelp, dispatchLocal) {
        this.projectRoot = projectRoot
        this.showHelp = showHelp
        this.dispatchLocal = dispatchLocal
    }

    static parse(argv) {
        let projectRoot = null
        let showHelp = false
        let dispatchLocal = false

        for (let index = 2; index < argv.length; index++) {
            const argument = argv[index]
            if (argument === '-h' || argument === '--help') {
                showHelp = true
            } else if (argument === '--dispatch-local') {
                dispatchLocal = true
            } else if (argument === '-p') {
                projectRoot = argv[++index]
                if (projectRoot == null || projectRoot.startsWith('-')) {
                    throw new DispatcherError('Option -p requires a project path.')
                }
            }
        }

        return new DispatcherOptions(projectRoot, showHelp, dispatchLocal)
    }
}

/**
 * Performs the lightweight definition preprocessing needed for dispatch.
 */
class ScriptVersionResolver {
    constructor(projectRoot) {
        this.definitionPath = path.join(path.resolve(projectRoot), '.prepare-release.json')
    }

    resolve() {
        let definition
        try {
            definition = JSON.parse(fs.readFileSync(this.definitionPath, 'utf8'))
        } catch (error) {
            throw new DispatcherError(
                `Unable to read ${this.definitionPath}: ${error.message}`
            )
        }

        const scriptVersion = definition.scriptVersion ?? DEFAULT_SCRIPT_VERSION
        if (!Number.isInteger(scriptVersion) || scriptVersion < 1) {
            throw new DispatcherError(
                'scriptVersion must be a positive integer such as 1, 2, or 3.'
            )
        }
        return scriptVersion
    }
}

/**
 * Maps numeric versions to their stable raw GitHub implementation URLs.
 */
class ImplementationLocator {
    static urlFor(scriptVersion) {
        return `${RAW_REPOSITORY_URL}/v${scriptVersion}/prepare-release.js`
    }

    static localPathFor(scriptVersion) {
        return path.join(__dirname, `v${scriptVersion}`, 'prepare-release.js')
    }
}

/**
 * Downloads the selected implementation without requiring external packages.
 */
class RemoteScriptLoader {
    load(url, redirectsRemaining = MAX_REDIRECTS) {
        return new Promise((resolve, reject) => {
            https.get(url, response => {
                if (
                    response.statusCode >= 300 &&
                    response.statusCode < 400 &&
                    response.headers.location
                ) {
                    response.resume()
                    if (redirectsRemaining === 0) {
                        reject(new DispatcherError(`Too many redirects while downloading ${url}.`))
                        return
                    }
                    const redirectUrl = new URL(response.headers.location, url).toString()
                    resolve(this.load(redirectUrl, redirectsRemaining - 1))
                    return
                }

                if (response.statusCode !== 200) {
                    response.resume()
                    reject(
                        new DispatcherError(
                            `Unable to download ${url}: HTTP ${response.statusCode}.`
                        )
                    )
                    return
                }

                response.setEncoding('utf8')
                let contents = ''
                response.on('data', chunk => {
                    contents += chunk
                })
                response.on('end', () => resolve(contents))
            }).on('error', error => {
                reject(new DispatcherError(`Unable to download ${url}: ${error.message}`))
            })
        })
    }
}

/**
 * Loads a versioned implementation located next to the dispatcher.
 */
class LocalScriptLoader {
    load(filePath) {
        try {
            return fs.readFileSync(filePath, 'utf8')
        } catch (error) {
            throw new DispatcherError(`Unable to read ${filePath}: ${error.message}`)
        }
    }
}

/**
 * Executes the downloaded implementation with the original command-line arguments.
 */
class VersionedScriptRunner {
    run(scriptContents, forwardedArguments) {
        try {
            execFileSync(process.execPath, ['-', ...forwardedArguments], {
                input: scriptContents,
                stdio: ['pipe', 'inherit', 'inherit']
            })
        } catch (error) {
            if (Number.isInteger(error.status)) {
                process.exitCode = error.status
                return
            }
            throw new DispatcherError(`Unable to execute the selected script: ${error.message}`)
        }
    }
}

class PrepareReleaseDispatcher {
    constructor(argv) {
        this.argv = argv
    }

    async run() {
        const options = DispatcherOptions.parse(this.argv)
        if (options.showHelp) {
            this.printHelp()
            return
        }
        if (options.projectRoot == null) {
            throw new DispatcherError('You must specify the project path using -p.')
        }

        const scriptVersion = new ScriptVersionResolver(options.projectRoot).resolve()
        console.log(`Resolved prepare-release script version: ${scriptVersion}`)
        const scriptContents = await this.loadImplementation(scriptVersion, options.dispatchLocal)
        const forwardedArguments = this.argv
            .slice(2)
            .filter(argument => argument !== '--dispatch-local')
        new VersionedScriptRunner().run(scriptContents, forwardedArguments)
    }

    async loadImplementation(scriptVersion, dispatchLocal) {
        if (dispatchLocal) {
            const implementationPath = ImplementationLocator.localPathFor(scriptVersion)
            console.log(`Using local prepare-release implementation: ${implementationPath}`)
            return new LocalScriptLoader().load(implementationPath)
        }

        const implementationUrl = ImplementationLocator.urlFor(scriptVersion)
        console.log(`Using remote prepare-release implementation: ${implementationUrl}`)
        return new RemoteScriptLoader().load(implementationUrl)
    }

    printHelp() {
        console.log(`
------ prepare-release.js DISPATCHER HELP ------

The dispatcher reads scriptVersion from <project>/.prepare-release.json and runs
the matching prepare-release implementation. A missing scriptVersion defaults to 1.

Required dispatcher option:
  -p <path>    Path to the project root.

Dispatcher options:
  --dispatch-local    Load vN/prepare-release.js next to this dispatcher instead
                      of downloading it from raw.githubusercontent.com.

All other options are forwarded unchanged to the selected implementation.
------------------------------------------------
`)
    }
}

new PrepareReleaseDispatcher(process.argv).run().catch(error => {
    console.error(`ERROR: ${error.message}`)
    process.exitCode = 1
})
