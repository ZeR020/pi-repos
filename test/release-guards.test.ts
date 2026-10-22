import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const guards = join(repoRoot, "scripts", "release-guards.mjs");
const packCheck = join(repoRoot, "scripts", "check-pack-contents.mjs");
const packageVersion: string = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

function run(args: string[], cwd: string, env: Record<string, string> = {}) {
	return spawnSync(process.execPath, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
}

function tempRepo(): { root: string; env: Record<string, string> } {
	const root = mkdtempSync(join(tmpdir(), "pi-repos-guards-"));
	const env = {
		HOME: root,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Guard Test",
		GIT_AUTHOR_EMAIL: "guard@example.invalid",
		GIT_COMMITTER_NAME: "Guard Test",
		GIT_COMMITTER_EMAIL: "guard@example.invalid",
	};
	const git = spawnSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root, env: { ...process.env, ...env } });
	assert.equal(git.status, 0, git.stderr?.toString());
	return { root, env };
}

function commit(root: string, env: Record<string, string>, contents: string): string {
	writeFileSync(join(root, "tracked.txt"), contents);
	for (const args of [["add", "tracked.txt"], ["commit", "-q", "-m", contents], ["rev-parse", "HEAD"]]) {
		const result = spawnSync("git", args, { cwd: root, env: { ...process.env, ...env }, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		if (args[0] === "rev-parse") return result.stdout.trim();
	}
	throw new Error("unreachable");
}

test("tag guard accepts the tag matching the package version", () => {
	const result = run([guards, "tag", `v${packageVersion}`], repoRoot);
	assert.equal(result.status, 0, result.stderr);
});

test("tag guard rejects a mismatched version tag", () => {
	const wrong = packageVersion === "0.0.1" ? "0.0.2" : "0.0.1";
	const result = run([guards, "tag", `v${wrong}`], repoRoot);
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stderr, /does not match package version/);
});

test("tag guard rejects malformed tags", () => {
	const result = run([guards, "tag", packageVersion], repoRoot);
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stderr, /must look like v1\.2\.3/);
});

test("ancestry guard separates reachable, unreachable and git-error outcomes", () => {
	const { root, env } = tempRepo();
	try {
		const first = commit(root, env, "one");
		const second = commit(root, env, "two");

		const reachable = run([guards, "ancestry", first, second], root, env);
		assert.equal(reachable.status, 0, reachable.stderr);

		const unreachable = run([guards, "ancestry", second, first], root, env);
		assert.equal(unreachable.status, 1, unreachable.stderr);
		assert.match(unreachable.stderr, /is not reachable from/);

		const missingRef = run([guards, "ancestry", first, "refs/heads/missing"], root, env);
		assert.equal(missingRef.status, 2, missingRef.stderr);
		assert.match(missingRef.stderr, /git merge-base failed/);

		const outsideRepository = run([guards, "ancestry", first, second], tmpdir(), env);
		assert.equal(outsideRepository.status, 2, outsideRepository.stderr);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("ancestry guard requires both revisions", () => {
	const result = run([guards, "ancestry", "HEAD"], repoRoot);
	assert.equal(result.status, 2, result.stderr);
	assert.match(result.stderr, /usage:/);
});

test("packed-file validation accepts the shipped file set", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-repos-pack-"));
	try {
		const file = join(root, "pack.json");
		writeFileSync(
			file,
			JSON.stringify([
				{
					files: [
						{ path: "LICENSE" },
						{ path: "README.md" },
						{ path: "package.json" },
						{ path: "src/index.ts" },
					],
				},
			]),
		);
		const result = run([packCheck, file], root);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /4 packaged files validated/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("packed-file validation rejects missing sources and development files", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-repos-pack-"));
	try {
		const missing = join(root, "missing.json");
		writeFileSync(missing, JSON.stringify([{ files: [{ path: "src/index.ts" }, { path: "README.md" }] }]));
		const missingResult = run([packCheck, missing], root);
		assert.equal(missingResult.status, 1, missingResult.stderr);
		assert.match(missingResult.stderr, /missing=LICENSE/);

		const leaked = join(root, "leaked.json");
		writeFileSync(
			leaked,
			JSON.stringify([
				{ files: [{ path: "LICENSE" }, { path: "README.md" }, { path: "src/index.ts" }, { path: "test/unit.test.ts" }] },
			]),
		);
		const leakedResult = run([packCheck, leaked], root);
		assert.equal(leakedResult.status, 1, leakedResult.stderr);
		assert.match(leakedResult.stderr, /forbidden=test\/unit\.test\.ts/);

		const usage = run([packCheck], root);
		assert.equal(usage.status, 2, usage.stderr);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
