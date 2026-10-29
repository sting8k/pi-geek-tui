import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  AssistantMessageComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  InteractiveMode,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";

import { getConfigIssue, loadConfig } from "./config.js";
import { recordToolCallTimingEnd, recordToolCallTimingStart } from "./tool-tags/elapsed.js";
import { installStartupUiPatch, setStartupHeader, suppressStartupModelScopeLog } from "./startup-ui.js";
import { installInteractiveChatVirtualization } from "./performance/virtualize-chat.js";
import { setGeekAccent } from "./theme/geek-palette.js";
import { createGeekTheme } from "./theme/geek-theme.js";
import { refreshGitDiffStat } from "./presentation/git-diff-stat.js";
import { setLiveState, workingStateForAssistantMessage } from "./editor/live-state.js";
import { beginAssistantStream, endAssistantStream, trackAssistantStreamMessage } from "./messages/assistant-streaming-state.js";

type SessionModules = typeof import("./session-modules.js");
type AssistantSpeedTracker = ReturnType<SessionModules["createAssistantSpeedTracker"]>;
type SetAssistantUpdateRenderRequester = SessionModules["setAssistantUpdateRenderRequester"];
type AttachEditorImages = SessionModules["attachEditorImages"];
type RenderFrameDebugModule = typeof import("./performance/render-frame-debug.js");

let restoreTerminalBackgroundForCurrentSession: (() => void) | undefined;
let disposePiTasksWidgetStylingForCurrentSession: (() => void) | undefined;
const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
let setAssistantUpdateRenderRequesterForCurrentSession: SetAssistantUpdateRenderRequester | undefined;
let sessionModulesPromise: Promise<SessionModules> | undefined;

let renderFrameDebugModulePromise: Promise<RenderFrameDebugModule> | undefined;
function loadSessionModules(): Promise<SessionModules> {
	sessionModulesPromise ??= import("./session-modules.js");
	return sessionModulesPromise;
}

function loadRenderFrameDebugModule(): Promise<RenderFrameDebugModule> {
	renderFrameDebugModulePromise ??= import("./performance/render-frame-debug.js");
	return renderFrameDebugModulePromise;
}

function isProfileEnabled(env = process.env): boolean {
	return TRUE_ENV_VALUES.has(String(env.PI_GEEK_PROFILE ?? "").trim().toLowerCase());
}

let profilerModulePromise: Promise<typeof import("./performance/profiler.js")> | undefined;

function loadProfilerModule(): Promise<typeof import("./performance/profiler.js")> {
	profilerModulePromise ??= import("./performance/profiler.js");
	return profilerModulePromise;
}

function profileCount(name: string, value?: number): void {
	if (!isProfileEnabled()) return;
	void loadProfilerModule().then((profiler) => profiler.profileCount(name, value));
}

function flushProfile(reason: string): void {
	if (!isProfileEnabled()) return;
	void loadProfilerModule().then((profiler) => profiler.flushProfile(reason));
}

