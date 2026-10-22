import { execFile, spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead, truncateLine } from "@earendil-works/pi-coding-agent";
import { DEFAULT_GREP_LIMIT, GREP_MAX_LINE_LENGTH, RIPGREP_CHUNK_SIZE, RIPGREP_MAX_ARG_BYTES } from "./constants.ts";
import { getRepoFileText, throwIfAborted } from "./github.ts";
import { readSnapshotTextFile, resolveSnapshotPath } from "./snapshot.ts";
import {
	basenamePath,
	compareCaseInsensitive,
	createLineMatcher,
	looksBinary,
	normalizeNewlines,
	relativeToPath,
	stripUndefined,
} from "./path-utils.ts";
import type { GitHubRepo, GrepLineMatch, GrepTarget, RepoGrepParams, RepoGrepResult, RepoSnapshot, RipgrepJsonEvent, SnapshotGrepSearch } from "./types.ts";

const execFileAsync = promisify(execFile);
const SCAN_YIELD_INTERVAL = 2048;
let cachedRipgrepAvailable: Promise<boolean> | null = null;

export async function grepRepoSnapshot(
	snapshot: RepoSnapshot,
	params: RepoGrepParams,
	grepTarget: GrepTarget,
	filesToScan: string[],
	signal?: AbortSignal,
): Promise<RepoGrepResult> {
	throwIfAborted(signal);
	const effectiveLimit = params.limit ?? DEFAULT_GREP_LIMIT;
	const contextValue = params.context && params.context > 0 ? params.context : 0;
	let fallbackReason: string | undefined;
	let search = await grepSnapshotWithRipgrep(snapshot, params, grepTarget, filesToScan, effectiveLimit, signal);
	if (!search) {
		fallbackReason = "ripgrep unavailable or could not run this pattern; used local JavaScript scan";
		search = await grepSnapshotWithJavaScript(snapshot, params, filesToScan, effectiveLimit, signal);
	}
	const formatted = await formatSnapshotGrepOutput(snapshot.path, search.matches, grepTarget, contextValue, signal);
	let output = formatted.output;
	const notices: string[] = [];
	if (search.matchLimitReached) {
		notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
	}
	const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER, maxBytes: DEFAULT_MAX_BYTES });
	output = truncation.content;
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (formatted.linesTruncated) {
		notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use repo_read to see full lines`);
	}
	if (notices.length > 0) {
		output += `\n\n[${notices.join(". ")}]`;
	}
	return stripUndefined({
		backend: search.backend,
		output,
		matchCount: search.matches.length,
		cachePath: snapshot.path,
		matchLimitReached: search.matchLimitReached ? effectiveLimit : undefined,
		truncation: truncation.truncated ? truncation : undefined,
		linesTruncated: formatted.linesTruncated ? true : undefined,
		fallbackReason,
	});
}

export async function grepRepoViaGitHubRest(
	repo: GitHubRepo,
	ref: string,
	normalizedPath: string,
	grepTarget: GrepTarget,
	filesToScan: string[],
	params: RepoGrepParams,
	fallbackReason?: string,
	signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
	throwIfAborted(signal);
	const effectiveLimit = params.limit ?? DEFAULT_GREP_LIMIT;
	const contextValue = params.context && params.context > 0 ? params.context : 0;
	const matchLine = createLineMatcher(params.pattern, Boolean(params.literal), Boolean(params.ignoreCase));
	const outputLines: string[] = [];
	let matchCount = 0;
	let matchLimitReached = false;
	let linesTruncated = false;
	for (const filePath of filesToScan) {
		throwIfAborted(signal);
		const fileText = await getRepoFileText(repo, ref, filePath, signal);
		if (looksBinary(fileText)) continue;
		const lines = normalizeNewlines(fileText).split("\n");
		for (let index = 0; index < lines.length; index++) {
			if (index % SCAN_YIELD_INTERVAL === 0) await yieldScanProgress(signal);
			if (!matchLine(lines[index])) continue;
			matchCount++;
			const displayPath = grepTarget.isDirectorySearch
				? relativeToPath(filePath, grepTarget.filterBase)
				: basenamePath(filePath);
			const start = contextValue > 0 ? Math.max(1, index + 1 - contextValue) : index + 1;
			const end = contextValue > 0 ? Math.min(lines.length, index + 1 + contextValue) : index + 1;
			for (let lineNo = start; lineNo <= end; lineNo++) {
				const text = truncateLine(lines[lineNo - 1] ?? "");
				if (text.wasTruncated) linesTruncated = true;
				if (lineNo === index + 1) outputLines.push(`${displayPath}:${lineNo}: ${text.text}`);
				else outputLines.push(`${displayPath}-${lineNo}- ${text.text}`);
			}
			if (matchCount >= effectiveLimit) {
				matchLimitReached = true;
				break;
			}
		}
		if (matchLimitReached) break;
	}
	if (matchCount === 0) {
		const noMatchText = fallbackReason ? `No matches found\n\n[Archive cache unavailable; used slower GitHub REST scan]` : "No matches found";
		return {
			content: [{ type: "text", text: noMatchText }],
			details: { backend: "github-rest", path: normalizedPath || "/", ref, matches: 0, ...(fallbackReason ? { fallbackReason } : {}) },
		};
	}
	let output = outputLines.join("\n");
	const notices: string[] = [];
	if (matchLimitReached) {
		notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
	}
	const truncation = truncateHead(output, { maxLines: Number.MAX_SAFE_INTEGER, maxBytes: DEFAULT_MAX_BYTES });
	output = truncation.content;
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
	}
	if (linesTruncated) {
		notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use repo_read to see full lines`);
	}
	if (fallbackReason) {
		notices.push("Archive cache unavailable; used slower GitHub REST scan");
	}
	if (notices.length > 0) {
		output += `\n\n[${notices.join(". ")}]`;
	}
	return {
		content: [{ type: "text", text: output }],
		details: stripUndefined({
			backend: "github-rest",
			path: normalizedPath || "/",
			ref,
			matches: matchCount,
			matchLimitReached: matchLimitReached ? effectiveLimit : undefined,
			truncation: truncation.truncated ? truncation : undefined,
			linesTruncated: linesTruncated ? true : undefined,
			fallbackReason,
		}),
	};
}

