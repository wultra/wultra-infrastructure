/**
 * prepare-release.js
 *
 * Version 2 prepares or verifies a mobile SDK release using `.prepare-release.json`.
 *
 * Usage:
 *   node prepare-release.js -p <path> [-v <version>] [options]
 *
 * Options:
 *   -p <path>            Project root containing `.prepare-release.json`.
 *   -v <version>         Version to prepare, for example 1.4.2, 2.0.0-SNAPSHOT, or 1.2.3-beta.1.
 *                        Without this option, the current version is read and only verified.
 *   --prepare-dev        Verify the current release, then prepare files for development.
 *   --verify             Verify without preparing files.
 *   --ignore-git-clean   Skip the initial and final Git cleanliness checks.
 *   --enforce-git-clean  Fail instead of asking when the repository is initially dirty.
 *   -h, --help           Show help.
 *
 * When an explicit version changes files, the script can commit all uncommitted changes,
 * only files changed during this run, or nothing. A successful commit can then be pushed,
 * creating the branch in origin if it does not exist.
 * Git uses the user's existing identity and credentials.
 *
 * Example `.prepare-release.json` definition:
 * {
 *   "scriptVersion": 2,
 *   "devVersion": "0.0.1-dev",
 *   "library": {
 *     "type": "flutter" // or: "ios-oss", "android-oss", "npm", "yarn"
 *   },
 *   "files": [
 *     {
 *       "path": "pubspec.yaml",
 *       "type": "version_replace", // replace the version in the file
 *       "match": "version: %VERSION%",
 *       "devChange": true // use devVersion when --prepare-dev is invoked
 *     },
 *     {
 *       "path": "CHANGELOG.md",
 *       "type": "tba_replace", // replace TBA or tba in the match with the version
 *       "match": "## TBA"
 *     },
 *     {
 *       "path": "CHANGELOG.md",
 *       "type": "version_verify", // verify that the file contains the version
 *       "match": "## %VERSION%",
 *       "skipForSnapshot": true // optionally skip versions ending with -SNAPSHOT
 *     },
 *     {
 *       "paths": ["docs/Readme.md", "README.md"],
 *       "type": "versionstream_verify", // verify the version stream, for example 1.2.x
 *       "match": "| \`%VERSION_STREAM%\`"
 *     },
 *     {
 *       "path": "CHANGELOG.md",
 *       "type": "verify_not_containing", // verify that the file does not contain the match
 *       "match": "## TBA",
 *       "devChangelog": true // insert this heading above the first version for development
 *     }
 *   ],
 *   "scripts": [
 *     {
 *       "type": "bash",
 *       "description": "Update generated files",
 *       "script": "cd example/ios && pod install && cd ../.."
 *     }
 *   ]
 * }
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync, execSync } = require('child_process')

// Versions may have an arbitrary safe suffix; only the exact -SNAPSHOT suffix has snapshot semantics.
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z._-]*)?$/
const VERSION_REPLACE_PATTERN =
    '(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)' +
    '(?:-[0-9A-Za-z][0-9A-Za-z._-]*)?'

class ReportedError extends Error {
    constructor(message) {
        super(message)
        this.name = 'ReportedError'
    }
}

/**
 * Handles all terminal input and formatted output in one place.
 */
class Terminal {
    constructor() {
        this.colors = {
            red: '\x1b[31m',
            green: '\x1b[32m',
            yellow: '\x1b[33m',
            blue: '\x1b[34m',
            magenta: '\x1b[35m',
            bold: '\x1b[1m',
        }
    }

    readInput(question) {
        process.stdout.write(question)
        let answer = ''
        const buffer = Buffer.alloc(1)
        let terminal

        try {
            terminal = fs.openSync('/dev/tty', 'r')
            while (true) {
                const bytesRead = fs.readSync(terminal, buffer, 0, 1, null)
                if (bytesRead === 0 || buffer[0] === 10 || buffer[0] === 13) {
                    break
                }
                answer += buffer.toString()
            }
        } catch (error) {
            this.fail(`ERROR: Unable to read input from the terminal: ${error.message}`)
        } finally {
            if (terminal != null) {
                fs.closeSync(terminal)
            }
        }

        return answer.trim()
    }

