import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getRepoCommitSha, getRepoFileText, getRepoMetadata, getRepoTree, parseRepoInput } from "../src/github.ts";
import type { GitHubRepo } from "../src/types.ts";

process.env.PI_REPOS_CACHE_DIR = await mkdtemp(join(tmpdir(), "pi-repos-github-"));
process.env.GITHUB_TOKEN = "fixture-token";

type ResponseFactory = () => Response;
type TransportCall = { url: string; signal: AbortSignal | undefined };

function jsonResponse(body: unknown, status = 200): ResponseFactory {
	return () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function failureResponse(): ResponseFactory {
	return () => new Response("temporary failure", { status: 503 });
}

function stubTransport(handler: (url: string, init: RequestInit | undefined) => Promise<Response>): { calls: TransportCall[]; restore: () => void } {
	const originalFetch = globalThis.fetch;
	const calls: TransportCall[] = [];
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push({ url, signal: init?.signal ?? undefined });
		return handler(url, init);
	}) as unknown as typeof fetch;
	return {
		calls,
		restore: () => {
			globalThis.fetch = originalFetch;
		},
	};
}

function stubResponses(...factories: ResponseFactory[]): { calls: TransportCall[]; restore: () => void } {
	let index = 0;
	return stubTransport(async () => factories[Math.min(index++, factories.length - 1)]());
}

