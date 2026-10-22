import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GITHUB_API_URL, GITHUB_API_VERSION } from "./constants.ts";
import { encodePath, normalizeRepoPath } from "./path-utils.ts";
import {
	readRepoMetadataCache,
	readRepoTreeCache,
	writeRepoMetadataCache,
	writeRepoRefCache,
	writeRepoTreeCache,
	looksLikeCommitSha,
} from "./store.ts";
import type {
	GitHubCommitResponse,
	GitHubContentFile,
	GitHubContentObject,
	GitHubRepo,
	GitHubRepoLocator,
	GitHubRepoMetadata,
	GitHubTreeResponse,
} from "./types.ts";

const execFileAsync = promisify(execFile);

const repoMetadataCache = new Map<string, Promise<GitHubRepoMetadata>>();
const repoTreeCache = new Map<string, Promise<{ ref: string; tree: GitHubTreeResponse }>>();
const repoFileCache = new Map<string, Promise<string>>();
const repoCommitCache = new Map<string, Promise<string>>();
let cachedGitHubToken: Promise<string | null> | null = null;

export function throwIfAborted(signal?: AbortSignal): void {
	signal?.throwIfAborted();
}

function cachePromise<T>(cache: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> {
	const existing = cache.get(key);
	if (existing) return existing;
	const pending = create();
	cache.set(key, pending);
	void pending.catch(() => {
		if (cache.get(key) === pending) cache.delete(key);
	});
	return pending;
}

export async function githubFetch(
	path: string,
	accept = "application/vnd.github+json",
	explicitToken?: string,
	signal?: AbortSignal,
): Promise<Response> {
	throwIfAborted(signal);
	const token = explicitToken ?? (await getGitHubToken());
	const headers: Record<string, string> = {
		Accept: accept,
		"X-GitHub-Api-Version": GITHUB_API_VERSION,
		"User-Agent": "pi-repos",
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	const url = path.startsWith("http://") || path.startsWith("https://") ? path : `${GITHUB_API_URL}${path}`;
	const response = await fetch(url, { headers, signal });
	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(formatGitHubApiError(response, errorText));
	}
	return response;
}

export async function githubJson<T>(
	path: string,
	accept = "application/vnd.github+json",
	explicitToken?: string,
	signal?: AbortSignal,
): Promise<T> {
	const response = await githubFetch(path, accept, explicitToken, signal);
	return (await response.json()) as T;
}

export function formatGitHubApiError(response: Response, body: string): string {
	const message = extractGitHubMessage(body);
	const reset = response.headers.get("x-ratelimit-reset");
	const remaining = response.headers.get("x-ratelimit-remaining");
	const resetHint = reset ? ` Resets at ${new Date(Number(reset) * 1000).toISOString()}.` : "";
	const authHint = " Set GITHUB_TOKEN/GH_TOKEN or run `gh auth login` for higher limits and private repository access.";
	if (response.status === 401) {
		return `GitHub API authentication failed (401): ${message}.${authHint}`;
	}
	if (response.status === 403 && (remaining === "0" || /rate limit/i.test(message))) {
		return `GitHub API rate limit exceeded (403): ${message}.${resetHint}${authHint}`;
	}
	if (response.status === 403) {
		return `GitHub API request forbidden (403): ${message}.${authHint}`;
	}
	if (response.status === 404) {
		return `GitHub repository or path not found (404): ${message}. If this is private, authenticate with GITHUB_TOKEN/GH_TOKEN or gh auth login.`;
	}
	if (response.status === 422) {
		return `GitHub API rejected the query (422): ${message}. Check repository, ref, path, and search qualifiers.`;
	}
	return `GitHub API request failed (${response.status} ${response.statusText}): ${message}`;
}

export function extractGitHubMessage(body: string): string {
	try {
		const parsed = JSON.parse(body) as { message?: unknown; errors?: unknown };
		const message = typeof parsed.message === "string" ? parsed.message : body.trim();
		if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
			return `${message} ${JSON.stringify(parsed.errors).slice(0, 1000)}`;
		}
		return message || "No error body returned";
	} catch {
		return body.trim() || "No error body returned";
	}
}