    confirm(question) {
        return this.readInput(question).toLowerCase() === 'y'
    }

    selectCommitOption() {
        while (true) {
            this.info('\nCommit prepared release:')
            this.info('  1. Commit all uncommitted changes')
            this.info('  2. Commit only changes made by this script')
            this.info('  3. Do not commit')
            const answer = this.readInput('Select an option: ')
            if (['1', '2', '3'].includes(answer)) {
                return answer
            }
            this.warning('Invalid option. Enter 1, 2, or 3.')
        }
    }

    color(text, color) {
        return `${this.colors[color] || ''}${text}\x1b[0m`
    }

    log(text, color) {
        console.log(this.color(text, color))
    }

    info(message) {
        console.log(message)
    }

    success(message) {
        this.log(message, 'green')
    }

    warning(message) {
        this.log(message, 'yellow')
    }

    error(message) {
        this.log(message, 'red')
    }

    header(message) {
        this.log(`\n${this.color(this.color(message, 'bold'), 'magenta')}`)
    }

    fail(message) {
        this.error(message)
        throw new ReportedError(message)
    }

    printHelp() {
        console.log(`
------ prepare-release.js HELP ------

This script prepares a new SDK release based on a .prepare-release.json definition file.

Options:
  -v <version>                Set the desired version, for example 1.4.2,
                              2.0.0-SNAPSHOT, or 1.2.3-beta.1.
                              Without a version, the script runs in verify mode.
  -p <path>                   Path to the project root (required).
  -h, --help                  Show this help message.
  --ignore-git-clean          Ignore the Git clean state check.
  --enforce-git-clean         Exit when the Git repository is not clean.
  --verify                    Run in verify mode.
  --prepare-dev               Verify the current release, then prepare development files
                              using devVersion from .prepare-release.json.

When -v is provided and files change, the script offers to commit all uncommitted
changes, only files changed during this run, or nothing. Committed changes use
"Prepared release <version>", after which the script offers to push or create the branch in origin.

Example usage: prepare-release -p /path/to/project -v 1.4.2
               prepare-release -p /path/to/project -v 2.0.0-SNAPSHOT
               prepare-release -p /path/to/project -v 1.2.3-beta.1
               prepare-release -p /path/to/project --prepare-dev
------------------------------------
`)
    }
}

/**
 * Parses command-line arguments without leaking option state into globals.
 */
class CliOptions {
    constructor(projectRoot, version, gitCleanMode, verifyMode, prepareDevMode, showHelp) {
        this.projectRoot = projectRoot
        this.version = version
        this.gitCleanMode = gitCleanMode
        this.verifyMode = verifyMode
        this.prepareDevMode = prepareDevMode
        this.showHelp = showHelp
    }

    static parse(argv, terminal) {
        let projectRoot = null
        let version = null
        let gitCleanMode = 'prompt'
        let verifyMode = false
        let prepareDevMode = false
        let showHelp = false

        for (let index = 2; index < argv.length; index++) {
            const argument = argv[index]
            if (argument === '--help' || argument === '-h') {
                showHelp = true
            } else if (argument === '-p') {
                projectRoot = CliOptions.readValue(argv, ++index, '-p', terminal)
            } else if (argument === '-v') {
                version = CliOptions.readValue(argv, ++index, '-v', terminal)
            } else if (argument === '--ignore-git-clean') {
                gitCleanMode = 'ignore'
            } else if (argument === '--enforce-git-clean') {
                gitCleanMode = 'enforce'
            } else if (argument === '--verify') {
                verifyMode = true
            } else if (argument === '--prepare-dev') {
                prepareDevMode = true
            }
        }

        return new CliOptions(
            projectRoot,
            version,
            gitCleanMode,
            verifyMode,
            prepareDevMode,
            showHelp
        )
    }