function repo(name: string): GitHubRepo {
	return { owner: "fixture", name };
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

const FIXTURE_DEADLINE_MS = 2000;

function withinDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} did not settle within ${FIXTURE_DEADLINE_MS}ms`)), FIXTURE_DEADLINE_MS);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const commitSha = "a".repeat(40);
const metadataBody = { default_branch: "main" };
const treeBody = { truncated: false, tree: [{ path: "README.md", type: "blob" }] };
const fileBody = {
	type: "file",
	path: "a.txt",
	name: "a.txt",
	size: 5,
	encoding: "base64",
	content: Buffer.from("hello").toString("base64"),
	download_url: null,
};

test("repo metadata retries after a transient API failure", async () => {
	const transport = stubResponses(failureResponse(), jsonResponse(metadataBody));
	try {
		await assert.rejects(getRepoMetadata(repo("metadata-retry")), /request failed \(503/);
		assert.deepEqual(await getRepoMetadata(repo("metadata-retry")), metadataBody);
		assert.equal(transport.calls.length, 2);
	} finally {
		transport.restore();
	}
});

test("repo tree retries after a transient API failure", async () => {
	const transport = stubResponses(failureResponse(), jsonResponse(treeBody));
	try {
		await assert.rejects(getRepoTree(repo("tree-retry"), "main"), /request failed \(503/);
		assert.deepEqual(await getRepoTree(repo("tree-retry"), "main"), { ref: "main", tree: treeBody });
		assert.equal(transport.calls.length, 2);
	} finally {
		transport.restore();
	}
});

test("repo file retries after a transient API failure", async () => {
	const transport = stubResponses(failureResponse(), jsonResponse(fileBody));
	try {
		await assert.rejects(getRepoFileText(repo("file-retry"), "main", "a.txt"), /request failed \(503/);
		assert.equal(await getRepoFileText(repo("file-retry"), "main", "a.txt"), "hello");
		assert.equal(transport.calls.length, 2);
	} finally {
		transport.restore();
	}
});

test("repo commit retries after a transient API failure", async () => {
	const transport = stubResponses(failureResponse(), jsonResponse({ sha: commitSha }));
	try {
		await assert.rejects(getRepoCommitSha(repo("commit-retry"), "main"), /request failed \(503/);
		assert.equal(await getRepoCommitSha(repo("commit-retry"), "main"), commitSha);
		assert.equal(transport.calls.length, 2);
	} finally {
		transport.restore();
	}
});

test("unsignalled lookups still share one request per repository", async () => {
	const transport = stubResponses(jsonResponse(metadataBody));
	try {
		const [first, second] = await Promise.all([getRepoMetadata(repo("metadata-dedupe")), getRepoMetadata(repo("metadata-dedupe"))]);
		assert.deepEqual(first, metadataBody);
		assert.deepEqual(second, metadataBody);
		assert.equal(transport.calls.length, 1);
	} finally {
		transport.restore();
	}
});

test("an already-cancelled caller starts no request", async () => {
	const operations: Array<{ label: string; run: (signal: AbortSignal) => Promise<unknown> }> = [
		{ label: "metadata", run: signal => getRepoMetadata(repo("metadata-aborted"), signal) },
		{ label: "tree", run: signal => getRepoTree(repo("tree-aborted"), "main", signal) },
		{ label: "file", run: signal => getRepoFileText(repo("file-aborted"), "main", "a.txt", signal) },
		{ label: "commit", run: signal => getRepoCommitSha(repo("commit-aborted"), "main", signal) },
	];
	const transport = stubResponses(jsonResponse(metadataBody));
	try {
		for (const operation of operations) {
			const controller = new AbortController();
			controller.abort();
			await assert.rejects(operation.run(controller.signal), isAbortError, `${operation.label} must reject before transport`);
		}
		assert.equal(transport.calls.length, 0);
	} finally {
		transport.restore();
	}
});

test("cancelling a caller mid-request rejects its pending lookup", async () => {
	const controller = new AbortController();
	let markStarted = () => {};
	const started = new Promise<void>(resolve => {
		markStarted = resolve;
	});
	const transport = stubTransport(
		(_url, init) =>
			new Promise<Response>((_resolve, reject) => {
				markStarted();
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			}),
	);
	try {
		const pending = getRepoMetadata(repo("metadata-mid-abort"), controller.signal);
		await withinDeadline(started, "request start");
		controller.abort();
		await assert.rejects(withinDeadline(pending, "mid-request lookup"), isAbortError);
		assert.equal(transport.calls.length, 1);
		assert.equal(transport.calls[0].signal, controller.signal);
	} finally {
		transport.restore();
	}
});

test("cancelling one caller leaves another caller's result intact", async () => {
	const cancelled = new AbortController();
	const kept = new AbortController();
	const pending: Array<{ resolve: (response: Response) => void; signal: AbortSignal | undefined }> = [];
	const transport = stubTransport(
		(_url, init) =>
			new Promise<Response>((resolve, reject) => {
				pending.push({ resolve, signal: init?.signal ?? undefined });
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			}),
	);
	try {
		const cancelledLookup = getRepoMetadata(repo("metadata-distinct-signals"), cancelled.signal);
		const keptLookup = getRepoMetadata(repo("metadata-distinct-signals"), kept.signal);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(pending.length, 2);
		cancelled.abort();
		pending[1].resolve(jsonResponse(metadataBody)());
		await assert.rejects(withinDeadline(cancelledLookup, "cancelled lookup"), isAbortError);
		assert.deepEqual(await withinDeadline(keptLookup, "kept lookup"), metadataBody);
	} finally {
		transport.restore();
	}
});

test("cancelling a signalled caller does not poison the shared lookup", async () => {
	const cancelled = new AbortController();
	const pending: Array<{ resolve: (response: Response) => void }> = [];
	const transport = stubTransport(
		(_url, init) =>
			new Promise<Response>((resolve, reject) => {
				pending.push({ resolve });
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
			}),
	);
	try {
		const sharedLookup = getRepoMetadata(repo("metadata-shared"));
		const signalledLookup = getRepoMetadata(repo("metadata-shared"), cancelled.signal);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(pending.length, 2);
		cancelled.abort();
		pending[0].resolve(jsonResponse(metadataBody)());
		await assert.rejects(withinDeadline(signalledLookup, "signalled lookup"), isAbortError);
		assert.deepEqual(await withinDeadline(sharedLookup, "shared lookup"), metadataBody);
	} finally {
		transport.restore();
	}
});

test("repository identifiers reject unsafe owner and name segments", () => {
	for (const input of [
		"../..",
		"owner/..",
		"owner/.",
		"owner/../etc",
		"../owner/repo",
		"owner/na\0me",
		"https://github.com/owner%2F..%2Fetc/repo",
		"https://github.com/owner/..%2f",
	]) {
		assert.throws(() => parseRepoInput(input), /Invalid repository/, input);
	}
	assert.throws(() => parseRepoInput("https://github.com/../.."), /Invalid GitHub repository URL/);
	assert.throws(() => parseRepoInput("https://github.com/owner/%zz"), /Invalid GitHub repository URL/);
	assert.throws(() => parseRepoInput("https://"), /Invalid GitHub repository URL/);
	assert.throws(() => parseRepoInput("https://github.com:bad/owner"), /Invalid GitHub repository URL/);
	assert.deepEqual(parseRepoInput("owner/name"), { owner: "owner", name: "name" });
	assert.deepEqual(parseRepoInput("owner/name.git"), { owner: "owner", name: "name" });
	assert.deepEqual(parseRepoInput("https://github.com/owner/name.git"), { owner: "owner", name: "name" });
	assert.deepEqual(parseRepoInput("https://github.com/owner/name/tree/main/src"), { owner: "owner", name: "name" });
});

test("repository identifiers use GitHub's owner and name character sets", () => {
	for (const input of [
		"fixture/a?b",
		"fixture/a#b",
		"fixture/a b",
		"fixture/a:b",
		"fixture/a%b",
		"fixture/a+b",
		"fixture/a@b",
		"https://github.com/fixture/a%3Fb",
		"https://github.com/fixture/a%23b",
	]) {
		assert.throws(() => parseRepoInput(input), /Invalid repository/, input);
	}
	assert.deepEqual(parseRepoInput("ZeR020/pi-repos"), { owner: "ZeR020", name: "pi-repos" });
	assert.deepEqual(parseRepoInput("fixture/.github"), { owner: "fixture", name: ".github" });
	assert.deepEqual(parseRepoInput("fixture/a_b.c-d"), { owner: "fixture", name: "a_b.c-d" });
	assert.deepEqual(parseRepoInput("Upper/Case"), { owner: "Upper", name: "Case" });
});

test("invalid identifiers cannot alias a valid repository cache entry", () => {
	assert.deepEqual(parseRepoInput("fixture/a_b"), { owner: "fixture", name: "a_b" });
	for (const alias of ["fixture/a?b", "fixture/a#b", "fixture/a b", "fixture/a:b"]) {
		assert.throws(() => parseRepoInput(alias), /Invalid repository/, alias);
	}
});

test("files without inline content are re-read from the contents endpoint", async () => {
	const largeFileBody = {
		...fileBody,
		size: 1_200_000,
		encoding: "none",
		content: "",
		download_url: "https://raw.githubusercontent.com/fixture/file-raw/main/a.txt",
	};
	const transport = stubResponses(jsonResponse(largeFileBody), () => new Response("large contents", { status: 200 }));
	try {
		assert.equal(await getRepoFileText(repo("file-raw"), "main", "a.txt"), "large contents");
		assert.equal(transport.calls.length, 2);
		assert.equal(transport.calls[1].url, transport.calls[0].url);
	} finally {
		transport.restore();
	}
});

test("empty files return empty text without another request", async () => {
	const transport = stubResponses(jsonResponse({ ...fileBody, size: 0, content: "" }));
	try {
		assert.equal(await getRepoFileText(repo("file-empty"), "main", "a.txt"), "");
		assert.equal(transport.calls.length, 1);
	} finally {
		transport.restore();
	}
});

test("a cancelled caller stops waiting for shared token discovery", async () => {
	const stubDirectory = await mkdtemp(join(tmpdir(), "pi-repos-gh-"));
	const releasePath = join(stubDirectory, "release");
	const tokenVariables = ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PAT", "GITHUB_PERSONAL_ACCESS_TOKEN"];
	const previousTokens = tokenVariables.map(name => [name, process.env[name]] as const);
	const previousPath = process.env.PATH;
	// Bounded stub: discovery stays pending until the release file exists or roughly 4s pass.
	await writeFile(
		join(stubDirectory, "gh"),
		`#!/bin/sh\ni=0\nwhile [ ! -f "${releasePath}" ] && [ "$i" -lt 400 ]; do sleep 0.01; i=$((i + 1)); done\necho stub-token\n`,
		{ mode: 0o755 },
	);
	const transport = stubResponses(jsonResponse(metadataBody));
	const cancelled = new AbortController();
	const kept = new AbortController();
	try {
		for (const name of tokenVariables) delete process.env[name];
		process.env.PATH = `${stubDirectory}:${previousPath ?? ""}`;
		const cancelledLookup = getRepoMetadata(repo("metadata-token-discovery"), cancelled.signal);
		const keptLookup = getRepoMetadata(repo("metadata-token-discovery"), kept.signal);
		await new Promise(resolve => setImmediate(resolve));
		cancelled.abort();
		await assert.rejects(
			withinDeadline(cancelledLookup, "cancelled token waiter"),
			isAbortError,
			"a cancelled caller must not wait for token discovery",
		);
		assert.equal(transport.calls.length, 0);
		await writeFile(releasePath, "", "utf8");
		assert.deepEqual(await withinDeadline(keptLookup, "shared token waiter"), metadataBody);
		assert.equal(transport.calls.length, 1);
	} finally {
		for (const [name, value] of previousTokens) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		process.env.PATH = previousPath;
		transport.restore();
		await rm(stubDirectory, { recursive: true, force: true });
	}
});
