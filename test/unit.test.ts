import assert from "node:assert/strict";
import test from "node:test";
import piReposExtension from "../src/index.ts";
import { createGlobMatcher, formatReadOutput, formatRepoSearchDescription, normalizeRepoPath, parseRepoInput, parseRepoLocatorInput } from "../src/backend.ts";

test("registers repo tools", () => {
	const tools: Array<{ name: string }> = [];
	piReposExtension({ registerTool: (tool: { name: string }) => tools.push(tool) } as never);
	assert.deepEqual(tools.map(tool => tool.name), [
		"repo_find",
		"repo_code_search",
		"repo_list",
		"repo_read",
		"repo_find_files",
		"repo_grep",
	]);
});

test("parses owner/name and GitHub URLs", () => {
	assert.deepEqual(parseRepoInput("owner/name"), { owner: "owner", name: "name" });
	assert.deepEqual(parseRepoInput("https://github.com/owner/name.git"), { owner: "owner", name: "name" });
	assert.throws(() => parseRepoInput("https://example.com/owner/name"), /Unsupported repository host/);
});

test("parses GitHub blob and tree URL refs and paths", () => {
	assert.deepEqual(parseRepoLocatorInput("https://github.com/owner/name/blob/main/src/index.ts"), {
		repo: { owner: "owner", name: "name" },
		ref: "main",
		path: "src/index.ts",
		urlKind: "blob",
	});
	assert.deepEqual(parseRepoLocatorInput("https://github.com/owner/name/tree/v1/examples"), {
		repo: { owner: "owner", name: "name" },
		ref: "v1",
		path: "examples",
		urlKind: "tree",
	});
});

test("normalizes repository paths", () => {
	assert.equal(normalizeRepoPath("/packages/foo/"), "packages/foo");
	assert.equal(normalizeRepoPath(undefined), "");
});

test("matches recursive globs", () => {
	const matcher = createGlobMatcher("**/*.test.ts");
	assert.equal(matcher("src/foo.test.ts"), true);
	assert.equal(matcher("foo.test.ts"), true);
	assert.equal(matcher("src/foo.ts"), false);
});

test("formats limited file reads with continuation hints", () => {
	const result = formatReadOutput("one\ntwo\nthree", 1, 2);
	assert.equal(result.text, "one\ntwo\n\n[1 more lines in file. Use offset=3 to continue.]");
});

test("truncates noisy repository descriptions", () => {
	const result = formatRepoSearchDescription("word ".repeat(80), 25);
	assert.equal(result, " — word word word word word…");
});
