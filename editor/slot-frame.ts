// Whatever Pi puts in the editor slot besides our GeekEditor (settings/model/session/tree selectors,
// extension select/input/editor dialogs, login boxes…) is shown as the same panel as the slash menu:
//   header   ` settings › thinking level`  (dim, `›` faint)                       `i/N` (faint)
//   body     at most a few rows, windowed to keep the SELECTED row visible (panelSel bg, `› ` marker)
//   hint     Pi's own hint row, or a default one (faint)
// plus our head row and footer below it (the input row stays hidden while a selector is open), 3 blank prefix cells,
// and never wider or taller than the slash panel — the footer always stays on screen.
//
// One seam: InteractiveMode swaps `editorContainer`'s children for every selector, so the container's render is
// patched once. Pi gives no structured model, so rows are classified by shapes every pi-tui list shares: the
// `→ ` selection marker, the `(i/N)` scroll row, border strokes, a trailing hint run, a short title row.
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { GEEK_PREFIX_WIDTH } from "../presentation/geek-rows.js";
import { geekBg, geekFg } from "../theme/geek-palette.js";

/** Components that already render grammar rows (GeekEditor) set this on their prototype. */
export const OWN_EDITOR_ROWS = Symbol.for("pi-geek-tui.slot-frame.own-rows");
const PATCHED = Symbol.for("pi-geek-tui.slot-frame.patched");

