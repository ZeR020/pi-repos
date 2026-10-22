import type { GitHubTreeResponse, GrepTarget } from "./types.ts";

export function normalizeRepoPath(path: string | undefined): string {
	return (path ?? "").replace(/^\/+|\/+$/g, "").trim();
}

export function encodePath(path: string): string {
	return normalizeRepoPath(path)
		.split("/")
		.filter(Boolean)
		.map(segment => encodeURIComponent(segment))
		.join("/");
}

export function compareCaseInsensitive(left: string, right: string): number {
	return left.toLowerCase().localeCompare(right.toLowerCase());
}

export function normalizeNewlines(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function assertDirectoryPath(tree: GitHubTreeResponse, searchPath: string): void {
	if (!searchPath) return;
	const exact = tree.tree.find(entry => entry.path === searchPath);
	if (exact?.type === "blob") {
		throw new Error(`Not a directory: ${searchPath}`);
	}
	if (exact?.type === "tree") return;
	const hasChildren = tree.tree.some(entry => entry.path.startsWith(`${searchPath}/`));
	if (!hasChildren) {
		throw new Error(`Path not found: ${searchPath}`);
	}
}

export function resolveGrepTarget(tree: GitHubTreeResponse, searchPath: string): GrepTarget {
	if (!searchPath) {
		return { files: tree.tree.filter(entry => entry.type === "blob").map(entry => entry.path), filterBase: "", isDirectorySearch: true };
	}
	const exact = tree.tree.find(entry => entry.path === searchPath);
	if (exact?.type === "blob") {
		return { files: [searchPath], filterBase: searchPath, isDirectorySearch: false };
	}
	assertDirectoryPath(tree, searchPath);
	return {
		files: tree.tree.filter(entry => entry.type === "blob" && isUnderPath(entry.path, searchPath)).map(entry => entry.path),
		filterBase: searchPath,
		isDirectorySearch: true,
	};
}

export function isUnderPath(candidate: string, searchPath: string): boolean {
	if (!searchPath) return true;
	return candidate.startsWith(`${searchPath}/`);
}

export function relativeToPath(candidate: string, searchPath: string): string {
	if (!searchPath) return candidate;
	if (candidate.startsWith(`${searchPath}/`)) return candidate.slice(searchPath.length + 1);
	return candidate;
}

export function basenamePath(candidate: string): string {
	const parts = candidate.split("/");
	return parts[parts.length - 1] || candidate;
}

export function createGlobMatcher(pattern: string): (candidate: string) => boolean {
	const regex = globToRegExp(normalizeNewlines(pattern.trim()).replace(/\\/g, "/"));
	return (candidate: string) => regex.test(candidate.replace(/\\/g, "/"));
}

export function globToRegExp(pattern: string): RegExp {
	let output = "^";
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern[index];
		if (char === "*") {
			const next = pattern[index + 1];
			if (next === "*") {
				const after = pattern[index + 2];
				if (after === "/") {
					output += "(?:.*/)?";
					index += 2;
				} else {
					output += ".*";
					index += 1;
				}
			} else {
				output += "[^/]*";
			}
		} else if (char === "?") {
			output += "[^/]";
		} else {
			output += escapeRegExp(char);
		}
	}
	output += "$";
	return new RegExp(output);
}

export function createLineMatcher(pattern: string, literal: boolean, ignoreCase: boolean): (line: string) => boolean {
	if (literal) {
		const needle = ignoreCase ? pattern.toLowerCase() : pattern;
		return (line: string) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
	}
	const regex = new RegExp(pattern, ignoreCase ? "i" : "");
	return (line: string) => regex.test(line);
}

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function looksBinary(text: string): boolean {
	return text.includes("\u0000");
}

export function stripUndefined<T extends Record<string, unknown>>(value: T): T {
	return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}

export function formatNumber(value: number): string {
	return new Intl.NumberFormat("en-US").format(value);
}