export async function getGitHubToken(): Promise<string | null> {
	const envToken =
		process.env.GITHUB_TOKEN?.trim() ||
		process.env.GH_TOKEN?.trim() ||
		process.env.GITHUB_PAT?.trim() ||
		process.env.GITHUB_PERSONAL_ACCESS_TOKEN?.trim();
	if (envToken) return envToken;
	if (!cachedGitHubToken) {
		cachedGitHubToken = execFileAsync("gh", ["auth", "token"])
			.then(result => result.stdout.trim() || null)
			.catch(() => null);
	}
	return cachedGitHubToken;
}

export function parseRepoInput(input: string): GitHubRepo {
	return parseRepoLocatorInput(input).repo;
}

const UNSAFE_REPO_SEGMENT_CHARS = /[/\\\u0000-\u001f]/;

function validateRepoSegment(segment: string, input: string): string {
	if (!segment || segment === "." || segment === ".." || UNSAFE_REPO_SEGMENT_CHARS.test(segment)) {
		throw new Error(`Invalid repository identifier: ${input}`);
	}
	return segment;
}

export function parseRepoLocatorInput(input: string): GitHubRepoLocator {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Repository is required.");
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
		const url = new URL(trimmed);
		if (url.hostname !== "github.com") {
			throw new Error(`Unsupported repository host: ${url.hostname}`);
		}
		let parts: string[];
		try {
			parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
		} catch {
			throw new Error(`Invalid GitHub repository URL: ${input}`);
		}
		if (parts.length < 2) throw new Error(`Invalid GitHub repository URL: ${input}`);
		const repo = {
			owner: validateRepoSegment(parts[0], input),
			name: validateRepoSegment(parts[1].replace(/\.git$/, ""), input),
		};
		const urlKind = parts[2];
		if (urlKind === "blob" || urlKind === "tree") {
			const { ref, path } = parseGitHubUrlRefAndPath(parts.slice(3));
			return { repo, ref, path, urlKind };
		}
		if (urlKind === "commit" && parts[3]) {
			return { repo, ref: parts[3], urlKind };
		}
		return { repo };
	}
	const [ownerInput, nameInput] = trimmed.split("/");
	const owner = validateRepoSegment(ownerInput ?? "", input);
	const name = validateRepoSegment((nameInput ?? "").replace(/\.git$/, ""), input);
	return { repo: { owner, name } };
}

export function parseGitHubUrlRefAndPath(parts: string[]): { ref?: string; path?: string } {
	if (parts.length === 0) return {};
	const ref = parts[0];
	const path = parts.slice(1).join("/");
	return { ref, path: path || undefined };
}

export function repoKey(repo: GitHubRepo): string {
	return `${repo.owner}/${repo.name}`;
}

export async function getRepoMetadata(repo: GitHubRepo, signal?: AbortSignal): Promise<GitHubRepoMetadata> {
	if (signal) return fetchRepoMetadata(repo, signal);
	return cachePromise(repoMetadataCache, repoKey(repo), () => fetchRepoMetadata(repo));
}

async function fetchRepoMetadata(repo: GitHubRepo, signal?: AbortSignal): Promise<GitHubRepoMetadata> {
	const metadata = await githubJson<GitHubRepoMetadata>(`/repos/${repo.owner}/${repo.name}`, undefined, undefined, signal);
	void writeRepoMetadataCache(repo, metadata.default_branch);
	return metadata;
}