const SGR = /\x1b\[[0-9;]*m/g;
const FULL_RESET = /\x1b\[0?m/g;
const BG_RESET = /\x1b\[49m/g;
// Pi marks the cursor row `→ ` (SelectList, SettingsList, model) or `› ` (session, tree, user-message lists).
const MARKER = /^((?:\x1b\[[0-9;]*m| )*)[→›] /;
const COUNTER = /^\((\d+)\/(\d+)\)$/;
const HINT_WORDS = /\b(esc|escape|enter|navigate|ctrl\+|tab|↑↓|to select|to cancel)\b/i;
const DEFAULT_HINT = "↑↓ select · ↩ choose · esc back";
const PAD = 1; // inner horizontal padding of the panel, both sides
const MAX_BODY_ROWS = 8;
const MIN_BODY_ROWS = 3;
const MAX_TITLE_CELLS = 48;
const MAX_CRUMB_CELLS = 60;

const plain = (row: string): string => row.replace(/\x1b\][^\x07]*\x07/g, "").replace(SGR, "");

function surfaceStart(surface: "panel" | "panelSel"): string {
	return geekBg(surface, "\0").split("\0")[0]!;
}

function inkStart(): string {
	return geekFg("ink", "\0").split("\0")[0]!;
}

const isBlank = (row: string): boolean => plain(row).trim() === "";
const isBorder = (row: string): boolean => /^[─\s]+$/.test(plain(row)) && plain(row).includes("─");
const isSkippable = (row: string): boolean => isBlank(row) || isBorder(row);

/** One panel row of `panelWidth` cells: content clamped to the padded inner width, panel bg (or panelSel) surviving the row's own SGR resets. */
function panelRow(row: string, panelWidth: number, surface: "panel" | "panelSel" = "panel"): string {
	const pad = " ".repeat(PAD);
	const clamped = truncateToWidth(row, Math.max(0, panelWidth - 2 * PAD), "", true);
	const bg = surfaceStart(surface);
	const survives = clamped.replace(FULL_RESET, (reset) => `${reset}${bg}${inkStart()}`).replace(BG_RESET, (reset) => `${reset}${bg}`);
	return `${bg}${inkStart()}${pad}${survives}${pad}\x1b[49m\x1b[39m`;
}

type Crumbs = { child?: object; trail: string[] };

/** `SettingsSelectorComponent` → `settings`, `ExtensionSelectorComponent` → `select`. */
function nameOf(child: object): string {
	const raw = child.constructor?.name ?? "";
	const name = raw.replace(/Component$/, "").replace(/(Selector|Dialog)$/, "").replace(/^Extension/, "");
	return (name || "select").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

/** Push/pop a breadcrumb as the title changes (a submenu opens, Esc goes back one level). */
function updateTrail(crumbs: Crumbs, child: object, title: string | undefined): string[] {
	if (crumbs.child !== child) {
		crumbs.child = child;
		crumbs.trail = [title ?? nameOf(child)];
	}
	const trail = crumbs.trail;
	if (!title) {
		trail.length = 1;
	} else if (trail[trail.length - 1] !== title) {
		const back = trail.lastIndexOf(title);
		if (back > 0) trail.length = back + 1;
		else trail.push(title);
	}
	return trail;
}

function headerLeft(trail: string[], room: number): string {
	let text = trail.join(" › ");
	if (visibleWidth(text) > room) {
		// truncate from the LEFT, keeping the deepest levels
		while (visibleWidth(`…${text}`) > room && text.length > 1) text = text.slice(1);
		text = `…${text}`;
	}
	const parts = text.split(" › ");
	return parts.map((part) => geekFg("dim", part)).join(geekFg("faint", " › "));
}

type Classified = {
	title?: string;
	input?: string;
	body: string[];
	selected: number;
	detail?: string;
	hint?: string;
	counter?: string;
};

/** Split Pi's rows into the panel's parts. */
function classify(rows: string[]): Classified {
	const out: Classified = { body: [], selected: -1 };
	const keep = rows.map((_, i) => i).filter((i) => !isSkippable(rows[i]!));

	// A short first text row followed by a gap is a title; anything longer is an info sentence (kept as body).
	const first = keep[0];
	if (first !== undefined) {
		const text = plain(rows[first]!).trim();
		const next = rows[first + 1];
		if (visibleWidth(text) <= MAX_TITLE_CELLS && !text.startsWith(">") && !MARKER.test(rows[first]!) && !COUNTER.test(text) && (next === undefined || isSkippable(next))) {
			out.title = text;
			keep.shift();
		}
	}

	// The last contiguous run of text rows (nothing blank between them) that reads like key hints is the hint row.
	let start = keep.length - 1;
	while (start > 0 && keep[start]! - keep[start - 1]! === 1) start--;
	const run = start >= 0 && keep.length > 0 ? keep.slice(start) : [];
	if (run.length > 0 && !run.some((i) => MARKER.test(rows[i]!) || COUNTER.test(plain(rows[i]!).trim())) && HINT_WORDS.test(run.map((i) => plain(rows[i]!)).join(" "))) {
		out.hint = run.map((i) => plain(rows[i]!).trim()).join(" ");
		keep.length = start;
	}

	let afterCounter = false;
	for (const i of keep) {
		const row = rows[i]!;
		const text = plain(row).trim();
		const counter = COUNTER.exec(text);
		if (counter) {
			out.counter = `${counter[1]}/${counter[2]}`;
			afterCounter = true;
		} else if (afterCounter) {
			out.detail ??= text; // description of the selected item: keep one row
		} else if (text.startsWith(">") && out.input === undefined && out.body.length === 0) {
			out.input = row;
		} else {
			if (MARKER.test(row)) out.selected = out.body.length;
			out.body.push(row.replace(MARKER, "$1› "));
		}
	}
	return out;
}

/** Window of at most `size` rows that keeps `selected` visible (centered when it can be). */
function windowRows<T>(rows: T[], selected: number, size: number): { start: number; rows: T[] } {
	if (rows.length <= size) return { start: 0, rows };
	const anchor = Math.max(0, selected);
	const start = Math.max(0, Math.min(anchor - Math.floor(size / 2), rows.length - size));
	return { start, rows: rows.slice(start, start + size) };
}

type PiList = { selectedIndex: number; maxVisible?: number; maxVisibleLines?: number };

/** Pi's own windowed list inside a slot child (SelectList, SettingsList, SessionList, TreeList…): it keeps its cursor in view itself. */
function findPiList(node: any, depth = 0): PiList | undefined {
	if (!node || depth > 4) return undefined;
	if (typeof node.selectedIndex === "number" && (typeof node.maxVisible === "number" || typeof node.maxVisibleLines === "number")) return node;
	for (const child of Array.isArray(node.children) ? node.children : []) {
		const found = findPiList(child, depth + 1);
		if (found) return found;
	}
	return undefined;
}

/**
 * Shrink Pi's own list window by `overflow` rows so the whole body fits our cap: Pi keeps the cursor centered in its
 * window, so nothing is windowed twice. Returns false when the child exposes no adjustable list.
 */
function shrinkPiList(child: object, overflow: number): boolean {
	const list = findPiList(child);
	if (!list) return false;
	const key = typeof list.maxVisible === "number" ? "maxVisible" : "maxVisibleLines";
	const current = list[key]!;
	if (current <= 1) return false;
	list[key] = Math.max(1, current - overflow);
	return true;
}

/** Panel rows for a foreign slot child: exactly `width` cells each; with `chromeRows` of our own under it, never taller than the terminal. */
function frameSlotChild(child: { render(width: number): string[] }, width: number, terminalRows = 40, crumbs: Crumbs = { trail: [] }, chromeRows = 0): string[] {
	const total = Math.max(0, Math.floor(width));
	if (total <= GEEK_PREFIX_WIDTH) return child.render(total).map((row) => truncateToWidth(row, total, "", true));
	const bodyWidth = total - GEEK_PREFIX_WIDTH;
	const prefix = " ".repeat(GEEK_PREFIX_WIDTH);
	const innerWidth = Math.max(1, bodyWidth - 2 * PAD);
	let model = classify(child.render(innerWidth));

	const trail = updateTrail(crumbs, child, model.title);
	const counter = model.counter ?? "";
	const left = headerLeft(trail, Math.max(4, Math.min(MAX_CRUMB_CELLS, innerWidth - visibleWidth(counter) - 1)));
	const gap = Math.max(1, innerWidth - visibleWidth(left) - visibleWidth(counter));
	const rows: string[] = [panelRow(`${left}${" ".repeat(gap)}${geekFg("faint", counter.trimEnd())}`, bodyWidth)];

	if (model.input !== undefined) rows.push(panelRow(model.input, bodyWidth));
	const budget = Math.max(MIN_BODY_ROWS, Math.min(MAX_BODY_ROWS, Math.floor(terminalRows * 0.4) - rows.length - 2));
	// Fit Pi's own window first; our window below is then only the fallback for lists with a fixed window.
	if (model.body.length > budget && shrinkPiList(child, model.body.length - budget)) model = classify(child.render(innerWidth));
	// No selection marker we know (an extension's own dialog, e.g. pi-askuserquestion's `>`): a window could not follow
	// the cursor and would hide the last rows for good, so show the whole body as far as the screen holds it.
	const fit = model.selected >= 0 ? budget : Math.max(budget, terminalRows - chromeRows - rows.length - (model.detail ? 1 : 0) - 1);
	const windowed = windowRows(model.body, model.selected, fit);
	windowed.rows.forEach((row, i) => rows.push(panelRow(row, bodyWidth, windowed.start + i === model.selected ? "panelSel" : "panel")));
	if (model.detail) rows.push(panelRow(`  ${geekFg("faint", model.detail)}`, bodyWidth));
	rows.push(panelRow(geekFg("faint", model.hint ?? DEFAULT_HINT), bodyWidth));
	return rows.map((row) => prefix + row);
}

type RenderableContainer = { children: any[]; render(width: number): string[] };

function patchContainer(container: RenderableContainer | undefined, mode: any): void {
	if (!container || (container as any)[PATCHED]) return;
	(container as any)[PATCHED] = true;
	const baseRender = container.render.bind(container);
	const crumbs: Crumbs = { trail: [] };
	container.render = (width: number): string[] => {
		const children = container.children;
		if (children.every((child) => child?.[OWN_EDITOR_ROWS])) {
			crumbs.child = undefined;
			return baseRender(width);
		}
		const rows = Number(mode?.ui?.terminal?.rows) || 40;
		// Keep our head row (path, branch, diff, live state) and the footer under the panel: the zone reads the same
		// as depth 1 and the footer, which lives inside the editor, stays on screen.
		const chrome = mode?.editor?.[OWN_EDITOR_ROWS] && typeof mode.editor.renderChrome === "function" ? mode.editor.renderChrome(width) : [];
		const lines = children.flatMap((child) => (child?.[OWN_EDITOR_ROWS] ? child.render(width) : frameSlotChild(child, width, rows, crumbs, chrome.length)));
		return [...lines, ...chrome];
	};
}

/** Frames the editor slot. Must be installed before our editor is set (which creates the patched container's first swap). */
export function installEditorSlotFrame(InteractiveModeClass: any): void {
	const proto = InteractiveModeClass?.prototype;
	if (!proto || proto[PATCHED] || typeof proto.setCustomEditorComponent !== "function") return;
	proto[PATCHED] = true;
	const base = proto.setCustomEditorComponent;
	proto.setCustomEditorComponent = function patchedSetCustomEditorComponent(this: any, ...args: any[]): unknown {
		patchContainer(this.editorContainer, this);
		return base.apply(this, args);
	};
}
