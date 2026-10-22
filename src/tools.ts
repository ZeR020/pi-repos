import { createReadToolDefinition, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_FIND_LIMIT, DEFAULT_REPO_READ_LIMIT } from "./constants.ts";
import { getRepoCommitSha, getRepoFileText, getRepoTree, githubJson, parseRepoInput, parseRepoLocatorInput, repoKey, resolveRepoRef } from "./github.ts";
import { grepRepoSnapshot, grepRepoViaGitHubRest, validateGrepPattern } from "./grep.ts";
import { formatCodeSearchOutput, formatDirectoryListOutput, formatPathListOutput, formatReadOutput, formatRepoSearchDescription } from "./output.ts";
import {
	assertDirectoryPath,
	compareCaseInsensitive,
	createGlobMatcher,
	encodePath,
	formatNumber,
	isUnderPath,
	normalizeRepoPath,
	relativeToPath,
	resolveGrepTarget,
	stripUndefined,
} from "./path-utils.ts";
import {
	getCachedRepoState,
	getRepoStateWithSnapshot,
	listRepoSnapshot,
	prefetchRepoSnapshot,
	refreshCachedRepoStateInBackground,
	resolveSnapshotPath,
	UnsafeRepoPathError,
} from "./snapshot.ts";
import type { GitHubCodeSearchResponse, GitHubContentFile, GitHubContentObject, GitHubContentsDirectory, GitHubRepo, GitHubRepoSearchResponse } from "./types.ts";
import {
	formatCompactTextResult,
	formatRepoCodeSearchCall,
	formatRepoFindCall,
	formatRepoFindFilesCall,
	formatRepoGrepCall,
	formatRepoGrepResult,
	formatRepoListCall,
	formatRepoReadCall,
	formatRepoReadResult,
	getDetails,
	renderText,
} from "./render.ts";

type RepoPathParams = { repo: string; ref?: string; path?: string };

function resolveRepoPathParams(params: RepoPathParams): { repo: GitHubRepo; ref?: string; path: string } {
	const locator = parseRepoLocatorInput(params.repo);
	const path = normalizeRepoPath(params.path ?? locator.path);
	if (path.split(/[\\/]/).includes("..") || path.includes("\0") || /^[A-Za-z]:/.test(path) || path.startsWith("\\")) {
		throw new UnsafeRepoPathError(path);
	}
	return { repo: locator.repo, ref: params.ref ?? locator.ref, path };
}

function buildCodeSearchQuery(params: { query: string; repo?: string; language?: string; path?: string }): string {
	const terms = [params.query.trim()];
	if (params.repo?.trim()) terms.push(`repo:${repoKey(parseRepoInput(params.repo))}`);
	if (params.language?.trim()) terms.push(formatSearchQualifier("language", params.language.trim()));
	if (params.path?.trim()) terms.push(formatSearchQualifier("path", normalizeRepoPath(params.path)));
	return terms.filter(Boolean).join(" ");
}

function formatSearchQualifier(name: string, value: string): string {
	if (/\s/.test(value)) return `${name}:"${value.replace(/"/g, "\\\"")}"`;
	return `${name}:${value}`;
}

const repoFindTool = defineTool({
	name: "repo_find",
	label: "Repo Find",
	description: "Find GitHub repositories by query.",
	promptSnippet: "Find candidate GitHub repositories for a library, tool, or codebase.",
	promptGuidelines: ["Use repo_find when the user wants to discover a GitHub repository to inspect."],
	parameters: Type.Object({
		query: Type.String({ description: "Repository search query." }),
		limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20, description: "Maximum number of repositories." })),
	}),
	async execute(_toolCallId, params, signal) {
		signal?.throwIfAborted();
		const searchParams = new URLSearchParams({
			q: params.query,
			per_page: String(params.limit ?? 5),
			sort: "stars",
			order: "desc",
		});
		const response = await githubJson<GitHubRepoSearchResponse>(`/search/repositories?${searchParams.toString()}`, undefined, undefined, signal);
		const lines = response.items.map((item, index) => {
			const description = formatRepoSearchDescription(item.description);
			return `${index + 1}. ${item.full_name} (${formatNumber(item.stargazers_count)} stars)${description}\n   ${item.html_url}`;
		});
		return {
			content: [{ type: "text", text: lines.length > 0 ? lines.join("\n\n") : "No repositories found." }],
			details: { backend: "github-rest", count: response.items.length },
		};
	},
	renderCall(args, theme, context) {
		return renderText(context.lastComponent, formatRepoFindCall(args, theme));
	},
	renderResult(result, options, theme, context) {
		return renderText(context.lastComponent, formatCompactTextResult(result, options, theme, 10));
	},
});

