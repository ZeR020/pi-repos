import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	getLanguageFromPath,
	highlightCode,
	keyHint,
	type AgentToolResult,
	type Theme,
	type ToolRenderResultOptions,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { DEFAULT_REPO_READ_LIMIT } from "./constants.ts";

export function renderText(lastComponent: unknown, value: string): Text {
	const text = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
	text.setText(value);
	return text;
}

export function formatRepoFindCall(args: { query?: unknown; limit?: unknown }, theme: Theme): string {
	const query = str(args?.query);
	let text = `${theme.fg("toolTitle", theme.bold("repo_find"))} ${formatArg(query, theme, value => `"${value}"`)}`;
	if (typeof args?.limit === "number") text += theme.fg("toolOutput", ` limit ${args.limit}`);
	return text;
}

export function formatRepoListCall(args: { repo?: unknown; path?: unknown; ref?: unknown; limit?: unknown }, theme: Theme): string {
	let text = `${theme.fg("toolTitle", theme.bold("repo_list"))} ${formatRepoTarget(args, theme, "/")}`;
	if (typeof args?.ref === "string" && args.ref) text += theme.fg("dim", ` @ ${args.ref}`);
	if (typeof args?.limit === "number") text += theme.fg("toolOutput", ` (limit ${args.limit})`);
	return text;
}

export function formatRepoCodeSearchCall(args: { query?: unknown; repo?: unknown; language?: unknown; path?: unknown; limit?: unknown }, theme: Theme): string {
	const query = str(args?.query);
	let text = `${theme.fg("toolTitle", theme.bold("repo_code_search"))} ${formatArg(query, theme, value => `"${value}"`)}`;
	const repo = str(args?.repo);
	const language = str(args?.language);
	const path = str(args?.path);
	const filters = [repo ? `repo:${repo}` : undefined, language ? `lang:${language}` : undefined, path ? `path:${path}` : undefined].filter(Boolean);
	if (filters.length > 0) text += theme.fg("toolOutput", ` (${filters.join(", ")})`);
	if (typeof args?.limit === "number") text += theme.fg("toolOutput", ` limit ${args.limit}`);
	return text;
}

export function formatRepoReadCall(
	args: { repo?: unknown; path?: unknown; ref?: unknown; offset?: unknown; limit?: unknown },
	theme: Theme,
): string {
	let text = `${theme.fg("toolTitle", theme.bold("repo_read"))} ${formatRepoTarget(args, theme)}`;
	const offset = typeof args?.offset === "number" ? args.offset : undefined;
	const limit = typeof args?.limit === "number" ? args.limit : DEFAULT_REPO_READ_LIMIT;
	const startLine = offset ?? 1;
	const endLine = startLine + limit - 1;
	text += theme.fg("warning", `:${startLine}-${endLine}`);
	if (typeof args?.ref === "string" && args.ref) text += theme.fg("dim", ` @ ${args.ref}`);
	return text;
}

export function formatRepoFindFilesCall(args: { repo?: unknown; pattern?: unknown; path?: unknown; ref?: unknown; limit?: unknown }, theme: Theme): string {
	const pattern = str(args?.pattern);
	let text = `${theme.fg("toolTitle", theme.bold("repo_find_files"))} ${formatArg(pattern, theme)} in ${formatRepoTarget(args, theme, "/", "toolOutput")}`;
	if (typeof args?.ref === "string" && args.ref) text += theme.fg("dim", ` @ ${args.ref}`);
	if (typeof args?.limit === "number") text += theme.fg("toolOutput", ` (limit ${args.limit})`);
	return text;
}

export function formatRepoGrepCall(
	args: { repo?: unknown; pattern?: unknown; path?: unknown; glob?: unknown; ref?: unknown; limit?: unknown },
	theme: Theme,
): string {
	const pattern = str(args?.pattern);
	const glob = str(args?.glob);
	let text = `${theme.fg("toolTitle", theme.bold("repo_grep"))} ${formatArg(pattern, theme, value => `/${value}/`)} in ${formatRepoTarget(args, theme, "/", "toolOutput")}`;
	if (glob) text += theme.fg("toolOutput", ` (${glob})`);
	if (typeof args?.ref === "string" && args.ref) text += theme.fg("dim", ` @ ${args.ref}`);
	if (typeof args?.limit === "number") text += theme.fg("toolOutput", ` limit ${args.limit}`);
	return text;
}

export function formatRepoTarget(
	args: { repo?: unknown; path?: unknown },
	theme: Theme,
	defaultPath = "",
	color: "accent" | "toolOutput" = "accent",
): string {
	const repo = str(args?.repo);
	const path = str(args?.path);
	if (repo === null || path === null) return invalidArgText(theme);
	const normalizedPath = path || defaultPath;
	const target = normalizedPath ? `${repo}:${normalizedPath}` : repo;
	return target ? theme.fg(color, target) : theme.fg("toolOutput", "...");
}

export function formatArg(value: string | null, theme: Theme, decorate: (value: string) => string = value => value): string {
	if (value === null) return invalidArgText(theme);
	return theme.fg("accent", decorate(value));
}

export function formatCompactTextResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	collapsedLines: number,
	limitDetailKey?: "entryLimitReached" | "resultLimitReached",
	limitNoun?: "entries" | "results",
): string {
	const output = getTextOutput(result).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : collapsedLines;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map(line => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
		}
	}
	text += formatTruncationWarnings(result, theme, limitDetailKey, limitNoun);
	return text;
}

export function formatRepoGrepResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme): string {
	const output = getTextOutput(result).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 15;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map(line => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
		}
	}
	text += formatTruncationWarnings(result, theme, "matchLimitReached", "matches", true);
	return text;
}

export function formatRepoReadResult(
	args: { path?: unknown },
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
): string {
	const rawPath = str(args?.path);
	const output = getTextOutput(result);
	const lang = rawPath ? getLanguageFromPath(rawPath) : undefined;
	const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
	const lines = trimTrailingEmptyLines(renderedLines);
	const maxLines = options.expanded ? lines.length : 10;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map(line => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
	}
	const truncation = getTruncation(result);
	if (truncation?.truncated) {
		if (truncation.firstLineExceedsLimit) {
			text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
		} else {
			text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
		}
	}
	return text;
}

export function formatTruncationWarnings(
	result: AgentToolResult<unknown>,
	theme: Theme,
	limitDetailKey?: string,
	limitNoun?: string,
	includeLinesTruncated = false,
): string {
	const details = getDetails(result);
	const warnings: string[] = [];
	const limitValue = limitDetailKey ? details[limitDetailKey] : undefined;
	if (typeof limitValue === "number" && limitNoun) warnings.push(`${limitValue} ${limitNoun} limit`);
	const truncation = getTruncation(result);
	if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
	if (includeLinesTruncated && details.linesTruncated) warnings.push("some lines truncated");
	return warnings.length > 0 ? `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}` : "";
}

export function getTextOutput(result: AgentToolResult<unknown>): string {
	return result.content
		.filter(content => content.type === "text")
		.map(content => ("text" in content && typeof content.text === "string" ? content.text : ""))
		.join("\n")
		.replace(/\r/g, "");
}

export function getDetails(result: AgentToolResult<unknown>): Record<string, unknown> {
	return result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : {};
}

export function getTruncation(result: AgentToolResult<unknown>): TruncationResult | undefined {
	const truncation = getDetails(result).truncation;
	return truncation && typeof truncation === "object" ? truncation as TruncationResult : undefined;
}

export function invalidArgText(theme: Theme): string {
	return theme.fg("error", "[invalid arg]");
}

export function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") end--;
	return lines.slice(0, end);
}

