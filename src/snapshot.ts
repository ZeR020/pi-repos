import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
	REPO_CACHE_COMPLETE_MARKER,
} from "./constants.ts";
import { fetchRepoCommitSha, getRepoCommitSha, githubFetch, repoKey, resolveRepoRef } from "./github.ts";
import { formatDirectoryListOutput } from "./output.ts";
import { compareCaseInsensitive, stripUndefined } from "./path-utils.ts";
import {
	getRefRefreshMs,
	getRepoSnapshotPath,
	looksLikeCommitSha,
	pathExists,
	readJsonFile,
	readRepoMetadataCache,
	readRepoRefCache,
	readRepoTreeCache,
	writeJsonFile,
	writeRepoTreeCache,
} from "./store.ts";
import type { CachedRepoState, GitHubRepo, GitHubTreeEntry, GitHubTreeResponse, RepoSnapshot } from "./types.ts";

const execFileAsync = promisify(execFile);
const repoSnapshotCache = new Map<string, Promise<RepoSnapshot>>();
const SNAPSHOT_POINTER_SUFFIX = ".snapshot.json";
const SNAPSHOT_GENERATION_INFIX = ".snapshot-";
const SNAPSHOT_GENERATION_SUFFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getCachedRepoState(repo: GitHubRepo, ref?: string, signal?: AbortSignal): Promise<CachedRepoState | null> {
	signal?.throwIfAborted();
	const requestedRef = ref?.trim() || (await readRepoMetadataCache(repo))?.defaultBranch;
	if (!requestedRef) return null;
	const refCache = looksLikeCommitSha(requestedRef) ? null : await readRepoRefCache(repo, requestedRef);
	const commit = looksLikeCommitSha(requestedRef) ? requestedRef : refCache?.commit;
	if (!commit) return null;
	const cachePath = getRepoSnapshotPath(repo, commit);
	const snapshotPath = await findCompleteSnapshotPath(commit, cachePath);
	if (!snapshotPath) return null;
	const tree = await getOrCreateSnapshotTree(repo, commit, snapshotPath, signal);
	return {
		ref: requestedRef,
		commit,
		tree,
		snapshot: { path: snapshotPath, commit },
		refUpdatedAt: refCache?.updatedAt ?? 0,
	};
}

export async function getRepoStateWithSnapshot(repo: GitHubRepo, ref?: string, signal?: AbortSignal): Promise<CachedRepoState> {
	const cachedState = await getCachedRepoState(repo, ref, signal);
	if (cachedState) return cachedState;
	const requestedRef = await resolveRepoRef(repo, ref, signal);
	const commit = await getRepoCommitSha(repo, requestedRef, signal);
	const snapshot = await getRepoSnapshot(repo, commit, signal);
	const tree = await getOrCreateSnapshotTree(repo, commit, snapshot.path, signal);
	return { ref: requestedRef, commit, tree, snapshot, refUpdatedAt: Date.now() };
}

export function prefetchRepoSnapshot(repo: GitHubRepo, ref?: string, options: { forceRefresh?: boolean } = {}): void {
	void (async () => {
		const requestedRef = await resolveRepoRef(repo, ref);
		const commit = options.forceRefresh ? await fetchRepoCommitSha(repo, requestedRef) : await getRepoCommitSha(repo, requestedRef);
		const snapshot = await getRepoSnapshot(repo, commit);
		await getOrCreateSnapshotTree(repo, commit, snapshot.path);
	})().catch(() => undefined);
}

export function refreshCachedRepoStateInBackground(repo: GitHubRepo, state: CachedRepoState): void {
	if (looksLikeCommitSha(state.ref)) return;
	if (Date.now() - state.refUpdatedAt < getRefRefreshMs()) return;
	prefetchRepoSnapshot(repo, state.ref, { forceRefresh: true });
}

export async function listRepoSnapshot(
	state: CachedRepoState,
	path: string,
	limit?: number,
	signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
	signal?.throwIfAborted();
	const target = await resolveSnapshotPath(state.snapshot.path, path);
	const stats = await lstat(target);
	if (stats.isFile()) throw new Error(`${path || "/"} is a file. Use repo_read instead.`);
	if (!stats.isDirectory()) throw new Error(`Not a directory: ${path || "/"}`);
	const entries = (await readdir(target, { withFileTypes: true }))
		.filter(entry => !(path === "" && entry.name === REPO_CACHE_COMPLETE_MARKER))
		.map(entry => ({ name: entry.name, type: entry.isDirectory() ? "dir" : "file" }));
	signal?.throwIfAborted();
	const output = formatDirectoryListOutput(entries, limit);
	return {
		content: [{ type: "text", text: output.text }],
		details: stripUndefined({
			backend: "github-archive-cache",
			path: path || "/",
			ref: state.ref,
			commit: state.commit,
			count: output.count,
			entryLimitReached: output.entryLimitReached,
			truncation: output.truncation,
		}),
	};
}

