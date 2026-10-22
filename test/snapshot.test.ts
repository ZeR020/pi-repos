import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { REPO_CACHE_COMPLETE_MARKER } from "../src/constants.ts";
import {
	createRepoSnapshot,
	getCachedRepoState,
	listRepoSnapshot,
	readSnapshotTextFile,
	resolveSnapshotPath,
	UnsafeRepoPathError,
} from "../src/snapshot.ts";
import { getRepoSnapshotPath, pathExists, readJsonFile, writeJsonFile } from "../src/store.ts";
import type { CachedRepoState, GitHubRepo } from "../src/types.ts";

const execFileAsync = promisify(execFile);
const commit = "a".repeat(40);
process.env.GH_TOKEN = "synthetic-offline-fixture";

async function makeCacheDir(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-repos-snapshot-"));
	process.env.PI_REPOS_CACHE_DIR = join(root, "cache");
	return root;
}

async function buildArchive(root: string, name: string, files: Record<string, string>, links: Record<string, string> = {}): Promise<Uint8Array<ArrayBuffer>> {
	const repoDir = join(root, `stage-${name}`, "repo");
	await mkdir(repoDir, { recursive: true });
	for (const [relativePath, content] of Object.entries(files)) {
		await mkdir(dirname(join(repoDir, relativePath)), { recursive: true });
		await writeFile(join(repoDir, relativePath), content, "utf8");
	}
	for (const [relativePath, target] of Object.entries(links)) {
		await symlink(target, join(repoDir, relativePath));
	}
	const tarball = join(root, `${name}.tar.gz`);
	await execFileAsync("tar", ["-czf", tarball, "-C", join(root, `stage-${name}`), "repo"]);
	return Uint8Array.from(await readFile(tarball));
}

async function seedSnapshot(repo: GitHubRepo, files: Record<string, string>): Promise<string> {
	const snapshotPath = getRepoSnapshotPath(repo, commit);
	await mkdir(snapshotPath, { recursive: true });
	for (const [relativePath, content] of Object.entries(files)) {
		await mkdir(dirname(join(snapshotPath, relativePath)), { recursive: true });
		await writeFile(join(snapshotPath, relativePath), content, "utf8");
	}
	await writeFile(join(snapshotPath, REPO_CACHE_COMPLETE_MARKER), commit, "utf8");
	return snapshotPath;
}

function cachedState(snapshotPath: string): CachedRepoState {
	return {
		ref: commit,
		commit,
		tree: { truncated: false, tree: [] },
		snapshot: { path: snapshotPath, commit },
		refUpdatedAt: 0,
	};
}

test("an archive marker symlink cannot redirect the completion marker write", async () => {
	const root = await makeCacheDir();
	const canary = join(root, "canary.txt");
	await writeFile(canary, "UNCHANGED", "utf8");
	const archive = await buildArchive(root, "marker-link", { "remote.txt": "REMOTE" }, { [REPO_CACHE_COMPLETE_MARKER]: canary });
	globalThis.fetch = async () => new Response(archive);

	const snapshot = await createRepoSnapshot({ owner: "fixture", name: "marker-link" }, commit);

	assert.equal(await readFile(canary, "utf8"), "UNCHANGED");
	const marker = join(snapshot.path, REPO_CACHE_COMPLETE_MARKER);
	assert.equal(await readFile(marker, "utf8"), commit);
	assert.equal((await fsp.lstat(marker)).isFile(), true);
});

test("an archive regular file at the marker path is replaced by the marker", async () => {
	const root = await makeCacheDir();
	const archive = await buildArchive(root, "marker-file", { [REPO_CACHE_COMPLETE_MARKER]: "ARCHIVE CONTENT" });
	globalThis.fetch = async () => new Response(archive);

	const snapshot = await createRepoSnapshot({ owner: "fixture", name: "marker-file" }, commit);

	assert.equal(await readFile(join(snapshot.path, REPO_CACHE_COMPLETE_MARKER), "utf8"), commit);
});