export async function grepSnapshotWithRipgrep(
	snapshot: RepoSnapshot,
	params: RepoGrepParams,
	grepTarget: GrepTarget,
	filesToScan: string[],
	effectiveLimit: number,
	signal?: AbortSignal,
): Promise<SnapshotGrepSearch | null> {
	throwIfAborted(signal);
	if (params.literal && params.pattern === "") return null;
	if (params.pattern.includes("\n") || params.pattern.includes("\r")) return null;
	if (!(await hasRipgrep())) return null;
	const filesToScanSet = new Set(filesToScan);
	const allMatches: GrepLineMatch[] = [];
	let matchLimitReached = false;
	const targetChunks = params.glob
		? chunkRipgrepPaths(filesToScan)
		: [[grepTarget.isDirectorySearch ? grepTarget.filterBase || "." : filesToScan[0]].filter(Boolean)];
	for (const targets of targetChunks) {
		if (targets.length === 0) continue;
		throwIfAborted(signal);
		const result = await runRipgrepChunk(snapshot.path, params, targets, filesToScanSet, effectiveLimit - allMatches.length, signal);
		if (!result) return null;
		allMatches.push(...result.matches);
		if (result.matchLimitReached || allMatches.length >= effectiveLimit) {
			matchLimitReached = true;
			break;
		}
	}
	return { backend: "github-archive-rg", matches: dedupeMatches(allMatches), matchLimitReached };
}

async function yieldScanProgress(signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	await new Promise<void>(resolve => setImmediate(resolve));
	throwIfAborted(signal);
}

async function selectScannableTargets(cwd: string, targets: string[], signal?: AbortSignal): Promise<string[]> {
	const scannableTargets: string[] = [];
	for (const target of targets) {
		throwIfAborted(signal);
		try {
			// Awaited so the check keeps working when resolveSnapshotPath becomes async.
			const stats = await lstat(await resolveSnapshotPath(cwd, target));
			if (stats.isFile() || stats.isDirectory()) scannableTargets.push(target);
		} catch {
			// Skip missing, dangling, or escaping entries; one bad entry must not abort the scan.
		}
	}
	return scannableTargets;
}