const repoCodeSearchTool = defineTool({
	name: "repo_code_search",
	label: "Repo Code Search",
	description: "Search code across GitHub repositories and return matching files with text-match snippets.",
	promptSnippet: "Search GitHub code across repositories for examples, APIs, symbols, or implementation patterns.",
	promptGuidelines: [
		"Use repo_code_search when the user asks to find examples or inspiration across open source GitHub projects.",
		"Use repo_code_search with repo, language, or path filters when a broad search returns noisy results.",
	],
	parameters: Type.Object({
		query: Type.String({ description: "GitHub code search query terms. May include GitHub search qualifiers." }),
		repo: Type.Optional(Type.String({ description: "Optional repository filter as owner/name or GitHub URL." })),
		language: Type.Optional(Type.String({ description: "Optional language qualifier, for example TypeScript, Go, or Rust." })),
		path: Type.Optional(Type.String({ description: "Optional path qualifier to narrow results, for example src or examples." })),
		limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50, description: "Maximum number of code results." })),
	}),
	async execute(_toolCallId, params, signal) {
		signal?.throwIfAborted();
		const query = buildCodeSearchQuery(params);
		if (!query) throw new Error("query is required");
		const searchParams = new URLSearchParams({
			q: query,
			per_page: String(params.limit ?? 10),
		});
		const response = await githubJson<GitHubCodeSearchResponse>(
			`/search/code?${searchParams.toString()}`,
			"application/vnd.github.text-match+json",
			undefined,
			signal,
		);
		const output = formatCodeSearchOutput(response.items);
		return {
			content: [{ type: "text", text: output.text }],
			details: stripUndefined({
				backend: "github-rest",
				query,
				count: output.count,
				totalCount: response.total_count,
				incompleteResults: response.incomplete_results || undefined,
				truncation: output.truncation,
			}),
		};
	},
	renderCall(args, theme, context) {
		return renderText(context.lastComponent, formatRepoCodeSearchCall(args, theme));
	},
	renderResult(result, options, theme, context) {
		return renderText(context.lastComponent, formatCompactTextResult(result, options, theme, 20));
	},
});

const repoListTool = defineTool({
	name: "repo_list",
	label: "Repo List",
	description: "List one directory in a remote GitHub repository, like local ls.",
	promptSnippet: "List one remote GitHub directory like a local ls call.",
	promptGuidelines: [
		"Use repo_list instead of fetching GitHub HTML when you need to inspect a repository directory.",
		"Omit path to list the repo root, then call repo_list again for specific subdirectories as needed.",
	],
	parameters: Type.Object({
		repo: Type.String({ description: "Repository as owner/name or GitHub URL. Blob/tree URLs may include ref and path." }),
		ref: Type.Optional(Type.String({ description: "Branch, tag, or commit SHA." })),
		path: Type.Optional(Type.String({ description: "Directory path inside the repository. Omit for the root directory." })),
		limit: Type.Optional(Type.Number({ minimum: 1, maximum: 5000, description: "Maximum number of entries to return." })),
	}),
	async execute(_toolCallId, params, signal) {
		signal?.throwIfAborted();
		const { repo, ref, path } = resolveRepoPathParams(params);
		const cachedState = await getCachedRepoState(repo, ref, signal);
		if (cachedState) {
			refreshCachedRepoStateInBackground(repo, cachedState);
			return await listRepoSnapshot(cachedState, path, params.limit, signal);
		}

		const resolvedRef = await resolveRepoRef(repo, ref, signal);
		prefetchRepoSnapshot(repo, resolvedRef);
		const refQuery = resolvedRef ? `?ref=${encodeURIComponent(resolvedRef)}` : "";
		const encodedPath = path ? `/${encodePath(path)}` : "";
		const result = await githubJson<GitHubContentsDirectory | GitHubContentObject>(
			`/repos/${repo.owner}/${repo.name}/contents${encodedPath}${refQuery}`,
			"application/vnd.github.object+json",
			undefined,
			signal,
		);
		const asFile = result as Partial<GitHubContentFile>;
		if (asFile.type === "file") {
			throw new Error(`${path || "/"} is a file. Use repo_read instead.`);
		}
		const entries = (Array.isArray(result) ? result : result.entries ?? []).slice();
		const output = formatDirectoryListOutput(entries, params.limit);
		return {
			content: [{ type: "text", text: output.text }],
			details: stripUndefined({
				backend: "github-rest",
				path: path || "/",
				ref: resolvedRef,
				count: output.count,
				entryLimitReached: output.entryLimitReached,
				truncation: output.truncation,
			}),
		};
	},
	renderCall(args, theme, context) {
		return renderText(context.lastComponent, formatRepoListCall(args, theme));
	},
	renderResult(result, options, theme, context) {
		return renderText(context.lastComponent, formatCompactTextResult(result, options, theme, 20, "entryLimitReached", "entries"));
	},
});