test("an archive directory at the marker path is replaced by the marker", async () => {
	const root = await makeCacheDir();
	const archive = await buildArchive(root, "marker-dir", { [`${REPO_CACHE_COMPLETE_MARKER}/nested.txt`]: "nested" });
	globalThis.fetch = async () => new Response(archive);

	const snapshot = await createRepoSnapshot({ owner: "fixture", name: "marker-dir" }, commit);

	const marker = join(snapshot.path, REPO_CACHE_COMPLETE_MARKER);
	assert.equal(await readFile(marker, "utf8"), commit);
	assert.equal((await fsp.lstat(marker)).isFile(), true);
});

test("parent traversal outside the snapshot is rejected", async () => {
	const repo = { owner: "fixture", name: "traversal" };
	const snapshotPath = await seedSnapshot(repo, { "inside.txt": "INSIDE" });
	await writeFile(join(dirname(snapshotPath), "outside.txt"), "OUTSIDE", "utf8");

	await assert.rejects(readSnapshotTextFile(snapshotPath, "../outside.txt"), UnsafeRepoPathError);
	await assert.rejects(resolveSnapshotPath(snapshotPath, "src/../../outside.txt"), UnsafeRepoPathError);
	await assert.rejects(listRepoSnapshot(cachedState(snapshotPath), ".."), UnsafeRepoPathError);
});

test("an external intermediate symlink is rejected", async () => {
	const root = await makeCacheDir();
	const repo = { owner: "fixture", name: "symlink-escape" };
	const snapshotPath = await seedSnapshot(repo, { "inside.txt": "INSIDE" });
	const external = join(root, "external");
	await mkdir(join(external, "subdir"), { recursive: true });
	await writeFile(join(external, "outside.txt"), "OUTSIDE", "utf8");
	await writeFile(join(external, "subdir", "outside-name.txt"), "OUTSIDE", "utf8");
	await symlink(external, join(snapshotPath, "escape"));

	const state = cachedState(snapshotPath);
	await assert.rejects(listRepoSnapshot(state, "escape"), UnsafeRepoPathError);
	await assert.rejects(listRepoSnapshot(state, "escape/subdir"), UnsafeRepoPathError);
	await assert.rejects(readSnapshotTextFile(snapshotPath, "escape/outside.txt"), UnsafeRepoPathError);
});

test("keeps legitimate snapshot files, directories, spaces and internal symlinks", async () => {
	const repo = { owner: "fixture", name: "legitimate" };
	const snapshotPath = await seedSnapshot(repo, {
		"docs folder/read me.txt": "SPACED CONTENT",
		"src/nested/file.ts": "export const x = 1;\n",
	});
	await symlink(join(snapshotPath, "src/nested/file.ts"), join(snapshotPath, "link.txt"));
	const state = cachedState(snapshotPath);

	assert.equal(await readSnapshotTextFile(snapshotPath, "docs folder/read me.txt"), "SPACED CONTENT");
	assert.equal(await readSnapshotTextFile(snapshotPath, "src/nested/file.ts"), "export const x = 1;\n");
	assert.equal(await readSnapshotTextFile(snapshotPath, "link.txt"), "export const x = 1;\n");
	const nested = await listRepoSnapshot(state, "docs folder");
	assert.match(nested.content[0].text, /read me\.txt/);
	const rootListing = await listRepoSnapshot(state, "");
	assert.doesNotMatch(rootListing.content[0].text, new RegExp(REPO_CACHE_COMPLETE_MARKER));
});

test("rejects NUL and Windows drive-like repository paths", async () => {
	const repo = { owner: "fixture", name: "unsafe-forms" };
	const snapshotPath = await seedSnapshot(repo, { "inside.txt": "INSIDE" });

	for (const unsafePath of ["C:\\Windows\\win.ini", "C:/Windows/win.ini", "c:\\temp", "a\u0000b"]) {
		await assert.rejects(resolveSnapshotPath(snapshotPath, unsafePath), UnsafeRepoPathError, unsafePath);
	}
});

