#!/usr/bin/env node
// Release guards invoked by .github/workflows/release.yml; executed by
// test/release-guards.test.ts against real tags and temporary Git histories.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const TAG_PATTERN = /^v\d+\.\d+\.\d+$/;

export function tagProblem(tag, version) {
	if (!TAG_PATTERN.test(tag ?? "")) return `tag ${tag} must look like v1.2.3`;
	if (tag !== `v${version}`) return `tag ${tag} does not match package version ${version}`;
	return undefined;
}

export function ancestryProblem(sha, ref, cwd = process.cwd()) {
	const result = spawnSync(
		"git",
		["merge-base", "--is-ancestor", sha, ref],
		{ cwd, encoding: "utf8" },
	);
	if (result.error) return `git failed: ${result.error.message}`;
	if (result.status === 0) return undefined;
	if (result.status === 1) return `${sha} is not reachable from ${ref}`;
	return `git merge-base failed: ${(result.stderr ?? "").trim()}`;
}

function main(argv) {
	const [command, ...args] = argv;
	try {
		if (command === "tag") {
			const file = new URL("../package.json", import.meta.url);
			const version = JSON.parse(readFileSync(file, "utf8")).version;
			const problem = tagProblem(args[0], version);
			if (problem) {
				console.error(`::error::${problem}`);
				return 1;
			}
			console.log(`tag ${args[0]} matches package version ${version}`);
			return 0;
		}
		if (command === "ancestry") {
			const [sha, ref] = args;
			if (!sha || !ref) {
				console.error("usage: release-guards.mjs ancestry <sha> <ref>");
				return 2;
			}
			const problem = ancestryProblem(sha, ref);
			if (!problem) {
				console.log(`${sha} is reachable from ${ref}`);
				return 0;
			}
			console.error(`::error::${problem}`);
			return problem.startsWith("git ") ? 2 : 1;
		}
	} catch (error) {
		console.error(`::error::release guard failed: ${error.message}`);
		return 2;
	}
	console.error("usage: release-guards.mjs <tag|ancestry> ...");
	return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exit(main(process.argv.slice(2)));
}
