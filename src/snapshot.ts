import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
	readRepoMetadataCache,
	readRepoRefCache,
	readRepoTreeCache,
	writeRepoTreeCache,
} from "./store.ts";
import type { CachedRepoState, GitHubRepo, GitHubTreeEntry, GitHubTreeResponse, RepoSnapshot } from "./types.ts";

const execFileAsync = promisify(execFile);
const repoSnapshotCache = new Map<string, Promise<RepoSnapshot>>();

export async function getCachedRepoState(repo: GitHubRepo, ref?: string): Promise<CachedRepoState | null> {
	const requestedRef = ref?.trim() || (await readRepoMetadataCache(repo))?.defaultBranch;
	if (!requestedRef) return null;
	const refCache = looksLikeCommitSha(requestedRef) ? null : await readRepoRefCache(repo, requestedRef);
	const commit = looksLikeCommitSha(requestedRef) ? requestedRef : refCache?.commit;
	if (!commit) return null;
	const snapshotPath = getRepoSnapshotPath(repo, commit);
	if (!(await pathExists(join(snapshotPath, REPO_CACHE_COMPLETE_MARKER)))) return null;
	const tree = await getOrCreateSnapshotTree(repo, commit, snapshotPath);
	return {
		ref: requestedRef,
		commit,
		tree,
		snapshot: { path: snapshotPath, commit },
		refUpdatedAt: refCache?.updatedAt ?? 0,
	};
}

export async function getRepoStateWithSnapshot(repo: GitHubRepo, ref?: string, signal?: AbortSignal): Promise<CachedRepoState> {
	const cachedState = await getCachedRepoState(repo, ref);
	if (cachedState) return cachedState;
	const requestedRef = await resolveRepoRef(repo, ref);
	const commit = await getRepoCommitSha(repo, requestedRef);
	const snapshot = await getRepoSnapshot(repo, commit, signal);
	const tree = await getOrCreateSnapshotTree(repo, commit, snapshot.path);
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
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
	const target = resolveSnapshotPath(state.snapshot.path, path);
	const stats = await lstat(target);
	if (stats.isFile()) throw new Error(`${path || "/"} is a file. Use repo_read instead.`);
	if (!stats.isDirectory()) throw new Error(`Not a directory: ${path || "/"}`);
	const entries = (await readdir(target, { withFileTypes: true }))
		.filter(entry => !(path === "" && entry.name === REPO_CACHE_COMPLETE_MARKER))
		.map(entry => ({ name: entry.name, type: entry.isDirectory() ? "dir" : "file" }));
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

export async function getOrCreateSnapshotTree(repo: GitHubRepo, commitSha: string, snapshotPath: string): Promise<GitHubTreeResponse> {
	const cachedTree = await readRepoTreeCache(repo, commitSha);
	if (cachedTree) return cachedTree;
	const tree = await generateSnapshotTree(snapshotPath);
	await writeRepoTreeCache(repo, commitSha, tree);
	return tree;
}

export async function generateSnapshotTree(snapshotPath: string): Promise<GitHubTreeResponse> {
	const tree: GitHubTreeEntry[] = [];
	async function walk(directory: string, relativeDirectory: string): Promise<void> {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
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
	const cachePath = getRepoSnapshotPath(repo, commitSha);
	const markerPath = join(cachePath, REPO_CACHE_COMPLETE_MARKER);
	if (await pathExists(markerPath)) {
		return { path: cachePath, commit: commitSha };
	}
	await mkdir(dirname(cachePath), { recursive: true });
	if (await pathExists(cachePath)) {
		await rm(cachePath, { recursive: true, force: true });
	}
	const tempDir = await mkdtemp(join(dirname(cachePath), `.tmp-${commitSha}-`));
	const archivePath = join(tempDir, "repo.tar.gz");
	const extractPath = join(tempDir, "snapshot");
	try {
		await mkdir(extractPath, { recursive: true });
		await downloadRepoArchive(repo, commitSha, archivePath, signal);
		await execFileAsync("tar", ["-xzf", archivePath, "-C", extractPath, "--strip-components=1"]);
		await writeFile(join(extractPath, REPO_CACHE_COMPLETE_MARKER), commitSha, "utf8");
		try {
			await rename(extractPath, cachePath);
		} catch (error) {
			if (await pathExists(markerPath)) {
				const existingSnapshot = { path: cachePath, commit: commitSha };
				await getOrCreateSnapshotTree(repo, commitSha, existingSnapshot.path).catch(() => undefined);
				return existingSnapshot;
			}
			throw error;
		}
		const snapshot = { path: cachePath, commit: commitSha };
		await getOrCreateSnapshotTree(repo, commitSha, snapshot.path).catch(() => undefined);
		return snapshot;
	} finally {
		await rm(tempDir, { recursive: true, force: true });
	}
}

export async function downloadRepoArchive(repo: GitHubRepo, ref: string, archivePath: string, signal?: AbortSignal): Promise<void> {
	const response = await githubFetch(
		`/repos/${repo.owner}/${repo.name}/tarball/${encodeURIComponent(ref)}`,
		"application/vnd.github+json",
		undefined,
		signal,
	);
	if (!response.body) throw new Error("GitHub archive response had no body.");
	await pipeline(Readable.fromWeb(response.body as never), createWriteStream(archivePath));
}

export async function readSnapshotTextFile(snapshotPath: string, repoPath: string): Promise<string | null> {
	const absolutePath = resolveSnapshotPath(snapshotPath, repoPath);
	const stats = await lstat(absolutePath);
	if (!stats.isFile()) return null;
	return await readFile(absolutePath, "utf8");
}

export function resolveSnapshotPath(snapshotPath: string, repoPath: string): string {
	const absoluteRoot = resolve(snapshotPath);
	const absolutePath = resolve(absoluteRoot, ...repoPath.split("/"));
	if (absolutePath !== absoluteRoot && !absolutePath.startsWith(`${absoluteRoot}${sep}`)) {
		throw new Error(`Unsafe repository path: ${repoPath}`);
	}
	return absolutePath;
}
