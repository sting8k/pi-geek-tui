import { GEEK_PREFIX_WIDTH, geekRow } from "../presentation/geek-rows.js";
import type { GeekRail } from "../presentation/geek-rows.js";
import { safeTruncateToWidth } from "../render-budget.js";
import { geekFg } from "../theme/geek-palette.js";
import { renderBashResult } from "./bash.js";
import { renderFindResult } from "./find.js";
import { renderGrepResult } from "./grep.js";
import { renderLsResult } from "./ls.js";
import { renderReadResult } from "./read.js";
import { callLine, callParams } from "./tool-call-line.js";
import { renderOutputBody } from "./tool-row.js";

/**
 * Per-call rows of a tool group (docs/design/geek-ui-spec.md §4):
 *   ├─ R read          tool-tags/tool-groups.ts
 *   └─ $ bash          git log --oneline -5 && …
 * Ctrl+O adds each call's output (capped by maxExpandedLines) under its guide.
 */

export type TreeEntry = { kind: "tool"; tool: any };

const GUIDE_WIDTH = 3;
const GUIDE_BRANCH = "├─ ";
const GUIDE_LAST = "└─ ";
const GUIDE_PIPE = "│  ";

const RESULT_BODIES: Record<string, (result: any, options: any, theme: any, context: any) => { render(width: number): string[] }> = {
	read: renderReadResult,
	bash: renderBashResult,
	grep: renderGrepResult,
	find: renderFindResult,
	ls: renderLsResult,
};

const bodyCache = new WeakMap<object, { result: unknown; body: { render(width: number): string[] } }>();

/** Expanded output of one call, built once per result object (partial updates replace it). */
function expandedBody(entry: TreeEntry): { render(width: number): string[] } | undefined {
	const { tool } = entry;
	if (!tool.result) return undefined;
	const cached = bodyCache.get(tool);
	if (cached && cached.result === tool.result) return cached.body;
	const render = RESULT_BODIES[tool.toolName];
	const body = render ? render(tool.result, { expanded: true }, undefined, { args: tool.args }) : renderOutputBody(tool.result, { expanded: true });
	bodyCache.set(tool, { result: tool.result, body });
	return body;
}

/** The call line for a tool entry (unclipped, styled). */
export function entryLine(entry: TreeEntry, column: number): string {
	const { tool } = entry;
	return callLine(tool.toolName, callParams(tool.toolName, tool.args), column, Boolean(tool.result?.isError));
}

/** Output rows of an entry, each already prefixed with the rail and `indent`. */
export function entryBodyRows(entry: TreeEntry, width: number, rail: GeekRail, indent: string): string[] {
	const body = expandedBody(entry);
	if (!body) return [];
	const bodyWidth = Math.max(1, width - GEEK_PREFIX_WIDTH - indent.length);
	return body.render(bodyWidth).map((line) => geekRow(rail, `${geekFg("faint", indent)}${line}`, width));
}

/** One row per entry under `├─`/`└─` guides; every row is clipped with `…`, never wrapped. */
export function renderToolTree(entries: TreeEntry[], width: number, rail: GeekRail, expanded: boolean, column: number): string[] {
	const rows: string[] = [];
	const lineWidth = Math.max(1, width - GEEK_PREFIX_WIDTH - GUIDE_WIDTH);
	entries.forEach((entry, index) => {
		const last = index === entries.length - 1;
		const line = safeTruncateToWidth(entryLine(entry, column), lineWidth, "…");
		rows.push(geekRow(rail, `${geekFg("faint", last ? GUIDE_LAST : GUIDE_BRANCH)}${line}`, width));
		if (expanded) rows.push(...entryBodyRows(entry, width, rail, last ? " ".repeat(GUIDE_WIDTH) : GUIDE_PIPE));
	});
	return rows;
}