test("a missing snapshot path reports ENOENT, not a containment refusal", async () => {
	const repo = { owner: "fixture", name: "missing" };
	const snapshotPath = await seedSnapshot(repo, { "inside.txt": "INSIDE" });

	await assert.rejects(readSnapshotTextFile(snapshotPath, "missing.txt"), (error: NodeJS.ErrnoException) => {
		assert.equal(error.code, "ENOENT");
		assert.equal(error instanceof UnsafeRepoPathError, false);
		return true;
	});
});

type RenameHook = (from: string, to: string) => Promise<boolean>;

// Lets a test observe or act on production renames; the hook returns true when it handled the call.
function patchRename(hook: RenameHook): () => void {
	const mutableFs = fsp as unknown as { rename: typeof fsp.rename };
	const realRename = mutableFs.rename;
	mutableFs.rename = async function rename(from, to) {
		if (await hook(String(from), String(to))) return;
		return realRename(from, to);
	} as typeof fsp.rename;
	syncBuiltinESMExports();
	return () => {
		mutableFs.rename = realRename;
		syncBuiltinESMExports();
	};
}

async function readSnapshotPointer(cachePath: string): Promise<string | undefined> {
	const pointer = await readJsonFile<{ generation?: unknown }>(`${cachePath}.snapshot.json`);
	return typeof pointer?.generation === "string" ? pointer.generation : undefined;
}

test("a legacy complete snapshot without a pointer is reused", async () => {
	await makeCacheDir();
	const repo = { owner: "fixture", name: "legacy-complete" };
	const snapshotPath = await seedSnapshot(repo, { "legacy.txt": "LEGACY" });
	let downloads = 0;
	globalThis.fetch = async () => {
		downloads++;
		return new Response("unexpected download", { status: 500 });
	};

	const snapshot = await createRepoSnapshot(repo, commit);
	const cached = await getCachedRepoState(repo, commit);

	assert.equal(downloads, 0);
	assert.equal(snapshot.path, snapshotPath);
	assert.equal(cached?.snapshot.path, snapshotPath);
	assert.equal(await readFile(join(snapshot.path, "legacy.txt"), "utf8"), "LEGACY");
	assert.equal(await readSnapshotPointer(getRepoSnapshotPath(repo, commit)), undefined);
});

test("a published snapshot pointer is validated and reused without another download", async () => {
	const root = await makeCacheDir();
	const repo = { owner: "fixture", name: "pointer-reuse" };
	const cachePath = getRepoSnapshotPath(repo, commit);
	const archive = await buildArchive(root, "pointer", { "readme.txt": "POINTER" });
	let downloads = 0;
	globalThis.fetch = async () => {
		downloads++;
		return new Response(archive);
	};

	const created = await createRepoSnapshot(repo, commit);
	assert.equal(downloads, 1);
	assert.equal(basename(created.path).startsWith(`${commit}.snapshot-`), true);
	assert.equal(await readSnapshotPointer(cachePath), basename(created.path));

	const reused = await createRepoSnapshot(repo, commit);
	const cached = await getCachedRepoState(repo, commit);

	assert.equal(downloads, 1);
	assert.equal(reused.path, created.path);
	assert.ok(cached);
	assert.equal(cached.snapshot.path, created.path);
	assert.equal(await readFile(join(created.path, "readme.txt"), "utf8"), "POINTER");
	assert.deepEqual(cached.tree.tree.map(entry => entry.path), ["readme.txt"]);
});

