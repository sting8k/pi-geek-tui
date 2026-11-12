import { safeTruncateToWidth, safeVisibleWidth } from "../render-budget.js";
import { type GeekColorRole, geekBg, geekFg } from "../theme/geek-palette.js";

/**
 * One tool call as `R tool-tags/tool-groups.ts` or `· piggery_send  to tools · kind relay` (docs/design/
 * geek-ui-spec.md §4): common tools (read/bash/edit/write/grep/find/ls) are a colored 1-cell badge plus
 * their primary arg; other tools get `·`, the raw name in punct padded to a shared column, and `key value`
 * pairs with faint keys.
 * Used by group rows, tree rows and standalone call rows so every call reads the same.
 */

const MAX_PARAM_VALUE = 120;

/** Pi 1.1.0 built-ins (core/tools allToolNames) carry a dedicated badge that stands for the name; exact names only. */
const BADGES: Record<string, { letter: string; bg: GeekColorRole }> = {
	read: { letter: "R", bg: "badgeBg" },
	bash: { letter: "$", bg: "num" },
	powershell: { letter: "$", bg: "num" },
	edit: { letter: "E", bg: "kw" },
	write: { letter: "W", bg: "kw" },
	grep: { letter: "G", bg: "badgeBg" },
	find: { letter: "F", bg: "badgeBg" },
	ls: { letter: "L", bg: "badgeBg" },
};

function isCommonTool(toolName: string): boolean {
	return Object.prototype.hasOwnProperty.call(BADGES, toolName);
}

/** 1-cell colored badge; `·` for tools without a dedicated one; del marker background when failed. */
function badge(toolName: string, failed = false): string {
	const known = isCommonTool(toolName) ? BADGES[toolName] : undefined;
	return geekBg(failed ? "delMark" : (known?.bg ?? "badgeBg"), geekFg("badgeFg", known?.letter ?? "·"));
}

function opsSummary(items: unknown[]): string | undefined {
	if (!items.every((item) => item && typeof item === "object" && !Array.isArray(item))) return undefined;
	const types = Array.from(new Set(items.map((item: any) => String(item.type ?? "operation"))));
	const detail = types.length === 1 ? ` (${types[0]})` : ` (${types.slice(0, 3).join(", ")}${types.length > 3 ? ", …" : ""})`;
	return `${items.length} ${items.length === 1 ? "operation" : "operations"}${detail}`;
}

/** Single-line display value for one param. */
function formatParamValue(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") {
		const flat = value.replace(/\s+/g, " ").trim();
		return flat.length > MAX_PARAM_VALUE ? `${flat.slice(0, MAX_PARAM_VALUE - 1)}…` : flat;
	}
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		return opsSummary(value) ?? `${value.length} ${value.length === 1 ? "item" : "items"}`;
	}
	if (value && typeof value === "object") {
		const keys = Object.keys(value);
		return keys.length === 0 ? "{}" : `{${keys.length} ${keys.length === 1 ? "key" : "keys"}}`;
	}
	return String(value ?? "");
}

const LEADING_CD = /^\s*cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/;

/** `cd /long/project/path && git log` names the command, not the directory every call shares. */
function stripLeadingCd(command: string): string {
	let rest = command;
	while (LEADING_CD.test(rest)) rest = rest.replace(LEADING_CD, "");
	return rest.trim() ? rest : command;
}

const MIN_NAME_COLUMN = 4;
const MAX_NAME_COLUMN = 16;

/** Shared name column for a group's generic rows: longest name + 2, clamped to 4..16 (common tools have no name). */
export function nameColumn(toolNames: string[]): number {
	const longest = Math.max(0, ...toolNames.filter((name) => !isCommonTool(name)).map((name) => safeVisibleWidth(name)));
	return Math.max(MIN_NAME_COLUMN, Math.min(MAX_NAME_COLUMN, longest + 2));
}

/** Params sit two steps below the answer text: punct values and names (the mockup path color), faint keys and separators. */
const param = (text: string) => geekFg("punct", text);
const faint = (text: string) => geekFg("faint", text);

function field(args: any, ...keys: string[]): string {
	if (!args || typeof args !== "object") return "";
	for (const key of keys) {
		const value = args[key];
		if (value !== undefined && value !== null && value !== "") return formatParamValue(value);
	}
	return "";
}

/** Primary arg not streamed in yet. */
const MISSING = faint("…");

function readTarget(args: any): string {
	const path = field(args, "path", "file_path");
	if (!path) return "";
	const offset = Number(args?.offset);
	const limit = Number(args?.limit);
	const hasOffset = Number.isFinite(offset) && args?.offset !== undefined && args?.offset !== null;
	const hasLimit = Number.isFinite(limit) && args?.limit !== undefined && args?.limit !== null;
	if (hasOffset && hasLimit) return `${path}:${offset}-${offset + limit - 1}`;
	if (hasOffset) return `${path}:${offset}+`;
	if (hasLimit) return `${path}:1-${limit}`;
	return path;
}

/** Styled params: primary arg for built-ins (`…` while args are still streaming), `key value` pairs for the rest. */
export function callParams(toolName: string, args: any): string {
	switch (toolName) {
		case "read":
			return readTarget(args) ? param(readTarget(args)) : MISSING;
		case "write":
		case "edit":
			return field(args, "path", "file_path") ? param(field(args, "path", "file_path")) : MISSING;
		case "ls":
			return param(field(args, "path") || ".");
		case "bash":
		case "powershell": {
			const command = typeof args?.command === "string" ? formatParamValue(stripLeadingCd(args.command)) : "";
			return command ? param(command) : MISSING;
		}
		case "grep":
		case "find": {
			const pattern = field(args, "pattern");
			if (!pattern) return MISSING;
			const quoted = toolName === "grep" ? `${faint('"')}${param(pattern)}${faint('"')}` : param(pattern);
			const where = field(args, "path");
			const glob = field(args, "glob");
			return `${quoted}${where && where !== "." ? `${faint(" in ")}${param(where)}` : ""}${glob ? `${faint(" glob ")}${param(glob)}` : ""}`;
		}
	}
	if (args === null || args === undefined) return MISSING;
	if (typeof args !== "object" || Array.isArray(args)) return param(formatParamValue(args)) || MISSING;
	const pairs = Object.entries(args as Record<string, unknown>)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => `${faint(key)} ${param(formatParamValue(value))}`);
	return pairs.length > 0 ? pairs.join(faint(" · ")) : MISSING;
}

/** Common tool: `badge params`. Other tools: `· name<pad>params`. `failed` marks the badge (and name) with the del marker. */
export function callLine(toolName: string, params: string, column: number, failed = false): string {
	if (isCommonTool(toolName)) return `${badge(toolName, failed)} ${params}`;
	const name = safeTruncateToWidth(toolName, column - 1, "…");
	const pad = " ".repeat(Math.max(1, column - safeVisibleWidth(name)));
	return `${badge(toolName, failed)} ${geekFg(failed ? "delMark" : "punct", name)}${pad}${params}`;
}

/** Standalone call: name column fits just this tool. */
export function soloLine(toolName: string, params: string, failed = false): string {
	return callLine(toolName, params, nameColumn([toolName]), failed);
}

/** Params for a call whose detail the renderer already built (edit/write paths); empty → `…`. */
export function paramText(detail: string): string {
	return detail ? param(detail) : MISSING;
}
