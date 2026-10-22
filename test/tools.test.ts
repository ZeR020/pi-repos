import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import piReposExtension from "../src/index.ts";
import { getRepoSnapshotPath } from "../src/store.ts";

type Result = { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown> };
type TestTool = { name: string; execute(id: string, params: Record<string, unknown>, signal?: AbortSignal, update?: undefined, ctx?: { cwd: string }): Promise<Result> };
const registered: TestTool[] = [];
piReposExtension({ registerTool: (tool: TestTool) => registered.push(tool) } as never);
const tools = new Map(registered.map(tool => [tool.name, tool]));
const commit = "a".repeat(40);
let sequence = 0;
const text = (result: Result) => result.content.map(block => block.text ?? "").join("\n");

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pi-repos-tools-"));
	const previous = { cache: process.env.PI_REPOS_CACHE_DIR, token: process.env.GH_TOKEN, fetch: globalThis.fetch };
	process.env.PI_REPOS_CACHE_DIR = join(root, "cache");
	process.env.GH_TOKEN = "synthetic-offline-test";
	const repo = { owner: "fixture", name: `tools-${++sequence}` };
	const snapshot = getRepoSnapshotPath(repo, commit);
	const local = join(root, "local");
	await mkdir(snapshot, { recursive: true });
	await mkdir(local);
	await writeFile(join(snapshot, ".pi-repos-complete"), commit);
	await writeFile(join(snapshot, "remote file.txt"), "REMOTE FIXTURE\nsecond line\n");
	await writeFile(join(local, "remote file.txt"), "LOCAL FIXTURE\n");
	let requests = 0;
	globalThis.fetch = async input => {
		requests++;
		const url = String(input);
		if (url.includes("/search/repositories")) return Response.json({ items: [{ full_name: "fixture/result", description: "fixture", stargazers_count: 7, html_url: "https://github.com/fixture/result" }] });
		if (url.includes("/search/code")) return Response.json({ total_count: 1, incomplete_results: false, items: [{ name: "remote file.txt", path: "remote file.txt", html_url: "https://github.com/fixture/result/blob/main/remote%20file.txt", repository: { full_name: "fixture/result", html_url: "https://github.com/fixture/result" }, text_matches: [{ property: "content", fragment: "REMOTE FIXTURE" }] }] });
		if (url.includes("/contents/")) return Response.json({ type: "file", path: "escape/secret.txt", name: "secret.txt", size: 8, encoding: "base64", content: Buffer.from("FALLBACK").toString("base64"), download_url: null });
		throw new Error(`Unexpected offline request: ${url}`);
	};
	t.after(async () => {
		globalThis.fetch = previous.fetch;
		if (previous.cache === undefined) delete process.env.PI_REPOS_CACHE_DIR; else process.env.PI_REPOS_CACHE_DIR = previous.cache;
		if (previous.token === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous.token;
		await rm(root, { recursive: true, force: true });
	});
	const params = { repo: `${repo.owner}/${repo.name}`, ref: commit };
	const execute = (name: string, extra: Record<string, unknown> = {}, signal?: AbortSignal) => tools.get(name)!.execute("test", { ...params, ...extra }, signal, undefined, { cwd: local });
	return { root, snapshot, local, params, execute, requests: () => requests };
}

test("repo_read reads the remote snapshot instead of a same-named local project file", async t => {
	const f = await fixture(t);
	const result = await f.execute("repo_read", { path: "remote file.txt", offset: 1, limit: 1 });
	assert.match(text(result), /REMOTE FIXTURE/);
	assert.doesNotMatch(text(result), /LOCAL FIXTURE/);
	assert.equal(result.details?.backend, "github-archive-cache");
	assert.equal(f.requests(), 0);
});

