#!/usr/bin/env node
/**
 * Editor slot frame: every selector/dialog Pi puts in the editor slot (real Pi components, swapped in by
 * Pi's real InteractiveMode.setCustomEditorComponent) is shown as the slash-style panel: exactly `width`
 * cells behind the blank rail prefix, header + capped/windowed body + hint, our head row underneath,
 * the selected row always visible, breadcrumb on submenu push/pop. Our own editor passes through.
 */
import { rmSync } from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildSmoke } from "./smoke-build.mjs";

const built = buildSmoke("geek-slot-frame-smoke", ["editor/slot-frame.ts"]);
const { installEditorSlotFrame, OWN_EDITOR_ROWS } = await built.importBuilt("editor/slot-frame.js");
const { GEEK_PREFIX_WIDTH: P } = await built.importBuilt("presentation/geek-rows.js");
const core = await import("@earendil-works/pi-coding-agent");
core.initTheme("dark");
const corePiTui = new URL("../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js", import.meta.url).href;
const { Container, Text } = await import(corePiTui).catch(() => import("@earendil-works/pi-tui"));

const strip = (text) => String(text).replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
const failures = [];
const expect = (name, condition, detail = "") => { if (!condition) failures.push(`${name}${detail ? `: ${detail}` : ""}`); };

const HEAD = (width) => "      • bean@proj".padEnd(width);
const FOOT = (width) => ["─".repeat(width), "  statusline".padEnd(width)];
class OwnEditor { render(width) { return [HEAD(width), "        › input".padEnd(width), ...FOOT(width)]; } renderChrome(width) { return [HEAD(width), ...FOOT(width)]; } setText() {} getText() { return ""; } }
OwnEditor.prototype[OWN_EDITOR_ROWS] = true;
installEditorSlotFrame(core.InteractiveMode);
const mode = {
	editorContainer: new Container(),
	editor: new OwnEditor(),
	defaultEditor: { onSubmit() {}, onChange() {}, getPaddingX: () => 0, actionHandlers: new Map() },
	ui: { setFocus() {}, requestRender() {}, terminal: { rows: 24 } },
	keybindings: {},
	disposeActiveSelector() {}, // Pi 1.x setCustomEditorComponent closes an open selector first
};
core.InteractiveMode.prototype.setCustomEditorComponent.call(mode, () => mode.editor);
const container = mode.editorContainer;
expect("own editor passes through untouched", container.render(80).length === 4 && container.render(80)[1].includes("› input"));

const swapIn = (component) => { container.clear(); container.addChild(component); };
const render = (width, rows = 24) => { mode.ui.terminal.rows = rows; return container.render(width); };
const long = "a very long option text that goes on and on and on for far more than any terminal width could ever hold ".repeat(2);
const options = Array.from({ length: 30 }, (_, i) => `option ${i + 1}`);

// --- real Pi selectors at several widths: exact width, prefix, no strokes, header + hint, head under the panel
const selectors = {
	extSelect: () => new core.ExtensionSelectorComponent("Pick " + long, [long, "short", "Another " + long], () => {}, () => {}),
	extInput: () => new core.ExtensionInputComponent("Enter value " + long, undefined, () => {}, () => {}),
	theme: () => new core.ThemeSelectorComponent("dark", () => {}, () => {}, () => {}),
	thinking: () => new core.ThinkingSelectorComponent("high", ["off", "low", "high"], () => {}, () => {}),
	userMsg: () => new core.UserMessageSelectorComponent([{ id: "1", text: long, timestamp: "2026-01-01" }], () => {}, () => {}),
	manyOptions: () => new core.ExtensionSelectorComponent("Many", options, () => {}, () => {}),
};
for (const width of [112, 62, 30]) {
	for (const [name, make] of Object.entries(selectors)) {
		swapIn(make());
		const all = render(width);
		const rows = all.slice(0, -3); // the panel; the last 3 rows are our head + footer chrome
		expect(`${name}@${width}: every panel row exactly ${width} cells`, rows.every((row) => visibleWidth(row) === width), JSON.stringify(rows.map(visibleWidth)));
		expect(`${name}@${width}: blank prefix cells`, rows.every((row) => strip(row).slice(0, P).trim() === ""));
		expect(`${name}@${width}: first and last panel cell of every row is a bg-only space`, rows.every((row) => row.slice(P).startsWith("\x1b[48;2;") && strip(row)[P] === " " && strip(row).at(-1) === " "), JSON.stringify(rows.map((row) => [strip(row)[P], strip(row).at(-1)])));
		expect(`${name}@${width}: no stock border strokes`, !rows.some((row) => /─{3,}/.test(strip(row))));
		expect(`${name}@${width}: head + footer stay under the panel`, strip(all[all.length - 3]).startsWith("      • bean@proj") && strip(all[all.length - 1]).includes("statusline"), JSON.stringify(all.slice(-3).map(strip)));
		if (name === "extInput") {
			// No list marker: the wrapped prompt is never cut down to the cap, so the input field under it stays visible.
			expect(`${name}@${width}: input field shown, everything fits the terminal`, rows.some((row) => strip(row).slice(P).trim() === ">") && all.length <= 24, JSON.stringify(all.map(strip)));
		} else {
			expect(`${name}@${width}: panel within the cap (24 rows → ≤ 40%)`, rows.length <= 1 + 8 + 1 + 1 + 1, String(rows.length));
		}
	}
}

