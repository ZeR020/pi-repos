import type { TruncationResult } from "@earendil-works/pi-coding-agent";

export type GitHubRepo = { owner: string; name: string };

export type GitHubRepoLocator = {
	repo: GitHubRepo;
	ref?: string;
	path?: string;
	urlKind?: "blob" | "tree" | "commit";
};

export type GitHubRepoMetadata = { default_branch: string };

export type GitHubCommitResponse = { sha: string };

export type RepoGrepParams = {
	repo: string;
	pattern: string;
	ref?: string;
	path?: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	context?: number;
	limit?: number;
};

export type GrepTarget = { files: string[]; filterBase: string; isDirectorySearch: boolean };

export type RepoSnapshot = { path: string; commit: string };

export type CachedRepoState = {
	ref: string;
	commit: string;
	tree: GitHubTreeResponse;
	snapshot: RepoSnapshot;
	refUpdatedAt: number;
};

export type RepoMetadataCache = { defaultBranch: string; updatedAt: number };

export type RepoRefCache = { ref: string; commit: string; updatedAt: number };

export type RepoTreeCache = { commit: string; tree: GitHubTreeResponse; updatedAt: number };

export type GrepLineMatch = { filePath: string; lineNumber: number };

export type SnapshotGrepSearch = {
	backend: "github-archive-rg" | "github-archive-js";
	matches: GrepLineMatch[];
	matchLimitReached: boolean;
};

export type RepoGrepResult = {
	backend: "github-archive-rg" | "github-archive-js";
	output: string;
	matchCount: number;
	cachePath: string;
	matchLimitReached?: number;
	truncation?: TruncationResult;
	linesTruncated?: boolean;
	fallbackReason?: string;
};

export type RipgrepJsonEvent = {
	type?: string;
	data?: {
		path?: { text?: string };
		line_number?: number;
	};
};

export type GitHubRepoSearchResponse = {
	items: Array<{
		full_name: string;
		description: string | null;
		stargazers_count: number;
		html_url: string;
	}>;
};

export type GitHubTextMatch = {
	property: string;
	fragment: string;
	matches?: Array<{ text: string; indices: number[] }>;
};

export type GitHubCodeSearchResponse = {
	total_count: number;
	incomplete_results: boolean;
	items: GitHubCodeSearchItem[];
};

export type GitHubCodeSearchItem = {
	name: string;
	path: string;
	html_url: string;
	score?: number;
	repository: {
		full_name: string;
		html_url: string;
	};
	text_matches?: GitHubTextMatch[];
};

export type GitHubContentsEntry = {
	type: string;
	path: string;
	name: string;
	size: number;
	html_url: string | null;
	download_url: string | null;
};

export type GitHubContentsDirectory = GitHubContentsEntry[];

export type GitHubContentObject = {
	type?: string;
	entries?: GitHubContentsEntry[];
	content?: string;
	encoding?: string;
	download_url?: string | null;
	name?: string;
	path?: string;
	size?: number;
};

export type GitHubContentFile = {
	type: "file";
	path: string;
	name: string;
	size: number;
	encoding?: string;
	content?: string;
	download_url: string | null;
};

export type GitHubTreeEntry = {
	path: string;
	type: "blob" | "tree" | "commit";
	size?: number;
};

export type GitHubTreeResponse = {
	truncated: boolean;
	tree: GitHubTreeEntry[];
};