test("a pointer to a generation of another commit is ignored", async () => {
	const root = await makeCacheDir();
	const repo = { owner: "fixture", name: "pointer-foreign" };
	const cachePath = getRepoSnapshotPath(repo, commit);
	const otherCommit = "b".repeat(40);
	const foreignGeneration = join(dirname(cachePath), `${otherCommit}.snapshot-${randomUUID()}`);
	await mkdir(foreignGeneration, { recursive: true });
	await writeFile(join(foreignGeneration, "foreign.txt"), "FOREIGN", "utf8");
	await writeFile(join(foreignGeneration, REPO_CACHE_COMPLETE_MARKER), otherCommit, "utf8");
	await writeJsonFile(`${cachePath}.snapshot.json`, { generation: basename(foreignGeneration) });
	const archive = await buildArchive(root, "fresh", { "fresh.txt": "FRESH" });
	globalThis.fetch = async () => new Response(archive);

	const snapshot = await createRepoSnapshot(repo, commit);

	assert.notEqual(snapshot.path, foreignGeneration);
	assert.equal(await readFile(join(snapshot.path, "fresh.txt"), "utf8"), "FRESH");
	assert.equal(await readFile(join(foreignGeneration, "foreign.txt"), "utf8"), "FOREIGN");
	assert.equal(await readSnapshotPointer(cachePath), basename(snapshot.path));
});

test("a pointer generation that escapes the cache parent is ignored", async () => {
	const root = await makeCacheDir();
	const repo = { owner: "fixture", name: "pointer-escape" };
	const cachePath = getRepoSnapshotPath(repo, commit);
	const escapePath = join(dirname(dirname(cachePath)), "escape");
	await mkdir(escapePath, { recursive: true });
	await writeFile(join(escapePath, "outside.txt"), "OUTSIDE", "utf8");
	await writeFile(join(escapePath, REPO_CACHE_COMPLETE_MARKER), commit, "utf8");
	await writeJsonFile(`${cachePath}.snapshot.json`, { generation: `${commit}.snapshot-../../../escape` });
	const archive = await buildArchive(root, "fresh", { "fresh.txt": "FRESH" });
	globalThis.fetch = async () => new Response(archive);

	const snapshot = await createRepoSnapshot(repo, commit);

	assert.notEqual(snapshot.path, escapePath);
	assert.equal(dirname(snapshot.path), dirname(cachePath));
	assert.equal(await readFile(join(snapshot.path, "fresh.txt"), "utf8"), "FRESH");
	assert.equal(await readFile(join(escapePath, "outside.txt"), "utf8"), "OUTSIDE");
});

test("a pointer to an incomplete generation is ignored", async () => {
	const root = await makeCacheDir();
	const repo = { owner: "fixture", name: "pointer-incomplete" };
	const cachePath = getRepoSnapshotPath(repo, commit);
	const incompleteGeneration = join(dirname(cachePath), `${commit}.snapshot-${randomUUID()}`);
	await mkdir(incompleteGeneration, { recursive: true });
	await writeFile(join(incompleteGeneration, "partial.txt"), "PARTIAL", "utf8");
	await writeJsonFile(`${cachePath}.snapshot.json`, { generation: basename(incompleteGeneration) });
	const archive = await buildArchive(root, "fresh", { "fresh.txt": "FRESH" });
	globalThis.fetch = async () => new Response(archive);

	const snapshot = await createRepoSnapshot(repo, commit);

	assert.notEqual(snapshot.path, incompleteGeneration);
	assert.equal(await readFile(join(snapshot.path, "fresh.txt"), "utf8"), "FRESH");
	assert.equal(await readFile(join(incompleteGeneration, "partial.txt"), "utf8"), "PARTIAL");
});