export default function (pi: ExtensionAPI) {
	// An unparsable config at startup makes this extension inert: Pi starts with its stock UI and one status line says why.
	// Never throw here: a throwing extension factory aborts Pi's startup.
	loadConfig();
	const startupConfigIssue = getConfigIssue();
	if (startupConfigIssue) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.setStatus?.("pi-geek-tui", `${startupConfigIssue}; styling is off until you fix the file and restart Pi.`);
		});
		return;
	}
	setGeekAccent(loadConfig().accent);
	suppressStartupModelScopeLog();
	installStartupUiPatch(InteractiveMode);
	// Default matches config.ts; session_start refreshes from disk before messages render.
	let currentVisibleChatTail = 30;
	installInteractiveChatVirtualization(InteractiveMode, () => currentVisibleChatTail);
	let sessionRunSerial = 0;

	let currentThinkingLevel: string | undefined;
	let assistantSpeedTracker: AssistantSpeedTracker | undefined;
	const runningToolCalls = new Set<string>();

	// Working-tree diff stats for the input head row: refreshed from events only, never from render.
	const DIFF_STAT_TOOLS = new Set(["edit", "write", "bash"]);
	let diffStatCwd: string | undefined;
	let requestRenderForDiffStat: (() => void) | undefined;
	const refreshDiffStat = () => {
		if (diffStatCwd) refreshGitDiffStat(diffStatCwd, () => requestRenderForDiffStat?.());
	};

	/** Resolves `[Image #N]` tokens of the current session's editor; set with the editor. */
	let attachPastedImages:
		| ((text: string, images: Parameters<AttachEditorImages>[1], modelInput: readonly string[] | undefined) => ReturnType<AttachEditorImages>)
		| undefined;

	const isStaleContextError = (error: unknown): boolean =>
		error instanceof Error && error.message.includes("stale after session replacement or reload");

	// Surface a config that broke mid-session through Pi's status channel (never from a render path).
	const reportConfigIssue = (ui: { setStatus?: (key: string, text: string | undefined) => void }) => {
		loadConfig();
		const issue = getConfigIssue();
		ui.setStatus?.("pi-geek-tui", issue && `${issue}; using the last valid settings.`);
	};

	pi.on("before_agent_start", (_event, ctx) => {
		reportConfigIssue(ctx.ui);
		setLiveState("working");
	});

	pi.on("agent_start", () => {
		runningToolCalls.clear();
		setLiveState("working");
	});

	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") beginAssistantStream(event.message);
		assistantSpeedTracker?.handleMessageStart(event.message);
		if (event.message.role === "assistant" && runningToolCalls.size === 0) {
			setLiveState(workingStateForAssistantMessage(event.message));
		}
	});

	pi.on("message_update", (event) => {
		if (event.message.role === "assistant") trackAssistantStreamMessage(event.message);
		assistantSpeedTracker?.handleMessageUpdate(event.message);
		if (event.message.role === "assistant" && runningToolCalls.size === 0) {
			setLiveState(workingStateForAssistantMessage(event.message));
		}
	});

	pi.on("thinking_level_select", (event) => {
		currentThinkingLevel = event.level;
	});

	pi.on("message_end", (event) => {
		endAssistantStream();
		assistantSpeedTracker?.handleMessageEnd(event.message);
	});

	pi.on("tool_execution_start", (event) => {
		runningToolCalls.add(event.toolCallId);
		recordToolCallTimingStart(event.toolCallId);
		setLiveState("running");
	});

	pi.on("tool_execution_end", (event) => {
		runningToolCalls.delete(event.toolCallId);
		recordToolCallTimingEnd(event.toolCallId);
		if (DIFF_STAT_TOOLS.has(event.toolName)) refreshDiffStat();
		// Keep the current label until the next live state begins.
		// For example, a completed tool stays "Cooking" until assistant streaming resumes.
	});

	// Pasted images ride the host submit: Pi keeps input history, steer/follow-up queueing while
	// streaming and the compaction queue; this only attaches the images behind `[Image #N]` tokens.
	pi.on("input", (event, ctx) => {
		refreshDiffStat();
		if (event.source !== "interactive" || !attachPastedImages) return { action: "continue" };
		let modelInput: readonly string[] | undefined;
		try {
			modelInput = ctx.model?.input;
		} catch (error) {
			if (!isStaleContextError(error)) throw error;
		}
		return attachPastedImages(event.text, event.images, modelInput);
	});

	pi.on("agent_end", () => {
		refreshDiffStat();
		endAssistantStream();
		runningToolCalls.clear();
		setLiveState(undefined);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		endAssistantStream();
		sessionRunSerial++;
		diffStatCwd = undefined;
		requestRenderForDiffStat = undefined;
		attachPastedImages = undefined;
		profileCount("session.shutdown");
		flushProfile("session_shutdown");
		restoreTerminalBackgroundForCurrentSession?.();
		restoreTerminalBackgroundForCurrentSession = undefined;
		setAssistantUpdateRenderRequesterForCurrentSession?.(undefined);
		setLiveState(undefined);
		disposePiTasksWidgetStylingForCurrentSession?.();
		disposePiTasksWidgetStylingForCurrentSession = undefined;
		runningToolCalls.clear();
		try {
			ctx.ui.setEditorComponent(undefined);
		} catch {
			// Best effort: shutdown happens during session replacement.
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		const sessionRun = ++sessionRunSerial;
		const isCurrentSessionRun = () => sessionRun === sessionRunSerial;
		profileCount("session.start");
		const modules = await loadSessionModules();
		if (!isCurrentSessionRun()) return;
		assistantSpeedTracker ??= modules.createAssistantSpeedTracker();
		const tracker = assistantSpeedTracker;
		setAssistantUpdateRenderRequesterForCurrentSession = modules.setAssistantUpdateRenderRequester;
		modules.installCompactToolSpacing();
		modules.installDefaultBadge();
		modules.installBuiltinToolRenderers(ToolExecutionComponent);
		modules.installResumeToolRefresh(InteractiveMode);
		modules.installMarkdownCodeBlockRenderer();
		modules.installFooterStatsPatch();
		modules.installCoreMessageBlockStyling({
			CompactionSummaryMessageComponent,
			SkillInvocationMessageComponent,
			BranchSummaryMessageComponent,
			CustomMessageComponent,
		});
		const sessionUi = ctx.ui;
		const sessionCwd = ctx.cwd;
		// Pasted images live next to the sessions they belong to (honors PI_CODING_AGENT_DIR and a custom sessionDir).
		// In-memory sessions (--no-session) have no directory: use the cwd's default session dir, named as Pi names it.
		const sessionDir = ctx.sessionManager.getSessionDir()
			|| join(getAgentDir(), "sessions", `--${sessionCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
		const imageStoreDir = join(sessionDir, "images");
		diffStatCwd = sessionCwd;
		refreshDiffStat();
		modules.setAssistantUpdateRenderRequester(undefined);
		setStartupHeader(sessionUi, {
			cwd: sessionCwd,
			getSessionName: () => {
				try {
					return pi.getSessionName();
				} catch (error) {
					if (isStaleContextError(error)) return undefined;
					throw error;
				}
			},
			getTurnCount: () => {
				try {
					return ctx.sessionManager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user").length;
				} catch (error) {
					if (isStaleContextError(error)) return 0;
					throw error;
				}
			},
		});
		tracker.resetSession();
		setLiveState(undefined);
		runningToolCalls.clear();
		try {
			currentThinkingLevel = pi.getThinkingLevel();
		} catch (error) {
			if (!isStaleContextError(error)) throw error;
			currentThinkingLevel = undefined;
		}
		const config = modules.loadConfig();
		reportConfigIssue(sessionUi);
		setGeekAccent(config.accent);
		// Session-only (a Theme instance is never written to the user's settings).
		sessionUi.setTheme(createGeekTheme(sessionUi.theme.getColorMode?.() === "256color" ? "256color" : "truecolor"));
		currentVisibleChatTail = config.visibleChatTail;
		const renderFrameDebugModule = process.env.PI_GEEK_RENDER_DEBUG === "1"
			? await loadRenderFrameDebugModule()
			: undefined;
		if (!isCurrentSessionRun()) return;
		disposePiTasksWidgetStylingForCurrentSession?.();
		disposePiTasksWidgetStylingForCurrentSession = modules.installPiTasksWidgetStyling(sessionUi, config.tasksWidgetStyle);
		restoreTerminalBackgroundForCurrentSession?.();
		restoreTerminalBackgroundForCurrentSession = undefined;
		// The input head row shows the live state; hide Pi's own working line.
		sessionUi.setWorkingVisible?.(false);

		// Treat `alwaysExpanded` as the session-start preference only.
		// Ctrl+o remains authoritative after the session is initialized.
		const initialToolsExpanded = Boolean(config.alwaysExpanded);
		if (sessionUi.getToolsExpanded() !== initialToolsExpanded) {
			sessionUi.setToolsExpanded(initialToolsExpanded);
		}

		modules.installAssistantStreamingMarkdownCache(AssistantMessageComponent);
		modules.installMessageMeta(InteractiveMode);
		modules.installEditorSlotFrame(InteractiveMode);
		modules.installAssistantMessagePrefix(sessionUi.theme);
		modules.installUserMessagePrefix(sessionUi.theme);
		modules.installAssistantUpdateDebounce(AssistantMessageComponent);
		modules.installToolExecutionUpdateDebounce(ToolExecutionComponent);
		modules.installFinishedRenderCache(AssistantMessageComponent, ToolExecutionComponent);

		modules.setCoreMessageBlockTheme(sessionUi.theme);

		sessionUi.setEditorComponent((tui, theme, kb) => {
			const uiTheme = (sessionUi.theme ?? theme) as any;
			restoreTerminalBackgroundForCurrentSession?.();
			restoreTerminalBackgroundForCurrentSession = undefined;
			if (config.transparentBackground) {
				// Transparent mode: never claim OSC 11; reset any residue left by a previous session.
				modules.clearTerminalPageBackgroundOsc111((tui as any).terminal as any);
			} else {
				restoreTerminalBackgroundForCurrentSession = modules.applyTerminalPageBackgroundOsc11(uiTheme, (tui as any).terminal as any, { force: config.forceOSC11 });
			}
			modules.setAssistantUpdateRenderRequester(() => tui.requestRender());
			requestRenderForDiffStat = () => tui.requestRender();
			modules.virtualizeChatContainer(tui as any, config.visibleChatTail);
			modules.installTuiPadding(tui as any);
			modules.installRenderAutowrapGuard(tui as any);
			const fetchBranch = modules.createGitBranchFetcher(sessionCwd);
			modules.installRenderWidthGuard(tui as any);
			modules.installRenderFrameBackground(tui as any, uiTheme);
			modules.installRenderPhysicalSync(tui as any);
			renderFrameDebugModule?.installRenderFrameDebug(tui as any);
			const editor = new modules.GeekEditor(tui, theme, kb, {
				cwd: sessionCwd,
				imageStoreDir,
				getContextUsage: () => {
					try {
						return ctx.getContextUsage();
					} catch (error) {
						if (isStaleContextError(error)) return undefined;
						throw error;
					}
				},
				getModelInfo: () => {
					try {
						const model = ctx.model;
						return model
							? { provider: model.provider, id: model.id, reasoning: model.reasoning, thinkingLevel: currentThinkingLevel }
							: undefined;
					} catch (error) {
						if (isStaleContextError(error)) return undefined;
						throw error;
					}
				},
				getBranch: fetchBranch,
				getFooterStatus: modules.getFooterStatusLine,
				getTokenUsage: modules.getFooterTokenUsage,
			});
			attachPastedImages = (text, images, modelInput) =>
				modules.attachEditorImages(text, images, editor.getImageAttachments(), modelInput);
			return editor;
		});
	});
}
