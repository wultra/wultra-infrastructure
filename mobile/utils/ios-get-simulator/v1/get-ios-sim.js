#!/usr/bin/env node

// Resolve the best available iOS Simulator destination for an Xcode project scheme.
// The script expects: -p <project-root> <xcodeproj-path> <scheme-name>

const { spawnSync } = require("node:child_process");

function fail(message) {
    console.error(message);
    process.exit(1);
}

function parseArguments(argv) {
    if (argv.length !== 4 || argv[0] !== "-p") {
        fail("Usage: node get-ios-sim.js -p <project-root> <xcodeproj-path> <scheme-name>");
    }
    return {
        projectRoot: argv[1],
        xcodeProjectPath: argv[2],
        scheme: argv[3]
    };
}

function compareVersions(lhs, rhs) {
    const left = lhs.split(".").map(Number);
    const right = rhs.split(".").map(Number);
    const length = Math.max(left.length, right.length);

    for (let index = 0; index < length; index += 1) {
        const leftPart = left[index] || 0;
        const rightPart = right[index] || 0;
        if (leftPart !== rightPart) {
            return leftPart - rightPart;
        }
    }
    return 0;
}

function resolveDestinations(projectRoot, xcodeProjectPath, scheme) {
    // Ask Xcode for the scheme's destinations so the selection matches what the server can actually run.
    const result = spawnSync(
        "xcodebuild",
        ["-project", xcodeProjectPath, "-scheme", scheme, "-showdestinations", "-disableAutomaticPackageResolution"],
        { cwd: projectRoot, encoding: "utf8" }
    );

    if (result.status !== 0) {
        fail((result.stderr || result.stdout || "Failed to resolve destinations").trim());
    }

    return `${result.stdout}\n${result.stderr}`;
}

function parseDestinationList(output) {
    const destinations = [];
    const seen = new Set();
    const blocks = output.match(/\{[^}]+\}/g) || [];

    // Keep the first simulator for each OS/name pair and then pick the highest OS version overall.
    for (const block of blocks) {
        if (!block.includes("platform:iOS Simulator") || block.includes("error:")) {
            continue;
        }

        const osMatch = block.match(/OS:([^,}]+)/);
        const nameMatch = block.match(/name:([^,}]+)/);
        if (!osMatch || !nameMatch) {
            continue;
        }

        const os = osMatch[1].trim();
        const name = nameMatch[1].trim();
        const key = `${os}\u0000${name}`;
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        destinations.push({ os, name });
    }

    return destinations;
}

function selectDestination(destinations, rawOutput) {
    if (destinations.length === 0) {
        fail(`No eligible iOS Simulator destinations found.\n\nxcodebuild -showdestinations output:\n${rawOutput}`);
    }

    let best = destinations[0];
    for (const destination of destinations.slice(1)) {
        if (compareVersions(destination.os, best.os) > 0) {
            best = destination;
        }
    }
    return `platform=iOS Simulator,OS=${best.os},name=${best.name}`;
}

const { projectRoot, xcodeProjectPath, scheme } = parseArguments(process.argv.slice(2));
const output = resolveDestinations(projectRoot, xcodeProjectPath, scheme);
const destinations = parseDestinationList(output);

console.log(selectDestination(destinations, output));
