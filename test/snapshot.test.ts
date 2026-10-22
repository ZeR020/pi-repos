import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { REPO_CACHE_COMPLETE_MARKER } from "../src/constants.ts";
import {
	createRepoSnapshot,
	listRepoSnapshot,
	readSnapshotTextFile,
	resolveSnapshotPath,
	UnsafeRepoPathError,
} from "../src/snapshot.ts";
import { getRepoSnapshotPath, pathExists } from "../src/store.ts";
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

test("a creator that loses the publication race reuses the concurrent snapshot", async () => {
	const root = await makeCacheDir();
	const repo = { owner: "fixture", name: "publish-race" };
	const winnerArchive = await buildArchive(root, "winner", { "winner.txt": "WINNER" });
	const lateArchive = await buildArchive(root, "late", { "late.txt": "LATE" });
	const raceMarker = join(getRepoSnapshotPath(repo, commit), REPO_CACHE_COMPLETE_MARKER);

	let pauseMarkerCheck = true;
	let markerCheckHeld!: () => void;
	const markerCheckReached = new Promise<void>(resolve => { markerCheckHeld = resolve; });
	let resumeMarkerCheck!: () => void;
	const markerCheckGate = new Promise<void>(resolve => { resumeMarkerCheck = resolve; });
	const mutableFs = fsp as unknown as { access: typeof fsp.access };
	const realAccess = mutableFs.access;
	mutableFs.access = async function access(path, ...args) {
		if (path === raceMarker && pauseMarkerCheck) {
			pauseMarkerCheck = false;
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
		const late = createRepoSnapshot(repo, commit);
		await markerCheckReached;
		const winner = await createRepoSnapshot(repo, commit);
		assert.deepEqual((await readdir(winner.path)).sort(), [REPO_CACHE_COMPLETE_MARKER, "winner.txt"]);

		resumeMarkerCheck();
		const lateSnapshot = await late;
		assert.deepEqual((await readdir(lateSnapshot.path)).sort(), [REPO_CACHE_COMPLETE_MARKER, "winner.txt"]);
		assert.equal(await readFile(join(lateSnapshot.path, "winner.txt"), "utf8"), "WINNER");
		assert.equal(await readFile(join(lateSnapshot.path, REPO_CACHE_COMPLETE_MARKER), "utf8"), commit);
	} finally {
		mutableFs.access = realAccess;
		syncBuiltinESMExports();
	}
});

test("an abandoned incomplete snapshot directory does not block creation", async () => {
	const root = await makeCacheDir();
	const repo = { owner: "fixture", name: "abandoned" };
	const snapshotPath = getRepoSnapshotPath(repo, commit);
	await mkdir(snapshotPath, { recursive: true });
	await writeFile(join(snapshotPath, "partial.txt"), "PARTIAL", "utf8");
	const archive = await buildArchive(root, "fresh", { "fresh.txt": "FRESH" });
	globalThis.fetch = async () => new Response(archive);

	const snapshot = await createRepoSnapshot(repo, commit);

	assert.equal(await readFile(join(snapshot.path, REPO_CACHE_COMPLETE_MARKER), "utf8"), commit);
	assert.equal(await readFile(join(snapshot.path, "fresh.txt"), "utf8"), "FRESH");
	assert.equal(await pathExists(join(snapshot.path, "partial.txt")), false);
});

test("staging directories are cleaned up after a failed download", async () => {
	const root = await makeCacheDir();
	const repo = { owner: "fixture", name: "failed-download" };
	globalThis.fetch = async () => new Response("offline fixture interruption", { status: 503 });

	await assert.rejects(createRepoSnapshot(repo, commit));
	const cacheBase = dirname(getRepoSnapshotPath(repo, commit));
	const leftovers = (await readdir(cacheBase)).filter(name => name.startsWith(".tmp-"));
	assert.deepEqual(leftovers, []);
});