export async function getRepoSnapshot(repo: GitHubRepo, commitSha: string, signal?: AbortSignal): Promise<RepoSnapshot> {
	signal?.throwIfAborted();
	if (signal) return createRepoSnapshot(repo, commitSha, signal);
	const key = `${repoKey(repo)}@${commitSha}`;
	let cached = repoSnapshotCache.get(key);
	if (!cached) {
		cached = createRepoSnapshot(repo, commitSha, signal).catch(error => {
			repoSnapshotCache.delete(key);
			throw error;
		});
		repoSnapshotCache.set(key, cached);
	}
	return cached;
}

export async function getOrCreateSnapshotTree(repo: GitHubRepo, commitSha: string, snapshotPath: string, signal?: AbortSignal): Promise<GitHubTreeResponse> {
	signal?.throwIfAborted();
	const cachedTree = await readRepoTreeCache(repo, commitSha);
	signal?.throwIfAborted();
	if (cachedTree) return cachedTree;
	const tree = await generateSnapshotTree(snapshotPath, signal);
	await writeRepoTreeCache(repo, commitSha, tree);
	return tree;
}

export async function generateSnapshotTree(snapshotPath: string, signal?: AbortSignal): Promise<GitHubTreeResponse> {
	const tree: GitHubTreeEntry[] = [];
	async function walk(directory: string, relativeDirectory: string): Promise<void> {
		signal?.throwIfAborted();
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			signal?.throwIfAborted();
			if (!relativeDirectory && entry.name === REPO_CACHE_COMPLETE_MARKER) continue;
			const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				tree.push({ path: relativePath, type: "tree" });
				await walk(join(directory, entry.name), relativePath);
			} else {
				tree.push({ path: relativePath, type: "blob" });
			}
		}
	}
	await walk(snapshotPath, "");
	tree.sort((left, right) => compareCaseInsensitive(left.path, right.path));
	return { truncated: false, tree };
}

