# pi-geek-tui — UI spec (from mockup V2)

Source of truth: `design/mockup-v2.zip` (`V2.dc.html`, inline styles + `<style>` block).
Mockup text is Vietnamese; **all shipped UI text is English**
(translations listed below). Engine (render perf, physical sync, virtualization, patch install/uninstall)
is forked from pi-droid-styling and must keep working — change visuals, not the engine.

## Palette (fixed; no pi-themes dependency)

| role | hex | used for |
|---|---|---|
| bg | `#0c0c0c` | page background (OSC 11 when enabled) |
| ink | `#d8d4b4` | normal text, user name, user rail dot, cursor block |
| dim | `#a8a385` | secondary text (`// meta`, labels) |
| faint | `#525b54` | head-row context (`@host`, `~/path`, `(branch)`), separators ` · `, backticks, `^o`, line numbers, tree glyphs, statusline provider |
| num | `#d8785b` | numbers, `$` (bash) badge bg |
| kw | `#689e80` | keywords, agent name in the head row, agent rail dot, finished tool rail `┃`, edit/write badge bg |
| str/mono | `#88c6a3` | inline code text, `+N`, `+` diff marker |
| punct | `#727060` | code punctuation |
| rail | `#3a3a34` | idle rail `┊` |
| rule | `#2a2a26` | footer horizontal rule `─` |
| panel | `#141414` (selected row `#201f1b`) | slash menu / editor-slot panel surface, user prompt body |
| accent | `#dd5670` default; config options `#dd5670` `#d8785b` `#88c6a3` `#d8d4b4` (or any hex) | `π`, `## heading`, list `-`, active rail `┃`, running state, statusline thinking badge, `T` badge |
| del | marker `#dd5670`, row bg `#251518` | diff removed |
| add | marker `#88c6a3`, row bg `#1b221e` | diff added |
| badge default | bg `#a8a385`, fg `#0c0c0c` | 1-cell tool badge (`R`, `T`…) |

## Layout grammar (columns, monospace cells)

Every conversation row = `rail(3, centered glyph) + body`: the body starts at col 3. There is no time gutter.
Whole UI has a left/right margin (mockup: 4ch inside the window padding) — reuse tui-padding.

Rail glyphs: `•` head of a block (ink for user, kw for agent), `┊` dashed continuation (rail color),
`┃` on every row of a tool block (summary head, tree, edit/write rows): accent while it runs, kw once finished,
del marker (`#dd5670`) if any call failed. ` ` (blank) on the input row.
Blank separator rows — including the one closing a tool block — keep the rail `┊` so the rail is continuous through a turn.

### 1. Startup header (replaces pixel logo)
One title-bar line on the rule (rail color `─`), text segments with one space each side, 2 rule cells before the first and after the last:
```
── π pi ─────────────────── ~/code/kpi-api ─── refresh-ttl · turn 2 ──
```
Left `π` accent + ` pi` ink; middle cwd (home → `~`) dim, kept next to the right segment (3 rule cells between);
right session name ink + dim ` · ` + dim `turn N`. No session name: just `turn N`; no turns yet: just the name.
Narrow widths drop, in order: cwd (left-truncated with `…` first), `turn N`, session name; `π pi` always stays. Never wraps.

### 2. Message head row
` • bean@kpi-api ~/code/kpi-api (fix/refresh-ttl)` — the name is bold (ink for the user, kw for the agent); `@host`, path and `(branch)` are faint, not bold.
Agent: `pi@agent …` with kw dot. No time on message rows.

### 3. User prompt body
` ┊ › refresh token expires after 5 minutes, fix it` (`› ` then text, ink).
Every body row (wrapped lines included) sits on the `panel` surface from the body column to the chat edge, text one
cell short of the edge; the rail prefix, head row and the blank row after the message stay on the page bg.
`transparentBackground` drops the surface.