test("a creator that loses the publication race does not make the winner unreadable", async () => {
	const root = await makeCacheDir();
	const repo = { owner: "fixture", name: "publish-race" };
	const cachePath = getRepoSnapshotPath(repo, commit);
	const winnerArchive = await buildArchive(root, "winner", { "winner.txt": "WINNER" });
	const lateArchive = await buildArchive(root, "late", { "late.txt": "LATE" });
	const legacyMarker = join(cachePath, REPO_CACHE_COMPLETE_MARKER);

	let pauseMarkerCheck = true;
	let interleavings = 0;
	let markerCheckHeld!: () => void;
	const markerCheckReached = new Promise<void>(resolve => { markerCheckHeld = resolve; });
	let resumeMarkerCheck!: () => void;
	const markerCheckGate = new Promise<void>(resolve => { resumeMarkerCheck = resolve; });
	const mutableFs = fsp as unknown as { access: typeof fsp.access };
	const realAccess = mutableFs.access;
	mutableFs.access = async function access(path, ...args) {
		if (path === legacyMarker && pauseMarkerCheck) {
			pauseMarkerCheck = false;
			interleavings++;
			let missingError: unknown;
			try {
				await realAccess(path, ...args);
			} catch (error) {
				missingError = error;
			}
			markerCheckHeld();
			await markerCheckGate;
			if (missingError) throw missingError;
			return;
		}
		return realAccess(path, ...args);
	} as typeof fsp.access;
	syncBuiltinESMExports();

	let downloads = 0;
	globalThis.fetch = async () => {
		downloads++;
		return new Response(downloads === 1 ? winnerArchive : lateArchive);
	};
	try {
		// The late creator has already missed the pointer and pauses on the legacy complete check.
		const late = createRepoSnapshot(repo, commit);
		await markerCheckReached;
		const winner = await createRepoSnapshot(repo, commit);
		assert.deepEqual((await readdir(winner.path)).sort(), [REPO_CACHE_COMPLETE_MARKER, "winner.txt"]);
		assert.equal(await readFile(join(winner.path, "winner.txt"), "utf8"), "WINNER");

		resumeMarkerCheck();
		const lateSnapshot = await late;

		assert.equal(interleavings, 1);
		assert.notEqual(lateSnapshot.path, winner.path);
		assert.equal(await readFile(join(winner.path, "winner.txt"), "utf8"), "WINNER");
		assert.equal(await readFile(join(winner.path, REPO_CACHE_COMPLETE_MARKER), "utf8"), commit);
		assert.equal(await readFile(join(lateSnapshot.path, "late.txt"), "utf8"), "LATE");
		assert.equal(await readFile(join(lateSnapshot.path, REPO_CACHE_COMPLETE_MARKER), "utf8"), commit);
	} finally {
		mutableFs.access = realAccess;
		syncBuiltinESMExports();
	}
});

test("an abandoned legacy snapshot directory stays untouched and does not block a fresh generation", async () => {
	const root = await makeCacheDir();
	const repo = { owner: "fixture", name: "abandoned" };
	const cachePath = getRepoSnapshotPath(repo, commit);
	await mkdir(cachePath, { recursive: true });
	await writeFile(join(cachePath, "partial.txt"), "PARTIAL", "utf8");
	const archive = await buildArchive(root, "fresh", { "fresh.txt": "FRESH" });
	globalThis.fetch = async () => new Response(archive);

	const relocations: string[] = [];
	const restoreRename = patchRename(async from => {
		if (from === cachePath) relocations.push(from);
		return false;
	});
	try {
		const snapshot = await createRepoSnapshot(repo, commit);

		assert.deepEqual(relocations, []);
		assert.notEqual(snapshot.path, cachePath);
		assert.equal(dirname(snapshot.path), dirname(cachePath));
		assert.equal(await readFile(join(snapshot.path, REPO_CACHE_COMPLETE_MARKER), "utf8"), commit);
		assert.equal(await readFile(join(snapshot.path, "fresh.txt"), "utf8"), "FRESH");
		assert.equal(await readFile(join(cachePath, "partial.txt"), "utf8"), "PARTIAL");
		assert.equal(await readSnapshotPointer(cachePath), basename(snapshot.path));
	} finally {
		restoreRename();
	}
});

