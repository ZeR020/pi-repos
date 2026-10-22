import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	DEFAULT_REF_REFRESH_MS,
	REPO_METADATA_FILE,
	REPO_REFS_DIR,
	REPO_TREES_DIR,
} from "./constants.ts";
import type { GitHubRepo, GitHubTreeResponse, RepoMetadataCache, RepoRefCache, RepoTreeCache } from "./types.ts";

export async function readRepoMetadataCache(repo: GitHubRepo): Promise<RepoMetadataCache | null> {
	return await readJsonFile<RepoMetadataCache>(getRepoMetadataPath(repo));
}

export async function writeRepoMetadataCache(repo: GitHubRepo, defaultBranch: string): Promise<void> {
	await writeJsonFile(getRepoMetadataPath(repo), { defaultBranch, updatedAt: Date.now() });
}

export async function readRepoRefCache(repo: GitHubRepo, ref: string): Promise<RepoRefCache | null> {
	const cached = await readJsonFile<RepoRefCache>(getRepoRefCachePath(repo, ref));
	if (cached?.ref !== ref || !cached.commit) return null;
	return cached;
}

export async function writeRepoRefCache(repo: GitHubRepo, ref: string, commit: string): Promise<void> {
	await writeJsonFile(getRepoRefCachePath(repo, ref), { ref, commit, updatedAt: Date.now() });
}

export async function readRepoTreeCache(repo: GitHubRepo, commit: string): Promise<GitHubTreeResponse | null> {
	if (!looksLikeCommitSha(commit)) return null;
	const cached = await readJsonFile<RepoTreeCache>(getRepoTreeCachePath(repo, commit));
	if (cached?.commit !== commit || !Array.isArray(cached.tree?.tree)) return null;
	return cached.tree;
}

export async function writeRepoTreeCache(repo: GitHubRepo, commit: string, tree: GitHubTreeResponse): Promise<void> {
	if (!looksLikeCommitSha(commit)) return;
	await writeJsonFile(getRepoTreeCachePath(repo, commit), { commit, tree, updatedAt: Date.now() });
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return null;
	}
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(value)}\n`, "utf8");
	await rename(tempPath, path);
}

export function getRepoSnapshotPath(repo: GitHubRepo, commitSha: string): string {
	return join(getRepoCacheBase(repo), commitSha);
}

export function getRepoMetadataPath(repo: GitHubRepo): string {
	return join(getRepoCacheBase(repo), REPO_METADATA_FILE);
}

export function getRepoRefCachePath(repo: GitHubRepo, ref: string): string {
	return join(getRepoCacheBase(repo), REPO_REFS_DIR, `${Buffer.from(ref).toString("base64url")}.json`);
}

export function getRepoTreeCachePath(repo: GitHubRepo, commit: string): string {
	return join(getRepoCacheBase(repo), REPO_TREES_DIR, `${commit}.json`);
}

export function getRepoCacheBase(repo: GitHubRepo): string {
	return join(getRepoCacheRoot(), "github", safeCacheSegment(repo.owner), safeCacheSegment(repo.name));
}

export function getRepoCacheRoot(): string {
	const configured = process.env.PI_REPOS_CACHE_DIR?.trim();
	if (!configured) return join(homedir(), ".cache", "pi-repos");
	if (configured === "~") return homedir();
	if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
	return configured;
}

export function getRefRefreshMs(): number {
	const value = Number(process.env.PI_REPOS_REF_REFRESH_MS);
	return Number.isFinite(value) && value >= 0 ? value : DEFAULT_REF_REFRESH_MS;
}

export function looksLikeCommitSha(value: string): boolean {
	return /^[0-9a-f]{40}$/i.test(value);
}

export function safeCacheSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function pathExists(path: string): Promise<boolean> {
	return access(path).then(() => true).catch(() => false);
}
