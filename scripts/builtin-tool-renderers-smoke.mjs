#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";

const repoRoot = process.cwd();
// Unique per run: concurrent smoke runs (or parallel agent sessions) must not
// race each other on a shared fixed build dir.
const workDir = mkdtempSync(join(repoRoot, ".pi", "builtin-tool-renderers-smoke-"));
const buildDir = join(workDir, "build");
const stubPath = join(workDir, "node-stubs.d.ts");
const tsc = join(repoRoot, "node_modules", "typescript", "lib", "tsc.js");
// edit reads diffMode from ~/.pi/agent/pi-geek-tui.json: keep the user's real config out of the run.
process.env.HOME = workDir;

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function prepareWorkDir() {
	mkdirSync(buildDir, { recursive: true });
	writeFileSync(join(buildDir, "package.json"), "{\"type\":\"module\"}\n", "utf8");
	writeFileSync(stubPath, `declare module "@earendil-works/pi-coding-agent" {
	export type AgentToolResult<T> = any;
	export type ToolRenderResultOptions = any;
	export type ExtensionAPI = any;
	export type Theme = any;
	export const getLanguageFromPath: any;
	export const highlightCode: any;
	export const createEditToolDefinition: any;
	export const ToolExecutionComponent: any;
	export const getAgentDir: any;
}
declare module "@earendil-works/pi-tui" {
	export type Component = any;
	export const Text: any;
	export const truncateToWidth: any;
	export const visibleWidth: any;
	export const wrapTextWithAnsi: any;
}
declare module "node:fs";
declare module "node:path";
declare module "node:url";
declare module "node:os";
declare module "fs";
declare module "path";
declare module "os";
declare const process: any;
`, "utf8");

	// Runtime stubs so the compiled modules do not load the real SDK.
	const stubAgentPkgDir = join(buildDir, "node_modules", "@earendil-works", "pi-coding-agent");
	mkdirSync(stubAgentPkgDir, { recursive: true });
	writeFileSync(join(stubAgentPkgDir, "package.json"), "{\"name\":\"@earendil-works/pi-coding-agent\",\"version\":\"0.0.0-stub\",\"type\":\"module\",\"main\":\"index.js\"}\n", "utf8");
	writeFileSync(join(stubAgentPkgDir, "index.js"), `export const getLanguageFromPath = (path) => (String(path).endsWith(".ts") ? "typescript" : undefined);
// keyword gets a fg color and a plain fg reset; identifiers stay uncolored like hljs output
export const highlightCode = (code) => String(code).split("\\n").map((line) => line.replace(/\\bconst\\b/, "\\x1b[38;2;104;158;128mconst\\x1b[39m"));
export const getAgentDir = () => "/nonexistent-agent-dir";
export class ToolExecutionComponent {}
`, "utf8");
}

function compileBuiltinToolRenderers() {
	if (!existsSync(tsc)) throw new Error("typescript is not installed; run npm install before npm run test:builtin-tool-renderers");
	const result = spawnSync(process.execPath, [
		tsc,
		"--outDir", buildDir,
		"--rootDir", repoRoot,
		"--module", "NodeNext",
		"--moduleResolution", "NodeNext",
		"--target", "ES2022",
		"--skipLibCheck",
		"--noImplicitAny", "false",
		stubPath,
		"tool-tags/builtin-tool-renderers.ts",
		"tool-tags/elapsed.ts",
		"tool-tags/common.ts",
		"tool-tags/tool-groups.ts",
		"tool-tags/compact-tool-spacing.ts",
	], { cwd: repoRoot, encoding: "utf8" });
	if (result.status !== 0) {
		process.stderr.write(result.stdout || "");
		process.stderr.write(result.stderr || "");
		throw new Error(`TypeScript compile failed with code ${result.status}`);
	}
	console.log("tsc builtin tool renderers ok");
}

function makeFakeComponentClass() {
	let baseCallCalls = 0;
	let baseResultCalls = 0;
	let baseShellCalls = 0;
	class FakeToolExecutionComponent {
		getCallRenderer() {
			baseCallCalls++;
			return this.toolDefinition?.renderCall;
		}
		getResultRenderer() {
			baseResultCalls++;
			return this.toolDefinition?.renderResult;
		}
		getRenderShell() {
			baseShellCalls++;
			return this.toolDefinition?.renderShell;
		}
	}
	return { FakeToolExecutionComponent, baseCallCount: () => baseCallCalls, baseResultCount: () => baseResultCalls, baseShellCount: () => baseShellCalls };
}