### 4. Tool group (one row per call)
```
 ┃ Done(3 tool calls · 1 thought)                          ^o  // 0.6s
 ┃ ├─ R tool-tags/tool-groups.ts
 ┃ ├─ $ git log --oneline -5 && …
 ┃ ├─ G "REFRESH_TTL" in src
 ┃ └─ · piggery_send  to tools · kind relay · body QUEUED after P0 #1358 — …
```
A run of consecutive non-edit calls (and the tool-only assistant turns that issued them) is one block; edit/write
break the run. Head: `Done(` / `Running(` bold (Running in accent), dim counts `N tool call(s) · N thought(s)`,
`N failed` in del, while running ` · <name of the live tool>`, dim `)`. Right: faint `^o  ` (hidden once expanded)
+ dim `// ` + num seconds + dim `s` (summed). A lone call is just its row (no head, no guide) with the same
right meta (`running` accent while it runs). Rows are clipped with `…`, never wrapped.

Call row = 1-cell badge + space + params. Built-ins (Pi 1.1.0 `allToolNames`, exact names) have a dedicated badge
that stands for the name and show only their primary arg in ink: `R` read path (`:10-14` / `:10+` with
offset/limit), `$` bash/powershell command (leading `cd <dir> &&` dropped; num bg), `E` edit path (kw bg),
`W` write path (kw bg), `G` grep `"pattern"` + dim ` in path` / ` glob g`, `F` find pattern + path, `L` ls path
(default `.`); `T` thinking is accent bg. Every other tool: `·` badge, raw name in `punct` padded to a shared column
(longest generic name + 2, clamped 4..16), then `key value` pairs (faint key, ink value) joined by dim ` · `.
No suffix heuristics: `memory_read` is generic. Values are single-line, cut at ~120, arrays `N items` /
`N operations (type)`, objects `{N keys}`. A missing primary arg (still streaming) shows dim `…`.
A failed call's badge turns del-marker bg (generic names too). Ctrl+O adds each call's output (dim, capped by
`maxExpandedLines`) under its guide, plus thought rows (`T`). `┃` per the rail rules above.

### 5. Assistant markdown
`## cause` accent; inline code = faint backtick + mono text + faint backtick; numbers num;
list bullet `- ` accent. Code blocks: 2-col indent, faint `// lang` label row, code one step below prose (`dim`
base, syntax tokens keep their palette colors).
Streamed answers reveal progressively (`revealAnimation`, default on): the rendered rows are cut at a cursor that
advances ~90 chars/s (faster to drain a burst within ~0.35s), the newest 6 characters fade in from `faint`; once
the stream ends the rest shows within ~250ms. History, resumed and finished messages render at once;
`revealAnimation: false` or `PI_REDUCED_MOTION=1` turns it off.

### 6. Edit call
` ┃ E src/auth/session.ts                                      // +2 -2 · 0.1s` (`+2` mono, `-2` del marker; `failed` in del on error).
Diff rows indented 2ch, fixed width block (mockup 72ch, clamp to body width) with row bg:
`  20 - const exp = now + REFRESH_TTL;` (line no faint, marker colored, code syntax-colored).
Gap: `       ··· 16 unchanged lines ···` faint. Write: `W path   // +N · s`, file shown as added rows on Ctrl+O.

### 7. (merged into §4)
Running groups use the same rows: `Running(2 tool calls · bash)` head with the accent rail.

