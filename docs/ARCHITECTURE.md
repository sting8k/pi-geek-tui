# Architecture

`pi-geek-tui` is a TypeScript ESM extension for Pi. It customizes the Pi terminal UI by installing reload-safe patches, custom renderers, a rail-grammar conversation layout, a box-less input zone, theme helpers, and lightweight runtime status providers.

## Runtime Surface

- Runtime: Pi extension loaded from `index.ts` through the `package.json` `pi.extensions` entry.
- Language: TypeScript with ESM-style `.js` import specifiers.
- Hosts: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`.
- State: in-memory per process/session; no product database.
- Harness durable state: local `harness.db`, managed only by `scripts/bin/harness-cli` and ignored by git.

## Current Module Boundaries

```text
index.ts
  Pi lifecycle wiring and module installation

core/
  Pure-ish runtime helpers that do not own UI rendering
  - assistant speed tracking

editor/
  GeekEditor (input head row, prompt rows, statusline footer, slash-menu panel, mouse translation),
  slot-frame.ts (panel look for every other component Pi puts in the editor slot), live-state/shimmer
  - image-attachments.ts owns the pasted-image store (<session dir>/images/<N>.<ext>; ids seeded from
    disk and never reused, files older than 7 days swept at startup, newest 16 re-sendable). GeekEditor
    turns the host's clipboard insertTextAtCursor(path) and pasted image file paths into literal
    `[Image #N]` tokens; submit stays with the host and Pi's `input` event (index.ts) runs
    image-submit.ts: ImageContent parts for image-capable models, inline file paths otherwise.
    messages/user-prefix.ts links tokens to the stored files (OSC 8)

messages/
  Conversation rows for Pi's user/assistant/core message components, all in the rail grammar
  (see presentation/): head row `• name@host ~/path (branch)`, then body rows on the `┊` rail
  - user-prefix.ts / assistant-prefix.ts replace each component's `render`; the assistant head row
    is printed only by the first assistant message of a turn
  - message-meta.ts patches InteractiveMode.addMessageToChat to delimit turns (counter on globalThis,
    answers stamped on components so reloads stay consistent)
  - markdown-codeblock-renderer.ts patches Markdown.prototype once: geek theme (`## ` headings,
    faint-backtick inline code, accent/num list markers, num numbers) and `// lang` code blocks
  - core-message-blocks.ts + rail-message-block.ts render compaction/skill/branch/custom messages
    as a head row plus rail body (no Box background)
  - assistant-prefix.ts owns the collapsed-thinking row (`<label> <marker> <tail>`) on top of the
    rendered-run model from assistant-content-runs.ts and the width-safe tail helper in render-budget.ts
  - assistant-streaming-state.ts owns the extension-tracked assistant stream token (tagged onto the
    streaming component by message identity) that drives the row's live marker, because pi-ai
    partials always carry stopReason "stop"