    static readValue(argv, index, option, terminal) {
        const value = argv[index]
        if (value == null || value.startsWith('-')) {
            terminal.fail(`ERROR: Option ${option} requires a value.`)
        }
        return value
    }
}

/**
 * Encapsulates version validation, snapshot classification, and derived release values.
 */
class ReleaseVersion {
    constructor(value, terminal) {
        if (!VERSION_PATTERN.test(value)) {
            terminal.fail(
                `ERROR: Invalid release version format: ${value}. Expected "major.minor.patch", ` +
                '"major.minor.patch-SNAPSHOT", or "major.minor.patch-suffix".'
            )
        }
        this.value = value
    }

    get stream() {
        const [, major, minor] = this.value.match(/^(\d+)\.(\d+)\./)
        return `${major}.${minor}.x`
    }

    get isSnapshot() {
        return /^\d+\.\d+\.\d+-SNAPSHOT$/.test(this.value)
    }
}

/**
 * Loads and normalizes the release definition.
 */
class ReleaseDefinition {
    constructor(contents, terminal) {
        this.library = contents.library
        this.files = contents.files
        this.scripts = contents.scripts || []
        this.devVersion = contents.devVersion
        this.terminal = terminal

        if (!Array.isArray(this.files) || this.files.length === 0) {
            terminal.fail('ERROR: The definition file does not contain any files to prepare.')
        }
    }

    static load(projectRoot, terminal) {
        const definitionPath = path.join(projectRoot, '.prepare-release.json')
        terminal.info(` - Reading definition file: ${definitionPath}`)

        try {
            return new ReleaseDefinition(JSON.parse(fs.readFileSync(definitionPath, 'utf8')), terminal)
        } catch (error) {
            if (error instanceof ReportedError) {
                throw error
            }
            terminal.fail(`ERROR: Unable to read the definition file: ${error.message}`)
        }
    }

    expandedFiles() {
        return this.files.flatMap(file => this.filePaths(file).map(filePath => ({
            ...file,
            path: filePath
        })))
    }

    filePaths(file) {
        if (file.path != null && file.paths != null) {
            this.terminal.fail('ERROR: A file definition must specify either path or paths, not both.')
        }

        const filePaths = file.paths != null ? file.paths : [file.path]
        if (
            !Array.isArray(filePaths) ||
            filePaths.length === 0 ||
            filePaths.some(filePath => typeof filePath !== 'string' || filePath.length === 0)
        ) {
            this.terminal.fail('ERROR: A file definition must specify a non-empty path or paths array.')
        }
        return filePaths
    }
}

/**
 * Resolves the current version from the library-specific source file.
 */
class VersionResolver {
    constructor(projectRoot, terminal) {
        this.projectRoot = projectRoot
        this.terminal = terminal
    }

    resolve(definition, header = 'No version specified, retrieving from definition file') {
        this.terminal.header(header)
        const source = this.sourceFor(definition.library)
        this.terminal.info(
            ` - ${definition.library.type} library detected, reading version from ${source.filePath}...`
        )

        try {
            const contents = fs.readFileSync(path.join(this.projectRoot, source.filePath), 'utf8')
            const match = contents.match(source.pattern)
            if (!match) {
                this.terminal.fail(
                    ` - No version found in ${source.filePath}. ` +
                    'Please ensure the file contains a valid version definition.'
                )
            }
            this.terminal.info(` - Parsed version: ${match[1]}`)
            return match[1]
        } catch (error) {
            if (error instanceof ReportedError) {
                throw error
            }
            this.terminal.fail(` - Error reading ${source.filePath}: ${error.message}`)
        }
    }