const repoReadTool = defineTool({
	name: "repo_read",
	label: "Repo Read",
	description: `Read a file from a remote GitHub repository, like local read. Uses a cached archive when possible. Defaults to ${DEFAULT_REPO_READ_LIMIT} lines; use offset/limit to continue or request a different range. Text output is still capped at ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB.`,
	promptSnippet: "Read a file from a remote GitHub repository like a local file read.",
	promptGuidelines: ["Use repo_read when you know the repository file path you want to inspect."],
	parameters: Type.Object({
		repo: Type.String({ description: "Repository as owner/name or GitHub URL. Blob URLs may include ref and path." }),
		path: Type.Optional(Type.String({ description: "File path inside the repository. Optional when repo is a GitHub blob URL." })),
		ref: Type.Optional(Type.String({ description: "Branch, tag, or commit SHA." })),
		offset: Type.Optional(Type.Number({ minimum: 1, description: "Line number to start reading from (1-indexed)." })),
		limit: Type.Optional(Type.Number({ minimum: 1, maximum: 2000, description: `Maximum number of lines to read (default: ${DEFAULT_REPO_READ_LIMIT}).` })),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		signal?.throwIfAborted();
		const { repo, ref, path } = resolveRepoPathParams(params);
		if (!path) throw new Error("path is required");
		const effectiveLimit = params.limit ?? DEFAULT_REPO_READ_LIMIT;
		let state = await getCachedRepoState(repo, ref, signal);
		try {
			if (!state) {
				onUpdate?.({ content: [{ type: "text", text: "Preparing cached GitHub archive..." }], details: {} });
				state = await getRepoStateWithSnapshot(repo, ref, signal);
			} else {
				refreshCachedRepoStateInBackground(repo, state);
			}
			const absolutePath = await resolveSnapshotPath(state.snapshot.path, path);
			const readTool = createReadToolDefinition(state.snapshot.path);
			const result = await readTool.execute(
				toolCallId,
				{ path: absolutePath, offset: params.offset, limit: effectiveLimit },
				signal,
				onUpdate,
				ctx,
			);
			return {
				...result,
				details: stripUndefined({
					...getDetails(result),
					backend: "github-archive-cache",
					path,
					ref: state.ref,
					commit: state.commit,
				}),
			};
		} catch (error) {
			if (signal?.aborted || error instanceof UnsafeRepoPathError) throw error;
			const fallbackReason = error instanceof Error ? error.message : String(error);
			onUpdate?.({ content: [{ type: "text", text: "Cached archive unavailable; falling back to GitHub REST file read..." }], details: {} });
			const resolvedRef = state?.ref ?? await resolveRepoRef(repo, ref, signal);
			prefetchRepoSnapshot(repo, resolvedRef);
			const text = await getRepoFileText(repo, resolvedRef, path, signal);
			const output = formatReadOutput(text, params.offset, effectiveLimit);
			return {
				content: [{ type: "text", text: output.text }],
				details: stripUndefined({ backend: "github-rest", path, ref: resolvedRef, truncation: output.truncation, fallbackReason }),
			};
		}
	},
	renderCall(args, theme, context) {
		return renderText(context.lastComponent, formatRepoReadCall(args, theme));
	},
	renderResult(result, options, theme, context) {
		return renderText(context.lastComponent, formatRepoReadResult(context.args, result, options, theme));
	},
});

const repoFindFilesTool = defineTool({
	name: "repo_find_files",
	label: "Repo Find Files",
	description: "Find files in a remote GitHub repository by glob pattern, like local find.",
	promptSnippet: "Find remote repository files by glob pattern like a local find call.",
	promptGuidelines: [
		"Use repo_find_files when you need to discover files by pattern inside a remote repository.",
		"Use repo_list for one directory and repo_find_files for recursive file discovery.",
	],
	parameters: Type.Object({
		repo: Type.String({ description: "Repository as owner/name or GitHub URL. Tree URLs may include ref and path." }),
		pattern: Type.String({ description: "Glob pattern to match files, for example *.ts or **/*.test.ts." }),
		ref: Type.Optional(Type.String({ description: "Branch, tag, or commit SHA." })),
		path: Type.Optional(Type.String({ description: "Directory to search in (default: repo root)." })),
		limit: Type.Optional(Type.Number({ minimum: 1, maximum: 5000, description: "Maximum number of results to return." })),
	}),
	async execute(_toolCallId, params, signal) {
		signal?.throwIfAborted();
		const { repo, ref: requestedRef, path: searchPath } = resolveRepoPathParams(params);
		const cachedState = await getCachedRepoState(repo, requestedRef, signal);
		const ref = cachedState?.ref ?? await resolveRepoRef(repo, requestedRef, signal);
		if (cachedState) refreshCachedRepoStateInBackground(repo, cachedState);
		else prefetchRepoSnapshot(repo, ref);
		const tree = cachedState?.tree ?? (await getRepoTree(repo, ref, signal)).tree;
		assertDirectoryPath(tree, searchPath);
		const matcher = createGlobMatcher(params.pattern);
		const effectiveLimit = params.limit ?? DEFAULT_FIND_LIMIT;
		const matches = tree.tree
			.filter(entry => entry.type === "blob")
			.filter(entry => isUnderPath(entry.path, searchPath))
			.map(entry => relativeToPath(entry.path, searchPath))
			.filter(candidate => matcher(candidate))
			.sort(compareCaseInsensitive);
		if (matches.length === 0) {
			return {
				content: [{ type: "text", text: "No files found matching pattern" }],
				details: { backend: cachedState ? "github-archive-cache" : "github-rest", path: searchPath || "/", ref, ...(cachedState ? { commit: cachedState.commit } : {}) },
			};
		}
		const output = formatPathListOutput(matches, effectiveLimit);
		return {
			content: [{ type: "text", text: output.text }],
			details: stripUndefined({
				backend: cachedState ? "github-archive-cache" : "github-rest",
				path: searchPath || "/",
				ref,
				count: output.count,
				commit: cachedState?.commit,
				resultLimitReached: output.resultLimitReached,
				truncation: output.truncation,
			}),
		};
	},
	renderCall(args, theme, context) {
		return renderText(context.lastComponent, formatRepoFindFilesCall(args, theme));
	},
	renderResult(result, options, theme, context) {
		return renderText(context.lastComponent, formatCompactTextResult(result, options, theme, 20, "resultLimitReached", "results"));
	},
});

const repoGrepTool = defineTool({
	name: "repo_grep",
	label: "Repo Grep",
	description: "Search file contents inside a remote GitHub repository using a cached archive and local grep when possible.",
	promptSnippet: "Search remote repository file contents by pattern like a local grep call.",
	promptGuidelines: [
		"Use repo_grep to search remote repository contents instead of GitHub HTML or broad web search.",
		"Use path to scope to one file or directory, and use glob to narrow which files are scanned.",
	],
	parameters: Type.Object({
		repo: Type.String({ description: "Repository as owner/name or GitHub URL. Blob/tree URLs may include ref and path." }),
		pattern: Type.String({ description: "Search pattern (regex or literal string)." }),
		ref: Type.Optional(Type.String({ description: "Branch, tag, or commit SHA." })),
		path: Type.Optional(Type.String({ description: "Directory or file to search (default: repo root)." })),
		glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, for example *.ts or **/*.spec.ts." })),
		ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)." })),
		literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)." })),
		context: Type.Optional(Type.Number({ minimum: 0, maximum: 20, description: "Number of lines to show before and after each match (default: 0)." })),
		limit: Type.Optional(Type.Number({ minimum: 1, maximum: 1000, description: "Maximum number of matches to return." })),
	}),
	async execute(_toolCallId, params, signal, onUpdate) {
		signal?.throwIfAborted();
		const { repo, ref, path } = resolveRepoPathParams(params);
		validateGrepPattern(params.pattern, Boolean(params.literal), Boolean(params.ignoreCase));
		const cachedState = await getCachedRepoState(repo, ref, signal);
		let state = cachedState;
		try {
			if (!state) {
				onUpdate?.({ content: [{ type: "text", text: "Preparing cached GitHub archive..." }], details: {} });
				state = await getRepoStateWithSnapshot(repo, ref, signal);
			} else {
				refreshCachedRepoStateInBackground(repo, state);
			}
			await resolveSnapshotPath(state.snapshot.path, path);
			const normalizedPath = path;
			const grepTarget = resolveGrepTarget(state.tree, normalizedPath);
			const fileMatcher = params.glob ? createGlobMatcher(params.glob) : null;
			const filesToScan = grepTarget.files
				.filter(filePath => !fileMatcher || fileMatcher(relativeToPath(filePath, grepTarget.filterBase)))
				.sort(compareCaseInsensitive);
			const result = await grepRepoSnapshot(state.snapshot, params, grepTarget, filesToScan, signal);
			return {
				content: [{ type: "text", text: result.output }],
				details: stripUndefined({
					backend: result.backend,
					path: normalizedPath || "/",
					ref: state.ref,
					commit: state.commit,
					matches: result.matchCount,
					cachePath: result.cachePath,
					matchLimitReached: result.matchLimitReached,
					truncation: result.truncation,
					linesTruncated: result.linesTruncated,
					fallbackReason: result.fallbackReason,
				}),
			};
		} catch (error) {
			if (signal?.aborted || error instanceof UnsafeRepoPathError) throw error;
			const fallbackReason = error instanceof Error ? error.message : String(error);
			onUpdate?.({ content: [{ type: "text", text: "Cached archive unavailable; falling back to GitHub REST scan..." }], details: {} });
			const requestedRef = state?.ref ?? await resolveRepoRef(repo, ref, signal);
			const commitSha = state?.commit ?? await getRepoCommitSha(repo, requestedRef, signal);
			const { tree } = state ?? await getRepoTree(repo, commitSha, signal);
			const normalizedPath = path;
			const grepTarget = resolveGrepTarget(tree, normalizedPath);
			const fileMatcher = params.glob ? createGlobMatcher(params.glob) : null;
			const filesToScan = grepTarget.files
				.filter(filePath => !fileMatcher || fileMatcher(relativeToPath(filePath, grepTarget.filterBase)))
				.sort(compareCaseInsensitive);
			return await grepRepoViaGitHubRest(repo, commitSha, normalizedPath, grepTarget, filesToScan, params, fallbackReason, signal);
		}
	},
	renderCall(args, theme, context) {
		return renderText(context.lastComponent, formatRepoGrepCall(args, theme));
	},
	renderResult(result, options, theme, context) {
		return renderText(context.lastComponent, formatRepoGrepResult(result, options, theme));
	},
});

export function registerRepoTools(pi: ExtensionAPI) {
	pi.registerTool(repoFindTool);
	pi.registerTool(repoCodeSearchTool);
	pi.registerTool(repoListTool);
	pi.registerTool(repoReadTool);
	pi.registerTool(repoFindFilesTool);
	pi.registerTool(repoGrepTool);
}