### 8. Input zone (no box)
```
 • bean@kpi-api ~/code/kpi-api (fix/refresh-ttl)                      thinking · 2.3s
   › run tests again then commit█
```
The footer rule (§9) follows the last input row directly; nothing is left blank between them.
Head row = same as message head, right side shows live state: the state word
(`thinking` / `working` / `running` / `answering`) + dim ` · ` + num secs + dim `s`. Idle: right side empty.
The word is matrix-scramble text (no spark glyphs, no sweeping band): while live, every 70ms tick ~22-34% of
its positions (re-rolled each tick, never frozen) show a random single-width glyph (`▚▞░▒#%/\<>*+=01xz$&`) in bold
`ink`, the rest are their true letters in `dim`; a glyph that just went back to its letter flashes `ink` for one tick.
Every 2s nothing flips for ~350ms (resolve beat) so the word reads cleanly. When the word changes (working → thinking
→ running) it decodes in ~300ms: unsettled chars are glyphs and settle left→right. Width never changes between frames;
repaint ticks only while live.
After `(branch)` the head row shows the working-tree diff: `+12` mono, `-3` del marker, `~4` dim (files incl.
untracked); zero parts are omitted, clean tree / not a repo → nothing. Width priority: live state (right) and
diff stat stay whole, the cwd path gives way first (keeps its tail, `…` prefix; dropped below 6 cells).
Input row: blank rail, `› ` then editor text; cursor = ink block.
Slash menu (typing `/`): a panel ABOVE the head row (transcript → panel → head → input), body on the `panel`
surface from the body column, every row inset 1 cell: header ` commands` dim + faint `i/N` on the right, up to
Pi's `maxVisible` command rows (window follows the selection; selected row on `panelSel` with an accent `› `,
command ink/accent in a 10..20-cell column, description dim with live hints such as `/model … · now <id>`), then a
faint hint row ` ↑↓ select · tab fill · ↩ run · esc close`. Mouse: click selects/runs the clicked row, wheel moves
the selection anywhere over the panel. Other autocompletes (file paths) keep Pi's rows below the input.
Anything else Pi puts in the editor slot (settings/model/session/tree selectors, extension select/input/editor,
login dialogs) uses the same grammar as the slash menu: 3 blank prefix cells, a panel background body, the
stock border strokes replaced by blank panel rows, `→` selection marker shown as `›`, never wider than the row.
Header = breadcrumb from the component's own title (` settings › Theme`, a submenu pushes a level, long trails
left-truncate with `…`) + faint `i/N`; Pi's hint row is kept, else a default one. While a selector is open the
input row hides; the head row and footer stay under the panel. The panel body is windowed to ~40% of the terminal
height (3..8 body rows) so the footer always stays on screen. A body without a known selection marker (an extension's own
dialog, e.g. ask_user_question's `>` cursor) cannot be windowed around the cursor, so it is not cut to that cap: it
grows to whatever the terminal holds above the head row and footer.

### 9. Footer (rule + one statusline row, directly under the input — no blank row between)
```
──────────────────────────────────────────────────────────────── (rule color, full width)
 HIGH  zai · glm-5.3                          41k/1.0M 4% · CH 82%  ○ 🐴 ponytail: ⚡ FULL
```
nvim-style statusline (`editor/statusline.ts`). The thinking badge starts the line: a reverse-video accent block
` HIGH ` at col 0, one gap cell, then the model (so the model column shifts with the label width). Labels OFF MIN LOW
MED HIGH XHIGH; `!` bash mode shows ` BASH ` in the `num` colour; a model without thinking has no badge and starts on
the chat body column instead.
Left: provider + ` · ` faint, then the model id dim (capped at 40 cells, `…`). Right (dim, right-aligned to the chat edge):
`<tokens>/<window> <ctx%>` + ` · CH <n>%`, two spaces, then extension statuses (joined with ` · `). Before the first
usage the metrics read `—`.
Fixed sacrifice order as width shrinks: provider → CH% → tokens → extension statuses (cut with `…`, hidden under 6
cells) → model id (truncated last). ctx% is never dropped while the badge + model fit. Never wraps, never a second
row; no ctx bar, no ↑↓ R W row, no cost.

## English strings (mockup → shipped)
| mockup | shipped |
|---|---|
| lượt 2 · cuối | turn 2 · last |
| đang chạy | running |
| nghĩ | thinking |
| ··· 16 dòng không đổi ··· | ··· 16 unchanged lines ··· |
| dòng (lines) | lines |
| call / thought | call / thought (plural not inflected, as mockup) |

## Removed from the fork
Presentation presets (droid/reasonix/claudecode), user-zone presets, input-box styles, diff modes, theme extras
and the companion pi-themes bundle, the pixel startup logo, the time gutter, the boxed editor and the two-row
ctx/tok footer. One look only; config keeps engine knobs (alwaysExpanded, maxExpandedLines, visibleChatTail,
collapsedThinking, transparentBackground, forceOSC11, customWorkingMessage, tasksWidgetStyle, revealAnimation)
+ `accent`. Old keys (`presentationStyle`, `userZoneStyle`, `inputBox`, `fixedUserZone*`, `diffMode`,
`dimToolOutput`) are removed from the config file on load.