    sourceFor(library) {
        switch (library.type) {
            case 'flutter':
                return { filePath: 'pubspec.yaml', pattern: /^\s*version\s*:\s*([^\s#]+)/m }
            case 'npm':
            case 'yarn':
                return { filePath: 'package.json', pattern: /^\s*"version"\s*:\s*"([^\s#]+)"/m }
            case 'ios-oss':
                return { filePath: library.podspec, pattern: /s\.version\s*=\s*'([^']+)'/m }
            case 'android-oss':
                return {
                    filePath: library.versionFile || 'library/gradle.properties',
                    pattern: /^VERSION_NAME=([\d.]+(?:-[A-Za-z0-9._-]+)?)$/m
                }
            default:
                this.terminal.fail(`ERROR: Unsupported library type: ${library.type}.`)
        }
    }
}

/**
 * Base class for one normalized file entry from the release definition.
 */
class ReleaseFileOperation {
    constructor(file, projectRoot, version, terminal) {
        this.file = file
        this.projectRoot = projectRoot
        this.version = version
        this.terminal = terminal
    }

    get filePath() {
        return path.join(this.projectRoot, this.file.path)
    }

    get shouldSkip() {
        return this.file.skipForSnapshot && this.version.isSnapshot
    }

    exists() {
        return fs.existsSync(this.filePath)
    }

    prepare() {
        this.terminal.info('  - This file needs to be updated manually')
    }

    verify() {
        const match = this.expectedMatch()
        const fileContents = fs.readFileSync(this.filePath, 'utf8')
        if (!fileContents.includes(match)) {
            this.terminal.error(`  - ERROR: does not contain required match: ${match}`)
            if (this.requiresManualUpdate) {
                this.terminal.warning(
                    '  - This file requires manual update, please update it to match the desired version.'
                )
            }
            return false
        }
        this.terminal.success(`  - OK: contains: "${match}"`)
        return true
    }

    get requiresManualUpdate() {
        return ['version_verify', 'versionstream_verify', 'tba_replace'].includes(this.file.type)
    }

    expectedMatch() {
        return this.file.match
            .replace('%VERSION%', this.version.value)
            .replace('%VERSION_STREAM%', this.version.stream)
    }
}

class VersionReplaceOperation extends ReleaseFileOperation {
    prepare() {
        const template = this.file.match.replace('%VERSION%', VERSION_REPLACE_PATTERN)
        const finalRegex = new RegExp(template, 'g')
        const fileContents = fs.readFileSync(this.filePath, 'utf8')
        fs.writeFileSync(this.filePath, fileContents.replace(finalRegex, this.expectedMatch()), 'utf8')
        this.terminal.success('  - File updated successfully!')
    }
}

class TbaReplaceOperation extends ReleaseFileOperation {
    prepare() {
        const tbaRegex = new RegExp(this.file.match.replace(/tba/i, '(?:TBA|tba)'), 'g')
        const fileContents = fs.readFileSync(this.filePath, 'utf8')

        if (tbaRegex.test(fileContents)) {
            fs.writeFileSync(this.filePath, fileContents.replace(tbaRegex, this.expectedMatch()), 'utf8')
            this.terminal.success('  - File updated successfully!')
        } else {
            this.terminal.info('  - TBA not found, verifying that the version is already present')
        }
    }

    expectedMatch() {
        if (!/tba/i.test(this.file.match)) {
            this.terminal.fail(
                `ERROR: Invalid tba_replace match: ${this.file.match}. The match must contain TBA or tba.`
            )
        }
        return this.file.match.replace(/tba/i, this.version.value)
    }
}

class VerifyNotContainingOperation extends ReleaseFileOperation {
    verify() {
        const match = this.expectedMatch()
        const fileContents = fs.readFileSync(this.filePath, 'utf8')
        if (fileContents.includes(match)) {
            this.terminal.error(`  - ERROR: contains forbidden match: ${match}`)
            this.terminal.warning('  - This file requires manual update, please remove the forbidden content.')
            return false
        }
        this.terminal.success(`  - OK: does not contain: "${match}"`)
        return true
    }
}

class ManualVerificationOperation extends ReleaseFileOperation {}

/**
 * Creates the operation responsible for each supported definition type.
 */
class ReleaseFileOperationFactory {
    constructor(projectRoot, version, terminal) {
        this.projectRoot = projectRoot
        this.version = version
        this.terminal = terminal
    }

    create(file) {
        const constructorArguments = [file, this.projectRoot, this.version, this.terminal]
        switch (file.type) {
            case 'version_replace':
                return new VersionReplaceOperation(...constructorArguments)
            case 'tba_replace':
                return new TbaReplaceOperation(...constructorArguments)
            case 'version_verify':
            case 'versionstream_verify':
                return new ManualVerificationOperation(...constructorArguments)
            case 'verify_not_containing':
                return new VerifyNotContainingOperation(...constructorArguments)
            default:
                this.terminal.fail(`  - ERROR: Unsupported file type: ${file.type}`)
        }
    }
}

/**
 * Applies all automatic release-file changes.
 */
class ReleasePreparer {
    constructor(operations, terminal) {
        this.operations = operations
        this.terminal = terminal
    }

    run() {
        let hasErrors = false
        for (const operation of this.operations) {
            if (operation.shouldSkip) {
                this.terminal.info(` - Skipping file (SNAPSHOT): ${operation.file.path}`)
                continue
            }

            this.terminal.info(` - Preparing file: ${operation.file.path}`)
            if (!operation.exists()) {
                this.terminal.error('  - ERROR: The file does not exist!')
                hasErrors = true
                continue
            }
            operation.prepare()
        }

        if (hasErrors) {
            this.terminal.fail(' - Release is not prepared. See the errors above.')
        }
    }
}

/**
 * Restores the development heading above the first released changelog version.
 */
class DevelopmentChangelogPreparer {
    constructor(files, projectRoot, terminal) {
        this.files = files
        this.projectRoot = projectRoot
        this.terminal = terminal
    }

    run() {
        let hasErrors = false
        for (const file of this.files) {
            this.terminal.info(` - Preparing development changelog: ${file.path}`)
            const filePath = path.join(this.projectRoot, file.path)
            if (!fs.existsSync(filePath)) {
                this.terminal.error('  - ERROR: The file does not exist!')
                hasErrors = true
                continue
            }
            if (typeof file.match !== 'string' || !/tba/i.test(file.match)) {
                this.terminal.error(
                    '  - ERROR: A changelog match must contain TBA, for example "## TBA".'
                )
                hasErrors = true
                continue
            }

            const fileContents = fs.readFileSync(filePath, 'utf8')
            if (fileContents.includes(file.match)) {
                this.terminal.info('  - Development changelog heading is already present')
                continue
            }

            const versionMatch = this.versionMatchFor(file.match).exec(fileContents)
            if (!versionMatch) {
                this.terminal.error(
                    `  - ERROR: No released version matching "${file.match}" was found.`
                )
                hasErrors = true
                continue
            }

            const newline = fileContents.includes('\r\n') ? '\r\n' : '\n'
            const insertion = `${file.match}${newline}${newline}`
            const newContents =
                fileContents.slice(0, versionMatch.index) +
                insertion +
                fileContents.slice(versionMatch.index)
            fs.writeFileSync(filePath, newContents, 'utf8')
            this.terminal.success('  - Development changelog heading added successfully!')
        }

        if (hasErrors) {
            this.terminal.fail(' - Development changelog preparation failed. See the errors above.')
        }
    }

    versionMatchFor(match) {
        const tbaMatch = /tba/i.exec(match)
        const prefix = this.escapeRegex(match.slice(0, tbaMatch.index))
        const suffix = this.escapeRegex(match.slice(tbaMatch.index + tbaMatch[0].length))
        return new RegExp(`${prefix}${VERSION_REPLACE_PATTERN}${suffix}`)
    }

    escapeRegex(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
}

/**
 * Verifies all release-file requirements after preparation.
 */
class ReleaseVerifier {
    constructor(operations, terminal) {
        this.operations = operations
        this.terminal = terminal
    }

    run() {
        let hasErrors = false
        for (const operation of this.operations) {
            if (operation.shouldSkip) {
                this.terminal.info(` - Skipping verification (SNAPSHOT): ${operation.file.path}`)
                continue
            }

            this.terminal.info(` - Verifying required file: ${operation.file.path}`)
            if (!operation.exists()) {
                this.terminal.error('  - ERROR: The file does not exist!')
                hasErrors = true
                continue
            }
            if (!operation.verify()) {
                hasErrors = true
            }
        }

        this.terminal.header('Release preparation verification completed:')
        if (hasErrors) {
            this.terminal.fail(
                ' - Release is not prepared, some required files are missing or do not contain the required content.'
            )
        }
        this.terminal.success(
            ' - Release is prepared successfully! All required files are present and contain the expected content.'
        )
    }
}

/**
 * Executes optional definition scripts after file verification.
 */
class DefinitionScriptRunner {
    constructor(projectRoot, terminal) {
        this.projectRoot = projectRoot
        this.terminal = terminal
    }

    run(scripts) {
        if (scripts.length === 0) {
            return
        }

        let hasErrors = false
        this.terminal.header('Run scripts from the definition file')
        for (const script of scripts) {
            if (script.type !== 'bash') {
                this.terminal.fail(`  - ERROR: Unsupported script type: ${script.type}`)
            }

            this.terminal.info(` - Running bash script: ${script.script}`)
            try {
                execSync(script.script, { cwd: this.projectRoot })
            } catch (error) {
                this.terminal.error(`  - ERROR: Script failed with error: ${error.message}`)
                hasErrors = true
            }
        }

        if (hasErrors) {
            this.terminal.fail(' - Some scripts failed to execute. Please check the errors above.')
        }
        this.terminal.success(' - All scripts executed successfully.')
    }
}

/**
 * Owns Git inspection and mutations while preserving the user's configuration.
 */
class GitRepository {
    constructor(repositoryPath, terminal) {
        this.repositoryPath = repositoryPath
        this.terminal = terminal
    }

    isClean() {
        try {
            return this.git(['status', '--porcelain'], { encoding: 'utf8' }).trim().length === 0
        } catch (error) {
            this.terminal.fail(`ERROR: Unable to check Git status: ${error.message}`)
        }
    }

    captureChanges() {
        return new Map(this.changedFiles().map(filePath => [
            filePath,
            this.fileFingerprint(filePath)
        ]))
    }

    filesChangedSince(initialChanges) {
        return this.changedFiles().filter(filePath => {
            if (!initialChanges.has(filePath)) {
                return true
            }
            return initialChanges.get(filePath) !== this.fileFingerprint(filePath)
        })
    }

    changedFiles() {
        try {
            const output = this.git(
                ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
                { encoding: 'utf8' }
            )
            const entries = output.split('\0')
            const filePaths = new Set()

            for (let index = 0; index < entries.length; index++) {
                const entry = entries[index]
                if (entry.length < 4) {
                    continue
                }

                const status = entry.slice(0, 2)
                filePaths.add(entry.slice(3))

                // NUL-delimited rename/copy records contain the original path as the next entry.
                if (/[RC]/.test(status) && entries[index + 1]) {
                    filePaths.add(entries[++index])
                }
            }
            return [...filePaths]
        } catch (error) {
            this.terminal.fail(`ERROR: Unable to determine changed files: ${error.message}`)
        }
    }

    fileFingerprint(filePath) {
        const absolutePath = path.join(this.repositoryPath, filePath)
        if (!fs.existsSync(absolutePath)) {
            return null
        }

        const stats = fs.lstatSync(absolutePath)
        if (stats.isSymbolicLink()) {
            return `symlink:${fs.readlinkSync(absolutePath)}`
        }
        if (!stats.isFile()) {
            return `${stats.mode}:${stats.size}:${stats.mtimeMs}`
        }
        return crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex')
    }

    commitAll(version) {
        this.git(['add', '-A'], { stdio: 'inherit' })
        this.git(['commit', '-m', `Prepared release ${version}`], { stdio: 'inherit' })
    }

    commitOnly(version, filePaths) {
        this.git(['add', '-A', '--', ...filePaths], { stdio: 'inherit' })
        this.git(
            ['commit', '--only', '-m', `Prepared release ${version}`, '--', ...filePaths],
            { stdio: 'inherit' }
        )
    }

    push() {
        const branch = this.git(['branch', '--show-current'], { encoding: 'utf8' }).trim()
        if (branch.length === 0) {
            this.terminal.fail('ERROR: Unable to push from a detached HEAD.')
        }
        this.git(['push', '--set-upstream', 'origin', branch], { stdio: 'inherit' })
    }

    git(argumentsList, options = {}) {
        return execFileSync('git', argumentsList, {
            cwd: this.repositoryPath,
            ...options
        })
    }
}

/**
 * Offers the optional commit and push flow after a successful preparation.
 */
class ReleaseCommitWorkflow {
    constructor(gitRepository, terminal) {
        this.gitRepository = gitRepository
        this.terminal = terminal
    }

    run(version, initialChanges) {
        const changedFiles = this.gitRepository.filesChangedSince(initialChanges)
        if (changedFiles.length === 0) {
            return
        }

        const commitOption = this.terminal.selectCommitOption()
        if (commitOption === '3') {
            return
        }

        try {
            if (commitOption === '1') {
                this.gitRepository.commitAll(version)
            } else {
                this.gitRepository.commitOnly(version, changedFiles)
            }
        } catch (error) {
            this.terminal.fail(`ERROR: Unable to commit prepared release: ${error.message}`)
        }

        if (!this.terminal.confirm('Push the changes / create branch in origin if not created? (y/n): ')) {
            return
        }

        try {
            this.gitRepository.push()
        } catch (error) {
            this.terminal.fail(`ERROR: Unable to push prepared release: ${error.message}`)
        }
    }
}

/**
 * Coordinates the complete release preparation lifecycle.
 */
class PrepareReleaseApplication {
    constructor(options, terminal) {
        this.options = options
        this.terminal = terminal
    }

    run() {
        if (this.options.showHelp) {
            this.terminal.printHelp()
            return
        }
        if (this.options.projectRoot == null) {
            this.terminal.error('ERROR: You must specify the project path using -p option.')
            this.terminal.printHelp()
            throw new ReportedError('Missing project path')
        }
        this.validateModes()

        const projectRoot = path.resolve(this.options.projectRoot)
        const gitRepository = new GitRepository(projectRoot, this.terminal)
        const gitWasCleanAtStart = this.checkInitialGitState(gitRepository)
        const initialChanges = this.options.version == null ? null : gitRepository.captureChanges()

        this.terminal.header('Preparing release script started')
        this.terminal.info(` - Using project path: ${projectRoot}`)
        const definition = ReleaseDefinition.load(projectRoot, this.terminal)

        if (this.options.prepareDevMode) {
            this.prepareDevelopment(projectRoot, definition)
            return
        }

        const verifyMode = this.options.verifyMode || this.options.version == null
        const versionValue = this.options.version == null
            ? new VersionResolver(projectRoot, this.terminal).resolve(definition)
            : this.options.version
        const version = new ReleaseVersion(versionValue, this.terminal)
        const factory = new ReleaseFileOperationFactory(projectRoot, version, this.terminal)
        const operations = definition.expandedFiles().map(file => factory.create(file))

        if (!verifyMode) {
            this.terminal.header(`Preparing release for version: ${version.value} (stream: ${version.stream})\n`)
            new ReleasePreparer(operations, this.terminal).run()
        }

        this.terminal.header('Verifying that all required files are present and contain the expected content')
        new ReleaseVerifier(operations, this.terminal).run()
        new DefinitionScriptRunner(projectRoot, this.terminal).run(definition.scripts)

        if (
            verifyMode &&
            this.options.gitCleanMode !== 'ignore' &&
            gitWasCleanAtStart &&
            !gitRepository.isClean()
        ) {
            this.terminal.fail(
                'ERROR: The git repository is not clean. Files were created during verification; that is an error.'
            )
        }

        if (initialChanges != null) {
            new ReleaseCommitWorkflow(gitRepository, this.terminal).run(version.value, initialChanges)
        }
    }

    validateModes() {
        if (this.options.prepareDevMode && this.options.version != null) {
            this.terminal.fail('ERROR: --prepare-dev cannot be combined with -v.')
        }
        if (this.options.prepareDevMode && this.options.verifyMode) {
            this.terminal.fail('ERROR: --prepare-dev cannot be combined with --verify.')
        }
    }

    prepareDevelopment(projectRoot, definition) {
        const expandedFiles = definition.expandedFiles()
        const currentVersionValue = new VersionResolver(projectRoot, this.terminal).resolve(
            definition,
            'Resolving current version for prerequisite verification'
        )
        const currentVersion = new ReleaseVersion(currentVersionValue, this.terminal)
        const currentFactory = new ReleaseFileOperationFactory(
            projectRoot,
            currentVersion,
            this.terminal
        )
        const currentOperations = expandedFiles.map(file => currentFactory.create(file))

        this.terminal.header('Verifying the current release before development preparation')
        new ReleaseVerifier(currentOperations, this.terminal).run()

        if (definition.devVersion == null) {
            this.terminal.fail(
                'ERROR: The definition file must specify devVersion when --prepare-dev is used.'
            )
        }

        const devVersion = new ReleaseVersion(definition.devVersion, this.terminal)
        const devFactory = new ReleaseFileOperationFactory(projectRoot, devVersion, this.terminal)
        const devOperations = expandedFiles
            .filter(file => file.devChange === true)
            .map(file => devFactory.create(file))
        const changelogFiles = expandedFiles.filter(file => file.devChangelog === true)

        this.terminal.header(
            `Preparing development files for version: ${devVersion.value} (stream: ${devVersion.stream})`
        )
        new ReleasePreparer(devOperations, this.terminal).run()
        new DevelopmentChangelogPreparer(changelogFiles, projectRoot, this.terminal).run()
        new DefinitionScriptRunner(projectRoot, this.terminal).run(definition.scripts)
    }

    checkInitialGitState(gitRepository) {
        if (this.options.gitCleanMode === 'ignore') {
            return null
        }

        const isClean = gitRepository.isClean()
        if (isClean) {
            return true
        }
        if (this.options.gitCleanMode === 'enforce') {
            this.terminal.fail(
                'ERROR: The git repository is not clean. Please commit or stash your changes before running this script.'
            )
        }
        if (!this.terminal.confirm('The git repository is not clean. Continue anyway? (y/n): ')) {
            this.terminal.fail(
                'ERROR: The git repository is not clean. Release preparation cancelled.'
            )
        }
        return false
    }
}

const terminal = new Terminal()

try {
    const options = CliOptions.parse(process.argv, terminal)
    new PrepareReleaseApplication(options, terminal).run()
} catch (error) {
    if (!(error instanceof ReportedError)) {
        terminal.error(`ERROR: ${error.message}`)
    }
    process.exitCode = 1
}