// --- cap + windowing: 30 options never exceed the cap, and ↑↓ scrolling keeps the selection visible
swapIn(selectors.manyOptions());
const list = container.children[0];
for (const step of [0, 1, 7, 15, 29, 12, 0]) {
	while ((list.selectedIndex ?? 0) < step) list.handleInput("\x1b[B");
	while ((list.selectedIndex ?? 0) > step) list.handleInput("\x1b[A");
	const rows = render(80).map(strip);
	expect(`selected option ${step + 1} stays visible and marked`, rows.some((row) => row.slice(P).trimStart().startsWith(`› option ${step + 1}`)), JSON.stringify(rows));
	expect(`window cap holds at option ${step + 1}`, rows.length - 5 <= 1 + 8 + 1 + 1 + 1, String(rows.length));
}
const tall = render(80, 60).length;
const short = render(80, 14).length;
expect("cap shrinks with the terminal height", short < tall, `${short} vs ${tall}`);
expect("selected row sits on the panelSel surface", render(80).some((row) => row.includes("48;2;32;31;27m") && strip(row).includes("› option")));

// --- /resume: Pi's SessionSelector windows its own list and marks the cursor `› `; the item Enter would open is always
// shown, marked, on panelSel, and the window follows it (↓ ×5/×20/×60, ↑ back, filter).
const sessions = Array.from({ length: 70 }, (_, i) => ({ path: `/s/${i}.jsonl`, id: `id${i}`, cwd: "/p", name: undefined, firstMessage: `session number ${i + 1}`, allMessagesText: `session number ${i + 1}`, messageCount: 2, created: new Date(2026, 0, 1), modified: new Date(2026, 0, 1, 0, 70 - i) }));
const resume = new core.SessionSelectorComponent(async () => sessions, async () => sessions, () => {}, () => {}, () => {}, () => {}, {});
swapIn(resume);
await new Promise((resolve) => setTimeout(resolve, 20));
const sessionList = resume.sessionList;
const showsSelected = (label, rows) => {
	const want = sessionList.filteredSessions[sessionList.selectedIndex].session.firstMessage;
	const hit = rows.find((row) => strip(row).slice(P).trimStart().startsWith(`› ${want} `));
	expect(`resume ${label}: selected "${want}" visible, marked and on panelSel`, hit !== undefined && hit.includes("48;2;32;31;27m"), JSON.stringify(rows.map(strip)));
	expect(`resume ${label}: within the cap`, rows.length - 3 <= 1 + 1 + 8 + 1 + 1 + 1, String(rows.length));
};
for (const [label, keys] of [["start", ""], ["↓×5", "\x1b[B".repeat(5)], ["↓×20", "\x1b[B".repeat(15)], ["↓×60", "\x1b[B".repeat(40)], ["↑×30", "\x1b[A".repeat(30)]]) {
	for (const key of keys.match(/\x1b\[[AB]/g) ?? []) resume.handleInput(key);
	for (const rows of [24, 70]) showsSelected(`${label}@${rows} rows`, render(100, rows));
}
for (const ch of "number 4") resume.handleInput(ch);
resume.handleInput("\x1b[B");
showsSelected("filtered", render(100, 40));

// --- header: crumb from the component, i/N counter, Pi's hint row kept, default hint otherwise
swapIn(selectors.thinking());
const thinkingRows = render(80).map(strip);
expect("header shows the selector's own title (Pi 1.x selectors carry one)", new RegExp(`^ {${P}} Thinking Level\\b`).test(thinkingRows[0]), thinkingRows[0]);
const thinkingPanel = thinkingRows.slice(0, -3);
expect("a hint row closes the panel", /esc|enter|select/i.test(thinkingPanel[thinkingPanel.length - 1]), thinkingPanel[thinkingPanel.length - 1]);

// --- breadcrumb: a submenu title pushes a level (left-truncated when long), the root title pops back
class FakeSettings extends Container {}
const settings = new FakeSettings();
const state = { title: undefined };
settings.render = () => [
	...(state.title ? [` ${state.title}`, ""] : []),
	"> ",
	"",
	"\x1b[36m→ \x1b[39mAuto-compact    true",
	"  Block images    false",
	"  (1/2)",
	"",
	"  Type to search · Enter/Space to change · Esc to cancel",
];
swapIn(settings);
const headerOf = () => strip(render(80)[0]).trimEnd();
expect("depth 1 header = component name", new RegExp(`^ {${P}} fake settings`).test(headerOf()), headerOf());
state.title = "Per-Model Thinking Level";
expect("depth 2 pushes a crumb", headerOf().includes("fake settings › Per-Model Thinking Level"), headerOf());
state.title = "Select thinking level";
expect("depth 3 pushes another", headerOf().includes("› Per-Model Thinking Level › Select thinking level"), headerOf());
state.title = "Per-Model Thinking Level";
expect("Esc pops exactly one level", headerOf().includes("Per-Model Thinking Level") && !headerOf().includes("Select thinking level"), headerOf());
state.title = undefined;
expect("Esc back to the root list", !headerOf().includes("›") && headerOf().includes("fake settings"), headerOf());
state.title = "A very long submenu title that keeps going";
const narrow = strip(render(40)[0]).trimEnd();
expect("long crumbs truncate from the LEFT with an ellipsis", narrow.includes("…") && narrow.includes("keeps going") && visibleWidth(render(40)[0]) === 40, narrow);
state.title = undefined;
expect("counter `1/2` goes to the right of the header", /1\/2 *$/.test(headerOf()), headerOf());
expect("search input row kept, detail/blank rows dropped", render(80).map(strip).some((row) => row.slice(P).trim().startsWith(">")));

// --- an extension's own dialog (rows as pi-askuserquestion draws them: `>` cursor, descriptions, a last free-text option):
// no Pi list to shrink and no marker we know, so nothing may be cut while it fits on screen, and it never pushes the footer off.
class FakeDialog extends Container {}
const dialog = new FakeDialog();
dialog.render = (width) => [
	"─".repeat(width),
	" Which approach should we take for the cache layer?",
	"",
	...["Redis", "In-memory LRU", "SQLite", "No cache"].flatMap((label, i) => [`${i === 0 ? ">" : " "}   ${i + 1}. ${label}`, `     description of ${label}`]),
	"    5. Type your own answer...",
	"",
	" ↑↓ navigate · Enter select · Esc cancel",
	"─".repeat(width),
];
swapIn(dialog);
const dialogRows = render(100, 45).map(strip);
expect("extension dialog: last option shown", dialogRows.some((row) => row.includes("5. Type your own answer...")), JSON.stringify(dialogRows));
expect("extension dialog: every option shown", ["Redis", "In-memory LRU", "SQLite", "No cache"].every((label) => dialogRows.some((row) => row.includes(`. ${label}`))), JSON.stringify(dialogRows));
for (const height of [45, 14, 10]) expect(`extension dialog @${height} rows: panel + chrome fit the terminal`, render(100, height).length <= height, String(render(100, height).length));

// --- Esc path: back to our editor, rows unframed again
swapIn(new OwnEditor());
expect("Esc path: back to the editor", render(80).length === 4 && render(80)[1].includes("› input"));

swapIn(selectors.theme());
console.log(render(70).map(strip).join("\n"));
swapIn(selectors.manyOptions());
console.log(render(70).map(strip).join("\n"));
rmSync(built.workDir, { recursive: true, force: true });
if (failures.length) {
	console.error(`geek slot frame smoke FAILED (${failures.length}):\n- ${failures.join("\n- ")}`);
	process.exit(1);
}
console.log("geek slot frame smoke ok");