presentation/
  Row grammar shared by every scope: geek-rows.ts (rail(3) + body, split rows, number
  grouping) and geek-head.ts (head-row data: login/cwd/branch, and the input head's branch provider, read from `.git/HEAD`). One look; no presets.

tool-tags/
  Tool rows in the rail grammar (docs/design/geek-ui-spec.md §4/§6/§7)
  - tool-groups.ts is a render-time projection over the chat children (called by
    performance/virtualize-chat.ts): a run of non-edit calls plus the tool-only assistant turns that
    issued them is one block: `Done(…)`/`Running(…)` head and one row per call (tool-tree.ts), a lone
    call is just its row. edit/write-class calls break a run and render standalone
  - tool-call-line.ts is the one place a call becomes text: badge + primary arg for the Pi built-ins,
    `·` + dim name + `key value` pairs for everything else (exact names, no heuristics)
  - tool-summary.ts (running/failed state, rail kind, elapsed), tool-row.ts (standalone call row, capped
    output bodies honoring maxExpandedLines); result renderers publish the row's right-hand meta
    through renderer state
  - edit.ts / write.ts feed split-diff.ts (DiffRowsComponent: del/add row backgrounds,
    numbered rows, folded `··· N unchanged lines ···`)
  - compact-tool-spacing.ts wraps ToolExecutionComponent.render once; reloads only swap its runtime
    hook. Bodies render at width minus the 3-cell prefix, then get the rail (`┃` while running);
    terminal image lines pass through untouched. builtin-tool-renderers.ts picks the renderers by tool
    name with shell "self"
  - elapsed.ts timing, default-badge.ts result timing/context patches, resume-tool-refresh.ts

theme/
  Fixed palette (geek-palette.ts) and the host Theme built from it (geek-theme.ts), ANSI helpers, shared frame background row painting, and platform-gated OSC 11 terminal background sync

performance/
  Debounce, virtualization, root frame background, and physical-sync patches for render hot paths
  - debounce-update.ts (the assistant presentation buffer) and finished-render-cache.ts both read the
    assistant stream state from messages/assistant-streaming-state.ts: only the component attached to
    the live stream is buffered, and its render bypasses the finished cache

startup-ui.ts, footer-patch.ts, tui-padding.ts, split-diff.ts
  Focused UI patches/components that are still small enough to stay at root
```

## Design Rules

1. `index.ts` should stay an orchestrator: install modules, wire Pi events, and pass providers into UI components.
2. Feature logic belongs in the closest domain folder, not inline in `index.ts`.
3. Patch installers must be idempotent because sessions and extensions can reload.
   Terminal compositor patches must also restore `terminal.write`, `terminal.rows`, `tui.render`, scroll regions, and input listeners on dispose.
4. Tool rendering belongs in `tool-tags/` until that domain grows enough to justify subfolders.
5. Theme and ANSI behavior belongs in `theme/`; row-level background painting uses the shared theme painter; OSC 11 terminal background sync is platform-gated there; component ownership decides where rows are emitted; performance wrappers belong in `performance/`.
6. Runtime providers used by UI components should be cheap on render paths and cache background work when needed.

## Dependency Direction

```text
index.ts
  -> core, editor, messages, performance, presentation, theme, tool-tags, root UI modules

editor/messages/tool-tags/root UI modules
  -> theme helpers when they need color or ANSI behavior
  -> presentation/geek-rows.ts for the rail row grammar

core
  -> Node/Pi primitives only; avoid depending on UI render components

presentation/
  -> theme/geek-palette.ts and pi-tui width helpers only; avoid depending on Pi UI component classes
```

Avoid adding dependencies from `core/` back into UI components. If a core helper needs host behavior, pass it in as a provider instead of importing UI classes.

## Render Drift / Stale Row Incident

> Context: this took a full debugging day; keep this note close to render architecture.

Observed symptom: during assistant/tool streaming, one conversation row could appear duplicated or stuck. The duplicate disappeared after scrolling up/down because scrolling forced a broader terminal repaint.

Root cause direction: Pi TUI logical render state was clean, but the physical terminal buffer could retain a stale row. The default differential renderer only repaints rows it believes changed, so an unchanged logical row could remain stale on screen.

Confirmed non-causes:

- working/status loader
- scrollbar visual overlay
- fixedUserZone seam row
- fixedUserZone scroll-region

Current mitigation lives in `performance/render-physical-sync.ts`:

```text
after each doRender
  normalize leading relative cursor movement to an absolute row anchor
  self-heal physical rows with a targeted risk band, or full viewport on remap/sweep
```

The post-render repaint is intentionally self-healing: it rewrites physical rows from the current logical `previousLines` snapshot instead of trusting terminal diff/cache state. By default, changed visual rows use a targeted risk band plus the hardware-cursor band, and viewport remaps use a full viewport repaint. Periodic interval fallback and slower full-viewport sweep remain opt-in so assistant streaming stays bounded while still repainting the active streaming row.

Important cursor invariant: leading relative cursor moves are normalized to absolute anchors even when the relative move is followed by `\r\n`. The `\n` is intentionally preserved after the absolute anchor so multi-line append writes keep their line-feed semantics without leaking a final relative cursor dependency.

Debug-only row coverage compares logical rows changed in `previousLines` with physical screen rows touched by the final ANSI writes. A coverage miss is a stale-risk signal for dirty-range bugs, not proof of terminal state, because the terminal buffer cannot be read back. Frame debug also keeps a lightweight ANSI screen simulation that replays final writes into a simulated viewport and compares it to logical `previousLines`; simulator mismatches narrow terminal-protocol drift but still do not prove the real emulator buffer.

Useful debug/env flags:

- `PI_GEEK_RENDER_DEBUG=1` writes JSONL frame logs to `/tmp/pi-geek-render-debug` by default.
- `kill -USR2 <pi-pid>` writes a debug marker record near the current frame so visual stale observations can be correlated with logs.
- `PI_GEEK_RENDER_PHYSICAL_SYNC=0` disables the whole physical-sync wrapper for A/B testing.
- `PI_GEEK_RENDER_ABSOLUTE_ANCHOR=0` disables only the absolute-anchor rewrite for A/B testing.
- `PI_GEEK_RENDER_AUTOWRAP_GUARD=1` enables the render-wide autowrap guard for right-edge/pending-wrap A/B testing, especially long tool-output rows; default remains off because physical-sync repaint already wraps its own writes locally.
- `PI_GEEK_RENDER_SHAPE_REPAINT=0` disables the default visual line-change/cursor-band and viewport-remap repaint for A/B testing.
- `PI_GEEK_RENDER_FULL_REPAINT=1` enables extra same-shape interval repaint and periodic full sweep; default is off.
- `PI_GEEK_RENDER_SELF_HEAL_MODE=band` uses targeted risk-band repaint; `viewport` restores full-viewport self-heal.
- `PI_GEEK_RENDER_FULL_REPAINT_INTERVAL_MS=200` controls same-shape streaming band fallback cadence; `0` restores every-frame self-heal for A/B testing.
- `PI_GEEK_RENDER_FULL_SWEEP_INTERVAL_MS=1000` controls periodic full-viewport sweep cadence in band mode; `0` disables periodic sweeps.
- `npm run debug:render-log -- --dir /tmp/pi-geek-render-debug` summarizes frame logs, including markers, raw/final cursor anchoring, self-heal reasons/ranges, changed-row write coverage misses, and ANSI screen simulation mismatches.

Tradeoff: the default shape repaint adds bounded output when visible line content changes, including same-line assistant streaming ticks. The cursor-band repaint fixes active-row stale leaks without enabling periodic full sweeps. The opt-in interval/sweep mitigation increases terminal output on self-heal frames; targeted band reduces bytes versus full viewport repaint, but it is heuristic and can miss stale rows outside the risk band. `PI_GEEK_RENDER_SELF_HEAL_MODE=viewport` is the safer fallback if visual leaks return.

## Validation Ladder

- `npm run check`: `tsc --noEmit` typecheck, every smoke script chained in `npm test`, and `npm pack --dry-run`.
- A live Pi run (tmux capture or screenshot) for user-visible rendering changes.