test("a paused creator neither relocates nor makes unreadable a concurrently published snapshot", async () => {
	const root = await makeCacheDir();
	const repo = { owner: "fixture", name: "publication-interleave" };
	const cachePath = getRepoSnapshotPath(repo, commit);
	const firstArchive = await buildArchive(root, "first", { "first.txt": "FIRST" });
	const secondArchive = await buildArchive(root, "second", { "second.txt": "SECOND" });
	let downloads = 0;
	globalThis.fetch = async () => new Response(downloads++ === 0 ? firstArchive : secondArchive);

	let publications = 0;
	let pauseFirstPublication = true;
	let resolveBarrier!: () => void;
	let rejectBarrier!: (error: Error) => void;
	const barrier = new Promise<void>((resolve, reject) => {
		resolveBarrier = resolve;
		rejectBarrier = reject;
	});
	let resumeFirst!: () => void;
	const gate = new Promise<void>(resolve => { resumeFirst = resolve; });
	const restoreRename = patchRename(async (_from, to) => {
		if (to === cachePath) {
			rejectBarrier(new Error("publication must not target the shared legacy snapshot path"));
			return false;
		}
		if (!to.startsWith(`${cachePath}.snapshot-`)) return false;
		publications++;
		if (!pauseFirstPublication) return false;
		pauseFirstPublication = false;
		resolveBarrier();
		await gate;
		return false;
	});
	try {
		const first = createRepoSnapshot(repo, commit);
		await barrier;

		const second = await createRepoSnapshot(repo, commit);

		// The first creator was paused before its publication rename and the second creator
		// published a pointer while it waited.
		assert.equal(publications, 2);
		assert.equal(await readFile(join(second.path, "second.txt"), "utf8"), "SECOND");
		assert.equal(await readFile(join(second.path, REPO_CACHE_COMPLETE_MARKER), "utf8"), commit);
		assert.equal(await readSnapshotPointer(cachePath), basename(second.path));

		resumeFirst();
		const firstSnapshot = await first;

		assert.notEqual(firstSnapshot.path, second.path);
		assert.equal(await readFile(join(firstSnapshot.path, "first.txt"), "utf8"), "FIRST");
		assert.equal(await readFile(join(second.path, "second.txt"), "utf8"), "SECOND");
		assert.equal(await readFile(join(second.path, REPO_CACHE_COMPLETE_MARKER), "utf8"), commit);
		assert.equal(await readSnapshotPointer(cachePath), basename(firstSnapshot.path));
	} finally {
		restoreRename();
	}
});

test("staging directories are cleaned up after a failed download", async () => {
	await makeCacheDir();
	const repo = { owner: "fixture", name: "failed-download" };
	const cachePath = getRepoSnapshotPath(repo, commit);
	globalThis.fetch = async () => new Response("offline fixture interruption", { status: 503 });

	await assert.rejects(createRepoSnapshot(repo, commit));
	assert.equal(await readSnapshotPointer(cachePath), undefined);
	assert.deepEqual((await readdir(dirname(cachePath))).filter(name => name.startsWith(".tmp-")), []);
});

test("an aborted download publishes no generation", async () => {
	await makeCacheDir();
	const repo = { owner: "fixture", name: "aborted-download" };
	const cachePath = getRepoSnapshotPath(repo, commit);
	globalThis.fetch = async (_input, init) => {
		init?.signal?.throwIfAborted();
		return new Response("unexpected body");
	};
	const controller = new AbortController();
	controller.abort();

	await assert.rejects(createRepoSnapshot(repo, commit, controller.signal), (error: Error) => error.name === "AbortError");

	assert.equal(await pathExists(cachePath), false);
	assert.equal(await readSnapshotPointer(cachePath), undefined);
	assert.deepEqual((await readdir(dirname(cachePath))).filter(name => name.startsWith(".tmp-")), []);
});
