import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { getRepoSnapshotPath } from "../src/store.ts";
import { REPO_CACHE_COMPLETE_MARKER } from "../src/constants.ts";

let executeTar: (command: string, args: string[], options?: { signal?: AbortSignal }) => Promise<{ stdout: string; stderr: string }>;
const originalExecFile = childProcess.execFile;
const fakeExecFile = () => { throw new Error("Expected promisified tar execution"); };
Object.defineProperty(fakeExecFile, promisify.custom, {
	value: (command: string, args: string[], options?: { signal?: AbortSignal }) => executeTar(command, args, options),
});
childProcess.execFile = fakeExecFile as unknown as typeof originalExecFile;
syncBuiltinESMExports();
const { createRepoSnapshot, downloadRepoArchive } = await import("../src/snapshot.ts");
childProcess.execFile = originalExecFile;
syncBuiltinESMExports();

const repo = { owner: "fixture", name: "snapshot-cancellation" };
const sha = "c".repeat(40);

async function assertCancelledBeforeRelease(operation: Promise<unknown>, release: () => void) {
	const outcome = operation.then(() => null, error => error as unknown);
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			outcome,
			new Promise<string>(resolve => { timer = setTimeout(() => resolve("still pending"), 1000); }),
		]);
		assert.equal(result instanceof Error ? result.name : result, "AbortError");
	} finally {
		if (timer) clearTimeout(timer);
		release();
		await outcome;
	}
}

async function fixture(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "pi-repos-cancel-"));
	const oldCache = process.env.PI_REPOS_CACHE_DIR;
	const oldToken = process.env.GH_TOKEN;
	const oldFetch = globalThis.fetch;
	process.env.PI_REPOS_CACHE_DIR = root;
	process.env.GH_TOKEN = "synthetic-fixture-token";
	t.after(async () => {
		globalThis.fetch = oldFetch;
		if (oldCache === undefined) delete process.env.PI_REPOS_CACHE_DIR;
		else process.env.PI_REPOS_CACHE_DIR = oldCache;
		if (oldToken === undefined) delete process.env.GH_TOKEN;
		else process.env.GH_TOKEN = oldToken;
		await rm(root, { recursive: true, force: true });
	});
	return root;
}

test("a pre-aborted snapshot call does not reuse even a complete cache", { timeout: 5000 }, async t => {
	await fixture(t);
	const cachePath = getRepoSnapshotPath(repo, sha);
	await mkdir(cachePath, { recursive: true });
	await writeFile(join(cachePath, REPO_CACHE_COMPLETE_MARKER), sha);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(createRepoSnapshot(repo, sha, controller.signal), { name: "AbortError" });
});

test("archive streaming cancellation settles before the body completes", { timeout: 5000 }, async t => {
	const root = await fixture(t);
	let streamController!: ReadableStreamDefaultController<Uint8Array>;
	let signalReading!: () => void;
	const reading = new Promise<void>(resolve => { signalReading = resolve; });
	globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
		start(controller) { streamController = controller; controller.enqueue(new Uint8Array([1])); },
		pull() { signalReading(); return new Promise<void>(() => {}); },
	}));
	const controller = new AbortController();
	const operation = downloadRepoArchive(repo, sha, join(root, "archive"), controller.signal);
	await reading;
	controller.abort();
	await assertCancelledBeforeRelease(operation, () => { try { streamController.close(); } catch { /* Already cancelled. */ } });
});

test("archive extraction cancellation settles without publishing", { timeout: 5000 }, async t => {
	await fixture(t);
	globalThis.fetch = async () => new Response("synthetic archive");
	let signalStarted!: () => void;
	const started = new Promise<void>(resolve => { signalStarted = resolve; });
	let release!: () => void;
	executeTar = async (command, _args, options) => {
		assert.equal(command, "tar");
		return new Promise((resolve, reject) => {
			const abort = () => reject(options!.signal!.reason);
			release = () => { options?.signal?.removeEventListener("abort", abort); resolve({ stdout: "", stderr: "" }); };
			options?.signal?.addEventListener("abort", abort, { once: true });
			signalStarted();
		});
	};
	const controller = new AbortController();
	const operation = createRepoSnapshot(repo, sha, controller.signal);
	await started;
	controller.abort();
	await assertCancelledBeforeRelease(operation, () => release());
	await assert.rejects(import("node:fs/promises").then(fs => fs.access(`${getRepoSnapshotPath(repo, sha)}.snapshot.json`)), { code: "ENOENT" });
});