export function createRipgrepMatchCollector(
	filesToScanSet: Set<string>,
	limit: number,
): { readonly matches: GrepLineMatch[]; readonly done: boolean; push: (chunk: string) => void } {
	let stdoutBuffer = "";
	const matches: GrepLineMatch[] = [];
	const limitReached = () => matches.length >= limit;
	return {
		get matches() {
			return matches;
		},
		get done() {
			return limitReached();
		},
		push(chunk: string) {
			if (limitReached()) return;
			stdoutBuffer += chunk;
			let newlineIndex = stdoutBuffer.indexOf("\n");
			while (newlineIndex >= 0 && !limitReached()) {
				const line = stdoutBuffer.slice(0, newlineIndex);
				stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
				const match = parseRipgrepMatchLine(line, filesToScanSet);
				if (match) matches.push(match);
				newlineIndex = stdoutBuffer.indexOf("\n");
			}
		},
	};
}

export async function runRipgrepChunk(
	cwd: string,
	params: RepoGrepParams,
	targets: string[],
	filesToScanSet: Set<string>,
	remainingLimit: number,
	signal?: AbortSignal,
): Promise<{ matches: GrepLineMatch[]; matchLimitReached: boolean } | null> {
	throwIfAborted(signal);
	if (remainingLimit <= 0) return { matches: [], matchLimitReached: true };
	const scannableTargets = await selectScannableTargets(cwd, targets, signal);
	if (scannableTargets.length === 0) return { matches: [], matchLimitReached: false };
	const args = ["--json", "--line-number", "--color=never", "--no-heading", "--no-ignore", "--hidden", "--no-config"];
	if (params.literal) args.push("--fixed-strings");
	if (params.ignoreCase) args.push("--ignore-case");
	args.push("--", params.pattern, ...scannableTargets);
	return new Promise((resolvePromise, reject) => {
		const child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		const collector = createRipgrepMatchCollector(filesToScanSet, remainingLimit);
		let stderr = "";
		const abortHandler = () => child.kill("SIGTERM");
		if (signal?.aborted) {
			child.kill("SIGTERM");
		} else {
			signal?.addEventListener("abort", abortHandler, { once: true });
		}
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", chunk => {
			if (collector.done) return;
			collector.push(chunk);
			if (collector.done) child.kill("SIGTERM");
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", chunk => {
			stderr += chunk;
			if (stderr.length > 4000) stderr = stderr.slice(-4000);
		});
		child.on("error", error => {
			signal?.removeEventListener("abort", abortHandler);
			if ((error as NodeJS.ErrnoException).code === "ENOENT") resolvePromise(null);
			else reject(error);
		});
		child.on("close", code => {
			signal?.removeEventListener("abort", abortHandler);
			if (signal?.aborted) {
				reject(signal.reason);
				return;
			}
			if (collector.done || code === 0 || code === 1) {
				resolvePromise({ matches: collector.matches, matchLimitReached: collector.done });
				return;
			}
			resolvePromise(null);
		});
	});
}

export function parseRipgrepMatchLine(line: string, filesToScanSet: Set<string>): GrepLineMatch | null {
	if (!line.trim()) return null;
	let event: RipgrepJsonEvent;
	try {
		event = JSON.parse(line) as RipgrepJsonEvent;
	} catch {
		return null;
	}
	if (event.type !== "match") return null;
	const filePath = normalizeRipgrepPath(event.data?.path?.text ?? "");
	const lineNumber = event.data?.line_number;
	if (!filePath || typeof lineNumber !== "number") return null;
	if (!filesToScanSet.has(filePath)) return null;
	return { filePath, lineNumber };
}

