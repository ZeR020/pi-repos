import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function workflow(name: string): string {
	return readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
}

const PINNED_ACTION = /^\s*-?\s*uses:\s+[\w.-]+\/[\w.-]+@[0-9a-f]{40}(?:\s+#\s+v\S+)?$/gm;

function assertPinnedActions(file: string): void {
	const uses = file.match(/^\s*uses:.*$/gm) ?? [];
	assert.ok(uses.length > 0, "workflow must use actions");
	const pinned = file.match(PINNED_ACTION) ?? [];
	assert.equal(pinned.length, uses.length, `every action must be pinned to a full commit SHA:\n${uses.join("\n")}`);
}

test("CI workflow installs locked dependencies on Node 22 and 24", () => {
	const file = workflow("ci.yml");
	assert.match(file, /^on:\s*$/m);
	assert.match(file, /^ {2}pull_request:\s*$/m);
	assert.match(file, /^ {2}push:\s*\n {4}branches: \["main"\]$/m);
	assert.match(file, /npm ci --ignore-scripts/);
	assert.match(file, /matrix:\s*\n\s+node: \["22", "24"\]/);
	assert.match(file, /npm run check/);
});

test("CI workflow audits dependencies and validates the package", () => {
	const file = workflow("ci.yml");
	assert.match(file, /npm audit --audit-level=high/);
	assert.match(file, /npm pack --dry-run --ignore-scripts/);
	assert.match(file, /timeout-minutes:/);
});

test("workflows default to read-only tokens and avoid untrusted trigger contexts", () => {
	for (const name of ["ci.yml", "release.yml"]) {
		const file = workflow(name);
		assert.match(file, /^permissions:\s*\n {2}contents: read$/m, `${name} default permissions`);
		assert.doesNotMatch(file, /pull_request_target/, name);
		assert.doesNotMatch(file, /\$\{\{\s*github\.event\.(issue|comment|review|pull_request)\./, name);
		assertPinnedActions(file);
	}
});

test("release workflow publishes only checks-passed, version-matched main tags", () => {
	const file = workflow("release.yml");
	assert.match(file, /^ {4}tags: \["v\*"\]$/m);
	assert.match(file, /node -p "require\('\.\/package\.json'\)\.version"/);
	assert.match(file, /git merge-base --is-ancestor/);
	assert.match(file, /npm run check/);
	assert.match(file, /npm audit --audit-level=high/);
	assert.match(file, /npm pack --ignore-scripts/);
	assert.match(file, /sha256sum/);
	assert.match(file, /gh release create/);
	assert.match(file, /GITHUB_TOKEN|github\.token/);
	assert.equal(file.match(/contents: write/g)?.length, 1, "only the release job may write contents");
	assert.match(file, /needs:/);
	assert.doesNotMatch(file, /npm publish|NPM_TOKEN/);
});

test("workflows guarantee GNU tar and ripgrep for real archive/grep coverage", () => {
	for (const name of ["ci.yml", "release.yml"]) {
		const file = workflow(name);
		assert.match(file, /GNU tar/, `${name} must require GNU tar`);
		assert.match(file, /command -v rg/, `${name} must detect ripgrep`);
		assert.match(
			file,
			/apt-get install -y --no-install-recommends ripgrep/,
			`${name} must provision ripgrep`,
		);
		assert.match(file, /rg --version/, `${name} must fail without ripgrep`);
	}
});
