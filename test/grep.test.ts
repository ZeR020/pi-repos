import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createRipgrepMatchCollector,
	formatSnapshotGrepOutput,
	grepRepoSnapshot,
	grepRepoViaGitHubRest,
	grepSnapshotWithJavaScript,
	runRipgrepChunk,
} from "../src/grep.ts";

process.env.GITHUB_TOKEN = "fixture-token";

async function createSnapshotFile(files: Record<string, string>): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-repos-grep-"));
	for (const [name, text] of Object.entries(files)) {
		await writeFile(join(directory, name), text, "utf8");
	}
	return directory;
}

function rgMatchLine(filePath: string, lineNumber: number): string {
	return `${JSON.stringify({ type: "match", data: { path: { text: filePath }, line_number: lineNumber } })}\n`;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

const directoryTarget = { files: [] as string[], filterBase: "", isDirectorySearch: true };

test("ripgrep search ignores user configuration", async () => {
	const directory = await createSnapshotFile({ "sample.txt": "axb\n" });
	const configPath = join(directory, "rg-config");
	await writeFile(configPath, "--fixed-strings\n", "utf8");
	const previousConfig = process.env.RIPGREP_CONFIG_PATH;
	process.env.RIPGREP_CONFIG_PATH = configPath;
	try {
		const result = await runRipgrepChunk(
			directory,
			{ repo: "fixture/config", pattern: "a.b" },
			["sample.txt"],
			new Set(["sample.txt"]),
			10,
		);
		assert.deepEqual(result?.matches, [{ filePath: "sample.txt", lineNumber: 1 }]);
	} finally {
		if (previousConfig === undefined) delete process.env.RIPGREP_CONFIG_PATH;
		else process.env.RIPGREP_CONFIG_PATH = previousConfig;
	}
});

test("ripgrep match collection stops at the limit when late output arrives", () => {
	const collector = createRipgrepMatchCollector(new Set(["many.txt"]), 2);
	collector.push(rgMatchLine("many.txt", 1) + rgMatchLine("many.txt", 2) + rgMatchLine("many.txt", 3));
	assert.deepEqual(collector.matches, [
		{ filePath: "many.txt", lineNumber: 1 },
		{ filePath: "many.txt", lineNumber: 2 },
	]);
	assert.equal(collector.done, true);
	collector.push(rgMatchLine("many.txt", 4) + rgMatchLine("many.txt", 5));
	assert.equal(collector.matches.length, 2);
});

test("runRipgrepChunk never exceeds the requested match limit", async () => {
	const directory = await createSnapshotFile({ "many.txt": "hit\n".repeat(20000) });
	const result = await runRipgrepChunk(
		directory,
		{ repo: "fixture/many", pattern: "hit", literal: true },
		["many.txt"],
		new Set(["many.txt"]),
		1,
	);
	assert.equal(result?.matches.length, 1);
	assert.equal(result?.matchLimitReached, true);
});

test("regex, literal, and ignore-case searches keep their meaning", async () => {
	const directory = await createSnapshotFile({ "sample.txt": "axb\na.b\n" });
	const regex = await runRipgrepChunk(directory, { repo: "fixture/regex", pattern: "a.b" }, ["sample.txt"], new Set(["sample.txt"]), 10);
	assert.deepEqual(regex?.matches.map(match => match.lineNumber), [1, 2]);
	const literal = await runRipgrepChunk(
		directory,
		{ repo: "fixture/literal", pattern: "a.b", literal: true },
		["sample.txt"],
		new Set(["sample.txt"]),
		10,
	);
	assert.deepEqual(literal?.matches.map(match => match.lineNumber), [2]);
	const ignoreCase = await runRipgrepChunk(
		directory,
		{ repo: "fixture/ignore-case", pattern: "AXB", ignoreCase: true },
		["sample.txt"],
		new Set(["sample.txt"]),
		10,
	);
	assert.deepEqual(ignoreCase?.matches.map(match => match.lineNumber), [1]);
});

test("JavaScript fallback scan stops when the caller has cancelled", async () => {
	const directory = await createSnapshotFile({ "a.txt": "match\n", "b.txt": "match\n" });
	const snapshot = { path: directory, commit: "0".repeat(40) };
	const preAborted = new AbortController();
	preAborted.abort();
	await assert.rejects(
		grepSnapshotWithJavaScript(snapshot, { repo: "fixture/js", pattern: "match" }, ["a.txt", "b.txt"], 10, preAborted.signal),
		isAbortError,
	);
	const midway = new AbortController();
	queueMicrotask(() => midway.abort());
	await assert.rejects(
		grepSnapshotWithJavaScript(snapshot, { repo: "fixture/js", pattern: "match" }, ["a.txt", "b.txt"], 10, midway.signal),
		isAbortError,
	);
});

test("snapshot grep threads cancellation into its fallback", async () => {
	const directory = await createSnapshotFile({ "a.txt": "match\n" });
	const controller = new AbortController();
	controller.abort();
	const target = { files: ["a.txt"], filterBase: "", isDirectorySearch: true };
	await assert.rejects(
		grepRepoSnapshot({ path: directory, commit: "0".repeat(40) }, { repo: "fixture/grep", pattern: "match\n" }, target, ["a.txt"], controller.signal),
		isAbortError,
	);
	await assert.rejects(
		formatSnapshotGrepOutput(directory, [{ filePath: "a.txt", lineNumber: 1 }], target, 0, controller.signal),
		isAbortError,
	);
});

test("GitHub REST grep fallback starts no request for a cancelled caller", async () => {
	const originalFetch = globalThis.fetch;
	let fetchCalls = 0;
	globalThis.fetch = (async () => {
		fetchCalls++;
		return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
	const controller = new AbortController();
	controller.abort();
	try {
		await assert.rejects(
			grepRepoViaGitHubRest(
				{ owner: "fixture", name: "rest-grep" },
				"main",
				"",
				directoryTarget,
				["a.txt"],
				{ repo: "fixture/rest-grep", pattern: "match" },
				undefined,
				controller.signal,
			),
			isAbortError,
		);
		assert.equal(fetchCalls, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("snapshot scans skip dangling and escaping symlink entries", async () => {
	const outside = await mkdtemp(join(tmpdir(), "pi-repos-grep-outside-"));
	const directory = await createSnapshotFile({ "a.txt": "match\n" });
	try {
		await writeFile(join(outside, "secret.txt"), "match\n", "utf8");
		await symlink(join(outside, "missing.txt"), join(directory, "dangling.txt"));
		await symlink(join(outside, "secret.txt"), join(directory, "external.txt"));
		const files = ["a.txt", "dangling.txt", "external.txt"];
		const snapshot = { path: directory, commit: "0".repeat(40) };
		const expected = [{ filePath: "a.txt", lineNumber: 1 }];
		const fallback = await grepSnapshotWithJavaScript(snapshot, { repo: "fixture/symlink", pattern: "match" }, files, 10);
		assert.deepEqual(fallback.matches, expected);
		const ripgrep = await runRipgrepChunk(directory, { repo: "fixture/symlink", pattern: "match" }, files, new Set(files), 10);
		assert.deepEqual(ripgrep?.matches, expected);
		const rootScan = await grepRepoSnapshot(snapshot, { repo: "fixture/symlink", pattern: "match" }, { files, filterBase: "", isDirectorySearch: true }, files);
		assert.match(rootScan.output, /a\.txt:1: match/);
		assert.doesNotMatch(rootScan.output, /secret|external|dangling/);
	} finally {
		await rm(directory, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	}
});