export async function resolveRepoRef(repo: GitHubRepo, ref?: string, signal?: AbortSignal): Promise<string> {
	throwIfAborted(signal);
	if (ref?.trim()) return ref.trim();
	const cachedMetadata = await readRepoMetadataCache(repo);
	if (cachedMetadata?.defaultBranch) return cachedMetadata.defaultBranch;
	const metadata = await getRepoMetadata(repo, signal);
	return metadata.default_branch;
}

export async function getRepoTree(repo: GitHubRepo, ref?: string, signal?: AbortSignal): Promise<{ ref: string; tree: GitHubTreeResponse }> {
	throwIfAborted(signal);
	const resolvedRef = await resolveRepoRef(repo, ref, signal);
	if (signal) return fetchRepoTree(repo, resolvedRef, signal);
	return cachePromise(repoTreeCache, `${repoKey(repo)}@${resolvedRef}`, () => fetchRepoTree(repo, resolvedRef));
}

async function fetchRepoTree(repo: GitHubRepo, resolvedRef: string, signal?: AbortSignal): Promise<{ ref: string; tree: GitHubTreeResponse }> {
	const cachedTree = await readRepoTreeCache(repo, resolvedRef);
	if (cachedTree) return { ref: resolvedRef, tree: cachedTree };
	const tree = await githubJson<GitHubTreeResponse>(
		`/repos/${repo.owner}/${repo.name}/git/trees/${encodeURIComponent(resolvedRef)}?recursive=1`,
		undefined,
		undefined,
		signal,
	);
	if (looksLikeCommitSha(resolvedRef)) void writeRepoTreeCache(repo, resolvedRef, tree);
	return { ref: resolvedRef, tree };
}

export async function getRepoFileText(repo: GitHubRepo, ref: string, path: string, signal?: AbortSignal): Promise<string> {
	throwIfAborted(signal);
	const normalizedPath = normalizeRepoPath(path);
	if (signal) return fetchRepoFileText(repo, ref, normalizedPath, signal);
	return cachePromise(repoFileCache, `${repoKey(repo)}@${ref}:${normalizedPath}`, () => fetchRepoFileText(repo, ref, normalizedPath));
}

async function fetchRepoFileText(repo: GitHubRepo, ref: string, normalizedPath: string, signal?: AbortSignal): Promise<string> {
	const contentsPath = `/repos/${repo.owner}/${repo.name}/contents/${encodePath(normalizedPath)}?ref=${encodeURIComponent(ref)}`;
	const result = await githubJson<GitHubContentFile | GitHubContentObject>(
		contentsPath,
		"application/vnd.github.object+json",
		undefined,
		signal,
	);
	const file = result as GitHubContentFile;
	if (file.type !== "file") {
		throw new Error(`${normalizedPath} is not a file.`);
	}
	if (typeof file.content === "string" && file.content.length > 0 && file.encoding === "base64") {
		return Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8");
	}
	if (file.size === 0) return "";
	// Files above 1 MB have no inline content; re-read the same endpoint as raw text.
	const rawResponse = await githubFetch(contentsPath, "application/vnd.github.raw", undefined, signal);
	return rawResponse.text();
}

export async function getRepoCommitSha(repo: GitHubRepo, ref: string, signal?: AbortSignal): Promise<string> {
	if (signal) return fetchRepoCommitSha(repo, ref, signal);
	return cachePromise(repoCommitCache, `${repoKey(repo)}@${ref}`, () => fetchRepoCommitSha(repo, ref));
}

export async function fetchRepoCommitSha(repo: GitHubRepo, ref: string, signal?: AbortSignal): Promise<string> {
	throwIfAborted(signal);
	const commit = await githubJson<GitHubCommitResponse>(
		`/repos/${repo.owner}/${repo.name}/commits/${encodeURIComponent(ref)}`,
		undefined,
		undefined,
		signal,
	);
	await writeRepoRefCache(repo, ref, commit.sha);
	repoCommitCache.set(`${repoKey(repo)}@${ref}`, Promise.resolve(commit.sha));
	return commit.sha;
}