async function runBuiltinToolRenderersSmoke() {
	const buildToolTags = (name) => pathToFileURL(join(buildDir, "tool-tags", name)).href;
	const renderers = await import(buildToolTags("builtin-tool-renderers.js"));
	const elapsed = await import(buildToolTags("elapsed.js"));

	const theme = { fg: (_color, text) => text };

	const toolModules = {
		read: await import(buildToolTags("read.js")),
		write: await import(buildToolTags("write.js")),
		edit: await import(buildToolTags("edit.js")),
		ls: await import(buildToolTags("ls.js")),
		find: await import(buildToolTags("find.js")),
		grep: await import(buildToolTags("grep.js")),
		bash: await import(buildToolTags("bash.js")),
	};

	// --- 1. Patch resolution ---
	const { FakeToolExecutionComponent, baseCallCount, baseResultCount, baseShellCount } = makeFakeComponentClass();
	renderers.installBuiltinToolRenderers(FakeToolExecutionComponent);

	const expected = {
		read: ["renderReadCall", "renderReadResult"],
		write: ["renderWriteCall", "renderWriteResult"],
		edit: ["renderEditCall", "renderEditResult"],
		ls: ["renderLsCall", "renderLsResult"],
		find: ["renderFindCall", "renderFindResult"],
		grep: ["renderGrepCall", "renderGrepResult"],
		bash: ["renderBashCall", "renderBashResult"],
	};

	for (const [toolName, [callName, resultName]] of Object.entries(expected)) {
		const instance = Object.assign(new FakeToolExecutionComponent(), { toolName, toolDefinition: {} });
		const callRenderer = instance.getCallRenderer();
		const resultRenderer = instance.getResultRenderer();
		assert(typeof callRenderer === "function", `${toolName}: patched getCallRenderer did not return a function`);
		assert(callRenderer === toolModules[toolName][callName], `${toolName}: call renderer is not the droid ${callName}`);
		assert(typeof resultRenderer === "function", `${toolName}: patched getResultRenderer did not return a function`);
		assert(resultRenderer === toolModules[toolName][resultName], `${toolName}: result renderer is not the droid ${resultName}`);
		assert(instance.getRenderShell() === "self", `${toolName}: getRenderShell did not return "self"`);
	}

	// Unknown names fall through to the base methods.
	const unknownInstance = Object.assign(new FakeToolExecutionComponent(), { toolName: "other_tool", toolDefinition: { renderShell: "self" } });
	assert(unknownInstance.getCallRenderer() === undefined, "unknown tool name did not fall through to base getCallRenderer");
	assert(unknownInstance.getResultRenderer() === undefined, "unknown tool name did not fall through to base getResultRenderer");
	assert(unknownInstance.getRenderShell() === "self", "unknown tool name did not fall through to base getRenderShell");
	assert(baseCallCount() === 1 && baseResultCount() === 1 && baseShellCount() === 1, "base methods were not called exactly once for the unknown tool name");

	// Double install must not double-wrap (Symbol.for guards).
	const callRendererFn = FakeToolExecutionComponent.prototype.getCallRenderer;
	const resultRendererFn = FakeToolExecutionComponent.prototype.getResultRenderer;
	const renderShellFn = FakeToolExecutionComponent.prototype.getRenderShell;
	renderers.installBuiltinToolRenderers(FakeToolExecutionComponent);
	assert(FakeToolExecutionComponent.prototype.getCallRenderer === callRendererFn, "double install re-wrapped getCallRenderer");
	assert(FakeToolExecutionComponent.prototype.getResultRenderer === resultRendererFn, "double install re-wrapped getResultRenderer");
	assert(FakeToolExecutionComponent.prototype.getRenderShell === renderShellFn, "double install re-wrapped getRenderShell");

	// --- 2. Timing resolution ---
	// Recorded start/end events resolve by toolCallId.
	elapsed.recordToolCallTimingStart("t1");
	elapsed.recordToolCallTimingEnd("t1");
	const recorded = elapsed.resolveToolCallElapsedMs({ toolCallId: "t1" }, undefined);
	assert(typeof recorded === "number" && recorded >= 0, "recorded start/end did not resolve elapsed by toolCallId");

	// Frozen state wins over later records.
	elapsed.recordToolCallTimingStart("t2");
	elapsed.recordToolCallTimingEnd("t2");
	const frozenState = { __geekElapsedMs: 999 };
	assert(elapsed.resolveToolCallElapsedMs({ state: frozenState, toolCallId: "t2" }, undefined) === 999, "frozen state value did not win over event records");

	// result.details.__elapsedMs fallback when no record exists.
	assert(elapsed.resolveToolCallElapsedMs({ toolCallId: "t3" }, { details: { __elapsedMs: 1234 } }) === 1234, "details.__elapsedMs fallback did not resolve");


	// --- 4. Edit results: meta on the call row, diff rows below, per file ---
	const strip = (text) => String(text).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
	const WIDTH = 90;
	const editBlock = (args, result, isError = false) => {
		const context = { args, isError, cwd: "/repo", state: { __geekElapsedMs: 100 }, toolCallId: "edit-1", isPartial: false };
		const body = toolModules.edit.renderEditResult(result, { expanded: false, isPartial: false }, theme, context).render(WIDTH);
		const call = toolModules.edit.renderEditCall(args, theme, context).render(WIDTH);
		return { body: body.map(strip), call: call.map(strip) };
	};
	const editBlockRaw = (args, result) => {
		const context = { args, isError: false, cwd: "/repo", state: { __geekElapsedMs: 100 }, toolCallId: "edit-2", isPartial: false };
		const body = toolModules.edit.renderEditResult(result, { expanded: false, isPartial: false }, theme, context);
		return { body, call: toolModules.edit.renderEditCall(args, theme, context) };
	};
	const scriptArgs = { paths: ["src/a.ts", "b.md"], code: "x" };

	const failed = editBlock(scriptArgs, {
		isError: true,
		content: [{ type: "text", text: "script edit failed (exit 1) — rolled back to snapshot.\nstderr:\nreplaceOnce: expected 1 match(es) of \"missing\" in n.txt, found 0" }],
		details: { diff: "", patch: "" },
	}, true);
	assert(failed.body.every((line) => !line.includes("\n")), "edit error output embedded a newline inside a row");
	assert(failed.body.some((line) => line.includes("found 0")), "edit error output hid the stderr cause");
	assert(failed.call[0].includes("failed"), "failed edit did not say so on its call row");

	const noop = editBlock(scriptArgs, { content: [{ type: "text", text: "WARNING: no declared file changed.\nstdout:\n0 matches for foo" }], details: { diff: "", patch: "" } });
	assert(noop.body.some((line) => line.includes("0 matches for foo")), "edit no-change output hid the script stdout");

	const multi = editBlock(scriptArgs, {
		content: [{ type: "text", text: "x" }],
		details: { patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-one\n+ONE\n--- a/b.md\n+++ b/b.md\n@@ -0,0 +1,1 @@\n+---" },
	});
	assert(multi.body.some((line) => line.includes("▸ src/a.ts")) && multi.body.some((line) => line.includes("▸ b.md")), "multi-file edit diff lost its file titles");
	assert(multi.call[0].includes("+2") && multi.call[0].includes("-1"), `script-mode diff stats skipped a '+---' content line: ${multi.call[0]}`);

	// Two hunks: the unchanged run between them folds into one gap row; context around hunks is dropped.
	const twoHunks = editBlock({ path: "src/a.ts" }, { content: [{ type: "text", text: "x" }], details: { diff: ["  1 one", "- 2 two", "+ 2 TWO", "  3 three", "    ...", " 10 ten", "-11 eleven", "+11 ELEVEN", " 12 twelve"].join("\n") } });
	assert(twoHunks.body.filter((line) => line.includes("··· 8 unchanged lines ···")).length === 1, `expected exactly one gap row, got ${JSON.stringify(twoHunks.body)}`);
	assert(!twoHunks.body.some((line) => /\bone\b|twelve/.test(line)), "context before the first / after the last change should be dropped");
	assert(twoHunks.body.every((line) => visibleWidth(line) <= WIDTH), "diff row overflowed the body width");
	const delIndex = twoHunks.body.findIndex((line) => line.includes("- two"));
	assert(delIndex >= 0 && twoHunks.body[delIndex + 1].includes("+ TWO"), "removed line must be followed by its added line");

	// Pi's builtin gutter diff folds context with an unnumbered "..." line: one gap, counted from the next line.
	const splitDiff = await import(pathToFileURL(join(buildDir, "split-diff.js")).href);
	const piRows = splitDiff.buildDiffRows(["  7 line 7", "    ...", " 27 line 27", "-28 old", "+28 new", " 29 line 29", "    ..."].join("\n"));
	const piGaps = piRows.filter((row) => row.kind === "gap");
	assert(piGaps.length === 2 && piGaps[0].count === 19 && piGaps[1].count === undefined, `Pi "..." markers should become gap rows (19, unknown), got ${JSON.stringify(piGaps)}`);
	assert(!piRows.some((row) => row.left?.line.trim() === "..."), "Pi \"...\" marker still rendered as a code line");
	const afterGap = piRows.find((row) => row.left?.line === "line 27");
	assert(afterGap?.right?.lineNumber.trim() === "27", `new-side numbering did not skip the folded lines, got ${afterGap?.right?.lineNumber}`);

	// --- 5. Tool groups: `Done(…)` head + one row per call; a lone call is just its row ---
	const groups = await import(buildToolTags("tool-groups.js"));
	const tool = (toolName, args, extra = {}) => ({
		toolCallId: `${toolName}-${Math.random()}`, toolName, args, expanded: false, isPartial: false,
		rendererState: {}, result: { content: [], details: { __elapsedMs: 500 } }, render: (w) => [`RAW ${toolName}`.padEnd(w)], ...extra,
	});
	const assistant = (thinking, text) => ({
		lastMessage: { role: "assistant", content: [...(thinking ? [{ type: "thinking", thinking }] : []), ...(text ? [{ type: "text", text }] : []), { type: "toolCall" }] },
		render: (w) => [`ASSISTANT`.padEnd(w)],
	});
	const finished = [
		assistant(),
		tool("read", { path: "src/auth/session.ts" }),
		tool("read", { path: "src/auth/token.ts" }),
		tool("grep", { pattern: "REFRESH_TTL", path: "src" }),
		tool("piggery_send", { to: "tools", kind: "relay", body: "QUEUED\nafter P0" }),
	];
	for (const width of [120, 80, 50]) {
		const rows = groups.renderChatChildren(finished, width).map(strip);
		assert(rows.length === 6 && rows.every((row) => visibleWidth(row) === width), `@${width}: head + 4 call rows + blank, each exactly the chat width, never wrapped: ${JSON.stringify(rows)}`);
		assert(rows[0].startsWith(" ┃ Done(4 tool calls)"), `@${width}: head: ${rows[0]}`);
		assert(rows[1].includes("├─ R src/auth/session.ts") || width < 80, `@${width}: ${rows[1]}`);
		if (width === 120) {
			assert(rows[0].includes("^o  // 2.0s"), `head meta: ${rows[0]}`);
			assert(rows[2].includes("├─ R src/auth/token.ts") && rows[3].includes('├─ G "REFRESH_TTL" in src'), `common tools are badge + primary arg: ${rows[2]} / ${rows[3]}`);
			assert(rows[4].includes("└─ · piggery_send  to tools · kind relay · body QUEUED after P0"), `other tools: dot badge, dim name, key value pairs: ${rows[4]}`);
		}
	}

	// Lone call: no head, no guide; bash drops its leading cd; Ctrl+O hint on the right.
	const lone = groups.renderChatChildren([tool("bash", { command: "cd /Users/bean/proj && ls -la\necho" })], 100).map(strip);
	assert(lone.length === 2 && lone[0].startsWith(" ┃ $ ls -la") && lone[0].includes("^o  // 0.5s") && !lone[0].includes("Done("), `lone call row: ${JSON.stringify(lone)}`);

	// Running head names the live tool; failed calls are counted and their badge turns del-marker.
	const runningRows = groups.renderChatChildren([tool("read", { path: "a.ts" }), tool("bash", { command: "pnpm test" }, { result: undefined, isPartial: true, rendererState: { __geekStartedAt: performance.now() - 4100 } })], 100).map(strip);
	assert(runningRows[0].startsWith(" ┃ Running(2 tool calls · bash)") && runningRows[0].includes("^o  // 4.6s"), `running head: ${runningRows[0]}`);
	const failedRaw = groups.renderChatChildren([tool("read", { path: "a.ts" }), tool("bash", { command: "boom" }, { result: { content: [{ type: "text", text: "x" }], isError: true } })], 100);
	assert(strip(failedRaw[0]).includes("Done(2 tool calls · 1 failed)") && failedRaw[2].includes("\x1b[48;2;221;86;112m\x1b[38;2;12;12;12m$"), "failed call: counted in the head, badge on the del-marker bg");

	// Param formatting for generic tools: single-line, ~120 cut, arrays/objects summarized; names align.
	const generic = groups.renderChatChildren([
		tool("custom_tool", { items: [1, 2, 3], ops: [{ type: "a" }, { type: "a" }], obj: { a: 1, b: 2 }, multi: "a\nb", text: "x".repeat(300), skip: undefined }),
		tool("ab", { k: "v" }),
	], 400).map(strip);
	assert(generic[1].includes("items 3 items · ops 2 operations (a) · obj {2 keys} · multi a b · text " + "x".repeat(119) + "…") && !generic[1].includes("skip"), `generic params: ${generic[1]}`);
	assert(generic[1].indexOf("items") === generic[2].indexOf("k v"), "generic rows share one name column");

	// "No tool missing": every Pi built-in, with full / partial / empty / non-object args, gets exactly one
	// non-blank row with the right badge at 120 and 50 cols; look-alike names stay generic (no suffix heuristics).
	const BUILTINS = { read: "R", bash: "$", powershell: "$", edit: "E", write: "W", grep: "G", find: "F", ls: "L" };
	const FULL = {
		read: { path: "src/a.ts", offset: 10, limit: 5 }, bash: { command: "cd /x && git log -5" }, powershell: { command: "Get-ChildItem" },
		edit: { path: "src/a.ts", edits: [] }, write: { path: "src/a.ts", content: "x" }, grep: { pattern: "TTL", path: "src", glob: "*.ts" },
		find: { pattern: "*.ts", path: "src" }, ls: { path: "src" },
	};
	for (const [name, letter] of Object.entries(BUILTINS)) {
		for (const [shape, args] of [["full", FULL[name]], ["partial", {}], ["empty", undefined], ["non-object", "oops"]]) {
			for (const width of [120, 50]) {
				// edit/write stand alone (never folded): their call renderer draws the row at body width.
				const standalone = name === "edit" || name === "write";
				const rows = standalone
					? toolModules[name][name === "edit" ? "renderEditCall" : "renderWriteCall"](args, theme, { state: {}, cwd: "/repo", isPartial: false }).render(width - 3).map((line) => `   ${strip(line)}`)
					: groups.renderChatChildren([tool(name, args)], width).map(strip);
				const row = rows[0] ?? "";
				assert((standalone ? rows.length === 1 : rows.length === 2) && row.length >= 3 && row.slice(3).trim().length > 1 && (standalone || visibleWidth(row) === width), `${name}/${shape}@${width}: one non-blank row: ${JSON.stringify(rows)}`);
				assert(row.slice(3).startsWith(`${letter} `), `${name}/${shape}@${width}: badge ${letter}: ${row}`);
				if (shape !== "full" && name !== "ls" && !(standalone && shape === "non-object")) assert(row.includes("…"), `${name}/${shape}: a missing primary arg shows … : ${row}`);
			}
		}
	}
	const row1 = (name, args) => groups.renderChatChildren([tool(name, args)], 120).map(strip)[0].slice(3);
	assert(row1("read", FULL.read).startsWith("R src/a.ts:10-14") && row1("read", { path: "a", offset: 3 }).startsWith("R a:3+"), "read shows :offset-end / :offset+");
	assert(row1("bash", FULL.bash).startsWith("$ git log -5") && row1("grep", FULL.grep).startsWith('G "TTL" in src glob *.ts') && row1("ls", {}).startsWith("L ."), "bash cd-strip, grep pattern+path+glob, ls default");
	for (const lookalike of ["memory_read", "memory_write", "cycle_bash", "thought_edit", "read_file"]) {
		assert(row1(lookalike, { path: "x" }).startsWith(`· ${lookalike}  path x`), `${lookalike} must stay generic: ${row1(lookalike, { path: "x" })}`);
	}

	// Live capture bug: badge closes with fg+bg resets and every label has an explicit ink fg (terminal default is invisible).
	const rawFinished = groups.renderChatChildren(finished, 100);
	assert(rawFinished[1].includes(`\x1b[48;2;168;163;133m\x1b[38;2;12;12;12mR\x1b[39m\x1b[49m \x1b[38;2;114;112;96msrc/auth/session.ts\x1b[39m`), `read badge + punct path escapes: ${JSON.stringify(rawFinished[1])}`);

	// A tool-only first assistant message is folded into the group; its turn head row must survive above it.
	const meta = await import(pathToFileURL(join(buildDir, "messages", "message-meta.js")).href);
	const opener = assistant();
	opener.lastMessage.timestamp = Date.UTC(2026, 0, 1, 14, 52);
	meta.claimTurnHead(opener);
	const headed = groups.renderChatChildren([opener, tool("read", { path: "a.ts" })], 100).map(strip);
	assert(headed.length === 3 && headed[0].includes("•") && headed[0].includes("@") && headed[1].includes("R a.ts"), `turn head row must sit above the folded group: ${JSON.stringify(headed)}`);
	assert(groups.renderChatChildren([assistant(), tool("read", { path: "a.ts" })], 100).length === 2, "an assistant member that did not open the turn adds no head row");

	// A turn whose thinking shows stays a row of its own above the calls it issued; hidden behind an empty label it folds.
	const thoughtful = groups.renderChatChildren([assistant("check ttl"), tool("read", { path: "a.ts" }), assistant("then grep"), tool("grep", { pattern: "TTL", path: "src" })], 100).map(strip);
	const order = thoughtful.map((row) => (row.includes("ASSISTANT") ? "A" : /┃ R a\.ts/.test(row) ? "R" : /┃ G "TTL"/.test(row) ? "G" : "")).join("");
	assert(order === "ARAG", `thinking turns render in order above their calls: ${order} ${JSON.stringify(thoughtful)}`);
	const silent = { ...assistant("hidden"), hideThinkingBlock: true, hiddenThinkingLabel: "" };
	assert(!groups.renderChatChildren([silent, tool("read", { path: "a.ts" })], 100).map(strip).some((row) => row.includes("ASSISTANT")), "thinking hidden behind an empty label folds into the group");

	// Running → finished: every call stays visible at every stage (the user's "swallowed after finish" report).
	const callRows = (children) => groups.renderChatChildren(children, 100).map(strip).filter((row) => /┃ (?:[├└]─ )?[R$GFLWE·] /.test(row)).length;
	const turn = [assistant(undefined, "I will read a.")];
	const t1 = tool("read", { path: "a.ts" }, { result: undefined, isPartial: true });
	turn.push(t1);
	assert(callRows(turn) === 1, "running: first call visible");
	t1.result = { content: [], details: {} }; t1.isPartial = false;
	turn.push(assistant(undefined, "Now bash."), tool("bash", { command: "ls" }, { result: undefined, isPartial: true }), tool("bash", { command: "pwd" }, { result: undefined, isPartial: true }));
	assert(callRows(turn) === 3, "mid-turn: all three calls visible");
	for (const member of turn) if (member.toolName) { member.result = { content: [], details: {} }; member.isPartial = false; }
	turn.push({ lastMessage: { role: "assistant", content: [{ type: "text", text: "All done." }], stopReason: "stop" }, render: (w) => ["FINAL".padEnd(w)] });
	assert(callRows(turn) === 3, `after the turn finishes all three calls are still visible: ${callRows(turn)}`);
	assert(groups.renderChatChildren(turn, 100).map(strip).filter((row) => row.includes("Done(")).length === 1 && groups.renderChatChildren(turn, 100).map(strip).some((row) => row.includes("ASSISTANT")), "text-bearing assistants render between groups");

	// --- 6. Expanded groups: outputs under their guide, capped; head no longer advertises ^o ---
	const readOutput = Array.from({ length: 120 }, (_, i) => `${i + 1}| line ${i + 1}`).join("\n");
	const expandedChildren = [
		tool("bash", { command: "pnpm test auth" }, { expanded: true, result: { content: [{ type: "text", text: "ok\nall good" }] } }),
		tool("read", { path: "refresh.test.ts" }, { expanded: true, result: { content: [{ type: "text", text: readOutput }], details: {} } }),
	];
	const expandedTree = groups.renderChatChildren(expandedChildren, 100).map(strip);
	const readBody = expandedTree.filter((row) => /line \d+/.test(row));
	assert(readBody.length === 50 && expandedTree.some((row) => row.includes("… 70 more lines")), `expanded read body must honor maxExpandedLines (50): got ${readBody.length}`);
	assert(!expandedTree[0].includes("^o") && expandedTree.some((row) => row.includes("all good")), "expanded head must not advertise ^o and bash output shows under its row");

	// Expanded output bodies are dim (never the answer ink); errors keep the del color.
	const fgOfText = (row, needle) => {
		const at = strip(row).indexOf(needle);
		let fg = "none", visible = 0, i = 0;
		while (i < row.length) {
			const m = row.slice(i).match(/^\x1b\[([0-9;]*)m/);
			if (m) {
				if (m[1].startsWith("38;2;")) fg = m[1].slice(5);
				else if (m[1] === "39") fg = "none";
				i += m[0].length;
				continue;
			}
			if (visible === at) return fg;
			visible++; i++;
		}
		return "missing";
	};
	const DIM_FG = "168;163;133", DEL_FG = "221;86;112";
	const bodies = groups.renderChatChildren([
		tool("bash", { command: "ls" }, { expanded: true, result: { content: [{ type: "text", text: "plain stdout line" }] } }),
		tool("read", { path: "a.ts" }, { expanded: true, result: { content: [{ type: "text", text: "1| const answer = 42;" }], details: {} } }),
		tool("memory_read", { id: "x" }, { expanded: true, result: { content: [{ type: "text", text: "generic tool result" }] } }),
		tool("bash", { command: "boom" }, { expanded: true, result: { content: [{ type: "text", text: "stderr: it broke" }], isError: true } }),
	], 100);
	for (const needle of ["plain stdout line", "const answer = 42;", "generic tool result"]) {
		const row = bodies.find((line) => strip(line).includes(needle));
		assert(row && fgOfText(row, needle) === DIM_FG && fgOfText(row, needle.slice(-3)) === DIM_FG, `expanded body "${needle}" must be dim: ${JSON.stringify(row)}`);
	}
	assert(fgOfText(bodies.find((line) => strip(line).includes("stderr: it broke")), "stderr: it broke") === DEL_FG, "error output keeps the del color");

	// Hierarchy of a call row: badge > args (punct #727060) > generic keys / separators (faint); generic names match their values.
	const FAINT_FG = "82;91;84", PUNCT_FG = "114;112;96";
	const callRowsRaw = groups.renderChatChildren([
		tool("read", { path: "src/auth.ts" }), tool("bash", { command: "git status" }), tool("grep", { pattern: "TTL", path: "src" }),
		tool("piggery_send", { to: "tools" }),
	], 120);
	const rowWith = (needle) => callRowsRaw.find((line) => strip(line).includes(needle));
	assert(fgOfText(rowWith("src/auth.ts"), "src/auth.ts") === PUNCT_FG && fgOfText(rowWith("git status"), "git status") === PUNCT_FG, "common-tool args are punct");
	assert(fgOfText(rowWith('"TTL"'), "TTL") === PUNCT_FG && fgOfText(rowWith('"TTL"'), "src") === PUNCT_FG && fgOfText(rowWith('"TTL"'), '"TTL') === FAINT_FG, "grep pattern and path are punct, quotes faint");
	assert(fgOfText(rowWith("piggery_send"), "to tools") === FAINT_FG && fgOfText(rowWith("piggery_send"), "tools") === PUNCT_FG && fgOfText(rowWith("piggery_send"), "piggery_send") === PUNCT_FG, "generic: key faint, value and name punct");

	// Rail color: ┃ accent while running, kw when finished, del marker when a call failed; the closing blank row stays ┊.
	const palette = await import(pathToFileURL(join(buildDir, "theme", "geek-palette.js")).href);
	palette.setGeekAccent("#d8d4b4"); // distinct from the del marker so accent vs error is observable
	const railOf = (row) => row.match(/\x1b\[38;2;(\d+;\d+;\d+)m(┃|┊)/)?.slice(1).join(" ");
	const KW = "104;158;128 ┃", ACCENT = "216;212;180 ┃", DEL = "221;86;112 ┃", PLAIN = "58;58;52 ┊";
	const okRows = groups.renderChatChildren([tool("read", { path: "a.ts" })], 100);
	assert(railOf(okRows[0]) === KW && railOf(okRows.at(-1)) === PLAIN, `finished ok group: kw ┃ head, plain ┊ blank: ${railOf(okRows[0])} / ${railOf(okRows.at(-1))}`);
	const errRows = groups.renderChatChildren([tool("read", { path: "a.ts" }), tool("bash", { command: "ls" }, { expanded: true, result: { content: [{ type: "text", text: "boom" }], isError: true } })], 100);
	assert(errRows.slice(0, -1).every((row) => railOf(row) === DEL) && railOf(errRows.at(-1)) === PLAIN, "a failed call turns every group row (head + tree) to the del-marker ┃");
	const liveRows = groups.renderChatChildren([tool("bash", { command: "ls" }, { result: undefined, isPartial: true })], 100);
	assert(railOf(liveRows[0]) === ACCENT, `running group keeps the accent ┃: ${railOf(liveRows[0])}`);
	palette.setGeekAccent("#dd5670");
	const treeChildren = [tool("read", { path: "a.ts" }), tool("bash", { command: "pnpm test" }, { result: undefined, isPartial: true, rendererState: { __geekStartedAt: performance.now() - 4100 } })];

	// --- 7. Standalone block as the chat renders it: gutter + rail, diff rows indented under the call ---
	const spacing = await import(buildToolTags("compact-tool-spacing.js"));
	const edited = editBlockRaw({ path: "src/auth/session.ts" }, { content: [{ type: "text", text: "x" }], details: { diff: ["  19 const now = Date.now();", "-20 const exp = now + REFRESH_TTL;", "+20 const exp = now + REFRESH_TTL * 1000;", "  21 return exp;", "    ...", " 37 if (a)", "-38 old", "+38 new"].join("\n") } });
	class FakeToolExecution {
		constructor() { Object.assign(this, { toolName: "edit", result: {}, isPartial: false }); }
		render(width) { return ["", ...edited.call.render(width), ...edited.body.render(width)]; }
	}
	spacing.installCompactToolSpacing(FakeToolExecution);
	const block = new FakeToolExecution().render(WIDTH).map(strip);
	assert(block.every((row) => visibleWidth(row) === WIDTH), "standalone rows must be exactly the chat width");
	assert(block[0].startsWith(" ┃ E src/auth/session.ts") && block[0].includes("// +2 -2 · 0.1s"), `edit call row: ${block[0]}`);
	assert(block[1].startsWith(" ┃   ") && block[1].includes("20 - const exp"), `diff rows sit under the call, indented 2: ${block[1]}`);
	assert(block.at(-1).trim() === "┊", "block must end with one blank rail row");
	assert(new FakeToolExecution().render(WIDTH).slice(0, -1).every((row) => /\x1b\[38;2;104;158;128m┃/.test(row)) && /\x1b\[38;2;58;58;52m┊/.test(new FakeToolExecution().render(WIDTH).at(-1)), "finished standalone edit block: every row kw ┃, closing blank plain ┊");

	// --- 8. Terminal image lines survive the render patch; reload re-installs without stacking ---
	const kitty = "\x1b_Gf=100,t=d,a=T;QUFBQQ==\x1b\\";
	const iterm = "\x1b]1337;File=inline=1:QUFBQQ==\x07";
	class FakeImageTool {
		constructor() { Object.assign(this, { toolName: "read", result: {}, isPartial: false }); }
		render() { return ["", "› read photo.png", "", kitty, "", iterm]; }
	}
	spacing.installCompactToolSpacing(FakeImageTool);
	const imageLines = new FakeImageTool().render(80);
	assert(imageLines.includes(kitty) && imageLines.includes(iterm) && imageLines.indexOf(kitty) < imageLines.indexOf(iterm), "kitty/iTerm2 image lines must pass through untouched and in order");
	assert(imageLines[imageLines.indexOf(kitty) - 1] === "", "one spacer row must stay before the image block");
	assert(strip(imageLines[0]).startsWith(" ┃ › read photo.png"), `text rows around images still get the rail: ${strip(imageLines[0])}`);
	const wrapped = FakeImageTool.prototype.render;
	spacing.installCompactToolSpacing(FakeImageTool);
	const reloaded = await import(`${buildToolTags("compact-tool-spacing.js")}?reload=1`);
	reloaded.installCompactToolSpacing(FakeImageTool);
	assert(FakeImageTool.prototype.render === wrapped, "re-install (same or reloaded module copy) must not stack a second render wrapper");
	assert(new FakeImageTool().render(80).filter((row) => strip(row).includes("› read photo.png")).length === 1, "re-install must not prefix rows twice");

	// Uncolored code (identifiers/operators) must fall back to ink, not the terminal default fg.
	const INK = "\x1b[38;2;216;212;180m";
	const rawDiffRow = edited.body.render(WIDTH).find((row) => strip(row).includes("const exp = now + REFRESH_TTL;"));
	assert(rawDiffRow?.includes(`const\x1b[39m${INK} exp`), `highlighted diff code must re-establish ink after fg resets: ${JSON.stringify(rawDiffRow)}`);

	for (const out of [groups.renderChatChildren(finished, 100), groups.renderChatChildren(treeChildren, 100), groups.renderChatChildren(expandedChildren, 100).slice(0, 8), new FakeToolExecution().render(WIDTH)]) console.log(out.join("\n"));
	console.log("builtin tool renderers smoke ok (7-name resolution, timing precedence, edit-only registration, edit diff rows + meta, group summary)");
}

prepareWorkDir();
try {
	compileBuiltinToolRenderers();
	await runBuiltinToolRenderersSmoke();
} finally {
	// Keep the work dir for post-mortem on failure; clean up on the happy path only.
	if (process.exitCode === undefined || process.exitCode === 0) {
		rmSync(workDir, { recursive: true, force: true });
	}
}
