#!/usr/bin/env node
// Validates the file list from `npm pack --dry-run --json`, so CI and release
// verify the same published contents. Executed by test/release-guards.test.ts.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const REQUIRED = ["src/index.ts", "README.md", "LICENSE"];
const FORBIDDEN = /^(node_modules|test|\.github)\//;

export function packProblems(manifest) {
	const files = (manifest.files ?? []).map((file) => file.path);
	return {
		files,
		missing: REQUIRED.filter((path) => !files.includes(path)),
		forbidden: files.filter((path) => FORBIDDEN.test(path)),
	};
}

function main(argv) {
	const input = argv[0];
	if (!input) {
		console.error("usage: check-pack-contents.mjs <pack.json>");
		return 2;
	}
	try {
		const [manifest] = JSON.parse(readFileSync(input, "utf8"));
		const { files, missing, forbidden } = packProblems(manifest);
		if (missing.length || forbidden.length) {
			console.error(
				`invalid packaged files: missing=${missing.join(",")}` +
					` forbidden=${forbidden.join(",")}`,
			);
			return 1;
		}
		console.log(`${files.length} packaged files validated`);
		return 0;
	} catch (error) {
		console.error(`::error::cannot read pack manifest: ${error.message}`);
		return 2;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exit(main(process.argv.slice(2)));
}
