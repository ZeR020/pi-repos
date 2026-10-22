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

export async function githubFetch(
	path: string,
	accept = "application/vnd.github+json",
	explicitToken?: string,
	signal?: AbortSignal,
): Promise<Response> {
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

export async function githubJson<T>(path: string, accept = "application/vnd.github+json", explicitToken?: string): Promise<T> {
	const response = await githubFetch(path, accept, explicitToken);
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

export function parseRepoLocatorInput(input: string): GitHubRepoLocator {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Repository is required.");
	if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
		const url = new URL(trimmed);
		if (url.hostname !== "github.com") {
			throw new Error(`Unsupported repository host: ${url.hostname}`);
		}
		const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
		if (parts.length < 2) throw new Error(`Invalid GitHub repository URL: ${input}`);
		const repo = { owner: parts[0], name: parts[1].replace(/\.git$/, "") };
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
	const [owner, name] = trimmed.split("/");
	if (!owner || !name) throw new Error(`Invalid repository identifier: ${input}`);
	return { repo: { owner, name: name.replace(/\.git$/, "") } };
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

export async function getRepoMetadata(repo: GitHubRepo): Promise<GitHubRepoMetadata> {
	const key = repoKey(repo);
	let cached = repoMetadataCache.get(key);
	if (!cached) {
		cached = githubJson<GitHubRepoMetadata>(`/repos/${repo.owner}/${repo.name}`).then(metadata => {
			void writeRepoMetadataCache(repo, metadata.default_branch);
			return metadata;
		});
		repoMetadataCache.set(key, cached);
	}
	return cached;
}

export async function resolveRepoRef(repo: GitHubRepo, ref?: string): Promise<string> {
	if (ref?.trim()) return ref.trim();
	const cachedMetadata = await readRepoMetadataCache(repo);
	if (cachedMetadata?.defaultBranch) return cachedMetadata.defaultBranch;
	const metadata = await getRepoMetadata(repo);
	return metadata.default_branch;
}

export async function getRepoTree(repo: GitHubRepo, ref?: string): Promise<{ ref: string; tree: GitHubTreeResponse }> {
	const resolvedRef = await resolveRepoRef(repo, ref);
	const key = `${repoKey(repo)}@${resolvedRef}`;
	let cached = repoTreeCache.get(key);
	if (!cached) {
		cached = (async () => {
			const cachedTree = await readRepoTreeCache(repo, resolvedRef);
			if (cachedTree) return { ref: resolvedRef, tree: cachedTree };
			const tree = await githubJson<GitHubTreeResponse>(
				`/repos/${repo.owner}/${repo.name}/git/trees/${encodeURIComponent(resolvedRef)}?recursive=1`,
			);
			if (looksLikeCommitSha(resolvedRef)) void writeRepoTreeCache(repo, resolvedRef, tree);
			return { ref: resolvedRef, tree };
		})();
		repoTreeCache.set(key, cached);
	}
	return cached;
}

export async function getRepoFileText(repo: GitHubRepo, ref: string, path: string): Promise<string> {
	const normalizedPath = normalizeRepoPath(path);
	const key = `${repoKey(repo)}@${ref}:${normalizedPath}`;
	let cached = repoFileCache.get(key);
	if (!cached) {
		cached = githubJson<GitHubContentFile | GitHubContentObject>(
			`/repos/${repo.owner}/${repo.name}/contents/${encodePath(normalizedPath)}?ref=${encodeURIComponent(ref)}`,
			"application/vnd.github.object+json",
		).then(async result => {
			const file = result as GitHubContentFile;
			if (file.type !== "file") {
				throw new Error(`${normalizedPath} is not a file.`);
			}
			if (typeof file.content === "string" && file.content.length > 0 && file.encoding === "base64") {
				return Buffer.from(file.content.replace(/\n/g, ""), "base64").toString("utf8");
			}
			if (file.download_url) {
				const response = await fetch(file.download_url);
				if (!response.ok) {
					throw new Error(`Failed to download file contents: ${response.status} ${response.statusText}`);
				}
				return await response.text();
			}
			throw new Error("GitHub did not return readable file contents.");
		});
		repoFileCache.set(key, cached);
	}
	return cached;
}

export async function getRepoCommitSha(repo: GitHubRepo, ref: string): Promise<string> {
	const key = `${repoKey(repo)}@${ref}`;
	let cached = repoCommitCache.get(key);
	if (!cached) {
		cached = fetchRepoCommitSha(repo, ref);
		repoCommitCache.set(key, cached);
	}
	return cached;
}

export async function fetchRepoCommitSha(repo: GitHubRepo, ref: string): Promise<string> {
	const commit = await githubJson<GitHubCommitResponse>(`/repos/${repo.owner}/${repo.name}/commits/${encodeURIComponent(ref)}`);
	await writeRepoRefCache(repo, ref, commit.sha);
	repoCommitCache.set(`${repoKey(repo)}@${ref}`, Promise.resolve(commit.sha));
	return commit.sha;
}