export async function grepSnapshotWithJavaScript(
	snapshot: RepoSnapshot,
	params: RepoGrepParams,
	filesToScan: string[],
	effectiveLimit: number,
	signal?: AbortSignal,
): Promise<SnapshotGrepSearch> {
	throwIfAborted(signal);
	const matchLine = createLineMatcher(params.pattern, Boolean(params.literal), Boolean(params.ignoreCase));
	const matches: GrepLineMatch[] = [];
	let matchLimitReached = false;
	for (const filePath of filesToScan) {
		throwIfAborted(signal);
		const fileText = await readSnapshotTextFile(snapshot.path, filePath);
		if (fileText === null || looksBinary(fileText)) continue;
		const lines = normalizeNewlines(fileText).split("\n");
		for (let index = 0; index < lines.length; index++) {
			if (index % SCAN_YIELD_INTERVAL === 0) await yieldScanProgress(signal);
			if (!matchLine(lines[index])) continue;
			matches.push({ filePath, lineNumber: index + 1 });
			if (matches.length >= effectiveLimit) {
				matchLimitReached = true;
				break;
			}
		}
		if (matchLimitReached) break;
	}
	return { backend: "github-archive-js", matches, matchLimitReached };
}

export async function formatSnapshotGrepOutput(
	snapshotPath: string,
	matches: GrepLineMatch[],
	grepTarget: GrepTarget,
	contextValue: number,
	signal?: AbortSignal,
): Promise<{ output: string; linesTruncated: boolean }> {
	throwIfAborted(signal);
	if (matches.length === 0) return { output: "No matches found", linesTruncated: false };
	const outputLines: string[] = [];
	const fileCache = new Map<string, string[]>();
	let linesTruncated = false;
	for (const match of dedupeMatches(matches).sort(compareGrepLineMatches)) {
		throwIfAborted(signal);
		let lines = fileCache.get(match.filePath);
		if (!lines) {
			const fileText = await readSnapshotTextFile(snapshotPath, match.filePath);
			if (fileText === null) continue;
			lines = normalizeNewlines(fileText).split("\n");
			fileCache.set(match.filePath, lines);
		}
		const displayPath = grepTarget.isDirectorySearch
			? relativeToPath(match.filePath, grepTarget.filterBase)
			: basenamePath(match.filePath);
		const start = contextValue > 0 ? Math.max(1, match.lineNumber - contextValue) : match.lineNumber;
		const end = contextValue > 0 ? Math.min(lines.length, match.lineNumber + contextValue) : match.lineNumber;
		for (let lineNo = start; lineNo <= end; lineNo++) {
			const text = truncateLine(lines[lineNo - 1] ?? "");
			if (text.wasTruncated) linesTruncated = true;
			if (lineNo === match.lineNumber) outputLines.push(`${displayPath}:${lineNo}: ${text.text}`);
			else outputLines.push(`${displayPath}-${lineNo}- ${text.text}`);
		}
	}
	return { output: outputLines.join("\n"), linesTruncated };
}

export function validateGrepPattern(pattern: string, literal: boolean, ignoreCase: boolean): void {
	if (!literal) createLineMatcher(pattern, false, ignoreCase);
}

export async function hasRipgrep(): Promise<boolean> {
	if (!cachedRipgrepAvailable) {
		cachedRipgrepAvailable = execFileAsync("rg", ["--version"])
			.then(() => true)
			.catch(() => false);
	}
	return cachedRipgrepAvailable;
}

export function chunkRipgrepPaths(paths: string[]): string[][] {
	const chunks: string[][] = [];
	let current: string[] = [];
	let currentBytes = 0;
	for (const path of paths) {
		const pathBytes = Buffer.byteLength(path, "utf8") + 1;
		if (current.length > 0 && (current.length >= RIPGREP_CHUNK_SIZE || currentBytes + pathBytes > RIPGREP_MAX_ARG_BYTES)) {
			chunks.push(current);
			current = [];
			currentBytes = 0;
		}
		current.push(path);
		currentBytes += pathBytes;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

export function dedupeMatches(matches: GrepLineMatch[]): GrepLineMatch[] {
	const seen = new Set<string>();
	const deduped: GrepLineMatch[] = [];
	for (const match of matches) {
		const key = `${match.filePath}:${match.lineNumber}`;
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(match);
	}
	return deduped;
}

export function compareGrepLineMatches(left: GrepLineMatch, right: GrepLineMatch): number {
	const pathCompare = compareCaseInsensitive(left.filePath, right.filePath);
	return pathCompare || left.lineNumber - right.lineNumber;
}

export function normalizeRipgrepPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "");
}