export async function createRepoSnapshot(repo: GitHubRepo, commitSha: string, signal?: AbortSignal): Promise<RepoSnapshot> {
	signal?.throwIfAborted();
	const cachePath = getRepoSnapshotPath(repo, commitSha);
	const publishedPath = await findCompleteSnapshotPath(commitSha, cachePath);
	if (publishedPath) return { path: publishedPath, commit: commitSha };
	await mkdir(dirname(cachePath), { recursive: true });
	const tempDir = await mkdtemp(join(dirname(cachePath), `.tmp-${commitSha}-`));
	const archivePath = join(tempDir, "repo.tar.gz");
	const extractPath = join(tempDir, "snapshot");
	try {
		await mkdir(extractPath, { recursive: true });
		await downloadRepoArchive(repo, commitSha, archivePath, signal);
		await execFileAsync("tar", ["-xzf", archivePath, "-C", extractPath, "--strip-components=1"], { signal });
		signal?.throwIfAborted();
		await writeCompleteMarker(extractPath, commitSha);
		const snapshot = await publishSnapshot(commitSha, extractPath, cachePath);
		await getOrCreateSnapshotTree(repo, commitSha, snapshot.path, signal).catch(error => {
			if (signal?.aborted) throw error;
		});
		return snapshot;
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

async function isCompleteSnapshot(cachePath: string): Promise<boolean> {
	return pathExists(join(cachePath, REPO_CACHE_COMPLETE_MARKER));
}

// The marker name is reserved by the cache: an archive entry, directory, or symlink must not
// receive or redirect it, and O_EXCL never follows a symlink.
async function writeCompleteMarker(extractPath: string, commitSha: string): Promise<void> {
	const markerPath = join(extractPath, REPO_CACHE_COMPLETE_MARKER);
	await rm(markerPath, { recursive: true, force: true });
	await writeFile(markerPath, commitSha, { encoding: "utf8", flag: "wx" });
}

// Publication only renames a completed extraction into a fresh sibling generation; the shared
// cachePath is never moved or removed, so every returned snapshot stays readable.
async function publishSnapshot(commitSha: string, extractPath: string, cachePath: string): Promise<RepoSnapshot> {
	const generation = `${commitSha}${SNAPSHOT_GENERATION_INFIX}${randomUUID()}`;
	await rename(extractPath, join(dirname(cachePath), generation));
	await writeJsonFile(getSnapshotPointerPath(cachePath), { generation });
	const publishedPath = await findCompleteSnapshotPath(commitSha, cachePath);
	if (!publishedPath) throw new Error(`Snapshot publication left no readable generation: ${cachePath}`);
	return { path: publishedPath, commit: commitSha };
}

// The pointer names one sibling generation directory. Accept only a complete generation whose
// name belongs to this commit and cache parent, then fall back to the pre-pointer cachePath.
async function findCompleteSnapshotPath(commitSha: string, cachePath: string): Promise<string | null> {
	const pointer = await readJsonFile<{ generation?: unknown }>(getSnapshotPointerPath(cachePath));
	const generation = pointer?.generation;
	if (isSnapshotGenerationFor(commitSha, generation)) {
		const generationPath = join(dirname(cachePath), generation);
		if (await isCompleteSnapshot(generationPath)) return generationPath;
	}
	return (await isCompleteSnapshot(cachePath)) ? cachePath : null;
}

function getSnapshotPointerPath(cachePath: string): string {
	return `${cachePath}${SNAPSHOT_POINTER_SUFFIX}`;
}

function isSnapshotGenerationFor(commitSha: string, generation: unknown): generation is string {
	if (typeof generation !== "string" || /[\\/]/.test(generation)) return false;
	const prefix = `${commitSha}${SNAPSHOT_GENERATION_INFIX}`;
	return generation.startsWith(prefix) && SNAPSHOT_GENERATION_SUFFIX.test(generation.slice(prefix.length));
}

export async function downloadRepoArchive(repo: GitHubRepo, ref: string, archivePath: string, signal?: AbortSignal): Promise<void> {
	const response = await githubFetch(
		`/repos/${repo.owner}/${repo.name}/tarball/${encodeURIComponent(ref)}`,
		"application/vnd.github+json",
		undefined,
		signal,
	);
	if (!response.body) throw new Error("GitHub archive response had no body.");
	await pipeline(Readable.fromWeb(response.body as never), createWriteStream(archivePath), { signal });
}

export async function readSnapshotTextFile(snapshotPath: string, repoPath: string): Promise<string | null> {
	const absolutePath = await resolveSnapshotPath(snapshotPath, repoPath);
	const stats = await lstat(absolutePath);
	if (!stats.isFile()) return null;
	return await readFile(absolutePath, "utf8");
}

export class UnsafeRepoPathError extends Error {
	constructor(repoPath: string) {
		super(`Unsafe repository path: ${repoPath}`);
		this.name = "UnsafeRepoPathError";
	}
}

// Rejects tool paths that must never reach filesystem resolution: NUL bytes, Windows
// drive/UNC forms, and parent traversal. Lexical and canonical containment then pin the
// result inside the snapshot even through intermediate symlinks.
export async function resolveSnapshotPath(snapshotPath: string, repoPath: string): Promise<string> {
	if (hasForbiddenRepoPathForm(repoPath)) throw new UnsafeRepoPathError(repoPath);
	const absoluteRoot = await realpath(resolve(snapshotPath));
	const absolutePath = resolve(absoluteRoot, ...repoPath.split("/"));
	if (!isInsideSnapshot(absoluteRoot, absolutePath)) throw new UnsafeRepoPathError(repoPath);
	const canonicalPath = await realpath(absolutePath);
	if (!isInsideSnapshot(absoluteRoot, canonicalPath)) throw new UnsafeRepoPathError(repoPath);
	return canonicalPath;
}

function hasForbiddenRepoPathForm(repoPath: string): boolean {
	return repoPath.includes("\0") || /^([A-Za-z]:[\\/]|\\\\)/.test(repoPath) || repoPath.split("/").includes("..");
}

function isInsideSnapshot(absoluteRoot: string, candidatePath: string): boolean {
	return candidatePath === absoluteRoot || candidatePath.startsWith(`${absoluteRoot}${sep}`);
}