test("repository path tools reject parent traversal before REST fallback", async t => {
	for (const name of ["repo_read", "repo_list", "repo_find_files", "repo_grep"]) {
		await t.test(name, async child => {
			const f = await fixture(child);
			await assert.rejects(f.execute(name, { path: "../outside.txt", pattern: "REMOTE" }), /Unsafe repository path/);
			assert.equal(f.requests(), 0);
		});
	}
});

test("repo_read rejects an escaping symlink instead of hiding it with REST fallback", async t => {
	const f = await fixture(t);
	const outside = join(f.root, "outside");
	await mkdir(outside);
	await writeFile(join(outside, "secret.txt"), "OUTSIDE FIXTURE");
	await symlink(outside, join(f.snapshot, "escape"));
	await assert.rejects(f.execute("repo_read", { path: "escape/secret.txt" }), /Unsafe repository path/);
	assert.equal(f.requests(), 0);
});

test("repo_list and repo_grep reject escaping symlinks without REST fallback", async t => {
	for (const name of ["repo_list", "repo_grep"]) {
		await t.test(name, async child => {
			const f = await fixture(child);
			const outside = join(f.root, "outside");
			await mkdir(join(outside, "subdir"), { recursive: true });
			await writeFile(join(outside, "subdir", "secret.txt"), "REMOTE OUTSIDE FIXTURE");
			await symlink(outside, join(f.snapshot, "escape"));
			const path = name === "repo_list" ? "escape/subdir" : "escape/subdir/secret.txt";
			await assert.rejects(f.execute(name, { path, pattern: "REMOTE", literal: true }), /Unsafe repository path/);
			assert.equal(f.requests(), 0);
		});
	}
});

test("repo_read still uses REST for a safe file absent from the archive", async t => {
	const f = await fixture(t);
	const result = await f.execute("repo_read", { path: "missing.txt" });
	assert.equal(text(result), "FALLBACK");
	assert.equal(result.details?.backend, "github-rest");
});

test("all six tools retain useful successful results", async t => {
	const f = await fixture(t);
	assert.match(text(await f.execute("repo_find", { query: "fixture" })), /fixture\/result/);
	assert.match(text(await f.execute("repo_code_search", { query: "REMOTE" })), /REMOTE FIXTURE/);
	assert.match(text(await f.execute("repo_list")), /remote file\.txt/);
	assert.match(text(await f.execute("repo_read", { path: "remote file.txt" })), /REMOTE FIXTURE/);
	assert.match(text(await f.execute("repo_find_files", { pattern: "*.txt" })), /remote file\.txt/);
	assert.match(text(await f.execute("repo_grep", { pattern: "REMOTE", literal: true })), /REMOTE FIXTURE/);
	assert.equal(f.requests(), 2);
});

test("all six tools reject pre-cancelled calls without issuing requests", async t => {
	const f = await fixture(t);
	const controller = new AbortController();
	controller.abort();
	for (const name of tools.keys()) {
		await t.test(name, async () => {
			await assert.rejects(f.execute(name, { query: "fixture", path: name === "repo_read" ? "remote file.txt" : undefined, pattern: "REMOTE" }, controller.signal), /abort|cancel/i);
		});
	}
	assert.equal(f.requests(), 0);
});

test("repository and code searches reject cancellation while their request is pending", async t => {
	await fixture(t);
	for (const name of ["repo_find", "repo_code_search"]) {
		await t.test(name, async () => {
			let start!: () => void;
			let finish!: () => void;
			const started = new Promise<void>(resolve => { start = resolve; });
			const responseReady = new Promise<void>(resolve => { finish = resolve; });
			globalThis.fetch = async (_input, init) => {
				start();
				await responseReady;
				init?.signal?.throwIfAborted();
				return Response.json({ items: [], total_count: 0, incomplete_results: false });
			};
			const controller = new AbortController();
			const result = tools.get(name)!.execute("test", { query: "fixture" }, controller.signal);
			const assertion = assert.rejects(result, /abort|cancel/i);
			await started;
			controller.abort();
			finish();
			await assertion;
		});
	}
});
