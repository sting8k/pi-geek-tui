# pi-geek-tui

Geek terminal UI for Pi: a continuous rail down the chat, one-row tool calls in collapsible groups, a box-less input zone with a live state, a one-row statusline footer, and reload-safe render patches. One fixed look; design spec in [`docs/design/geek-ui-spec.md`](docs/design/geek-ui-spec.md).

![pi-geek-tui: a finished turn with a tool group and an edit diff, the next prompt running](screenshots/geek.svg)

## Install

Requires Pi 1.x (`@earendil-works/pi-coding-agent` and `pi-tui` `>=1.0.0 <2.0.0`); Pi 0.x is not supported.

```sh
pi install npm:@sting8k/pi-geek-tui
```

Or install directly from Git:

```sh
pi install git:github.com/sting8k/pi-geek-tui
```

## Look

The palette is fixed (page background `#0c0c0c`) and does not depend on the selected Pi theme. Only the accent is configurable: `π`, headings, the running rail, progress fills and the live state use it. Pick one of `#dd5670` (default), `#d8785b`, `#88c6a3`, `#d8d4b4`, or any `#rrggbb` / `#rgb` hex via `accent`.

## Features

### Look and feel

- **Startup header.** One title line, `── π pi ── ~/path ── session · turn 2 ──`, instead of a logo and resource list.
- **Chat rail.** Every row sits behind a 3-cell rail: `•` starts a message (`user@host path (branch)`), a dashed `┊` continues it, `┃` marks tool rows. No timestamps.
- **One row per tool call.** A 1-cell badge plus the call's main argument (`R path`, `$ command`, `E path   // +2 -2 · 0.1s`, `G "pattern" in src`); other tools show their name and `key value` arguments. Consecutive calls fold under `Running(…)` / `Done(3 tool calls · 1 thought)`; `Ctrl+O` shows each call's output.
- **Input zone without a box.** A head row (`user@host`, path, git branch and working-tree diff `+12 -3 ~4`) with the live agent state on the right (`thinking · 2.3s`), then a `› ` prompt row with an ink block cursor.
- **Paste screenshots as attachments.** A pasted image (clipboard image, or a copied image file) drops an accent `[Image #1]` token at the cursor instead of a raw `/tmp` path. The token is plain text: one Backspace deletes it, history and arrows work as before, and you can move or copy it anywhere in the prompt. In the chat it is a Cmd+Click link to a saved copy, so it survives restarts. On submit the image is sent as real image content when the model accepts images, otherwise the token becomes the file path.
- **Slash menu and selectors in one style.** Typing `/` opens a command panel above the input head (keyboard or mouse); settings, model, session and extension dialogs use the same panel.
- **One-row statusline under a rule.** Thinking-level badge, provider · model, then context `41k/1.0M 4%`, cache-hit `CH 82%` and extension statuses on the right. As the terminal narrows, provider, `CH` and tokens drop first; the context % always stays.

### Built for the terminal

- **Smoother while the model works.** Streaming text and fast tool updates are batched into steady frames instead of repainting on every token.
- **Stays aligned when you resize.** Boxes, labels, and right-aligned status account for terminal escape codes, so they wrap and truncate cleanly.
- **Long sessions stay fast.** Only the newest part of the chat is rendered, while huge tool results are capped so history does not slow you down.
- **Reloads stay clean.** UI patches are applied once and removed cleanly, so extension reloads and session switches do not stack layout changes.

## Config

Config is stored at `~/.pi/agent/pi-geek-tui.json`:

```json
{
  "alwaysExpanded": false,
  "maxExpandedLines": 50,
  "accent": "#dd5670",
  "customWorkingMessage": {
    "working": "working",
    "thinking": "thinking",
    "answering": "answering",
    "running": "running"
  },
  "tasksWidgetStyle": "compact",
  "collapsedThinking": "tail",
  "forceOSC11": false,
  "transparentBackground": false,
  "visibleChatTail": 30,
  "revealAnimation": true,
  "imageAttachments": true
}
```

| Setting | Options | Default | What it does |
| --- | --- | --- | --- |
| `alwaysExpanded` | `true`, `false` | `false` | Open tool output by default. `Ctrl+O` still toggles it. |
| `maxExpandedLines` | `0`–`1000` | `50` | Limit expanded tool output. Use `0` for no limit. |
| `accent` | `#dd5670`, `#d8785b`, `#88c6a3`, `#d8d4b4`, or any hex | `#dd5670` | Accent color (see Look). |
| `customWorkingMessage` | Custom text | See example | Rename the live-state words shown in the input head row. You can set only the ones you want to change. |
| `tasksWidgetStyle` | `compact`, `default` | `compact` | Use the one-line tasks widget, or leave the original `pi-tasks` widget unchanged. |
| `collapsedThinking` | `tail`, `label` | `tail` | While thinking is hidden (`Ctrl+T`), each collapsed thinking row shows the end of the thinking text with a `▸` live marker (`·` once the run is done). `label` restores the static label. |
| `forceOSC11` | `true`, `false` | `false` | Force terminal background sync on Windows/WSL. Usually leave this off. |
| `transparentBackground` | `true`, `false` | `false` | Stop painting the page/frame background and tool rows, and reset OSC 11, so the terminal's own background (wallpaper, blur) shows through. Selections and diff accents stay opaque. Dim/blur is tuned on the terminal side (Ghostty `background-image`, kitty `background_image`, WezTerm `window_background_image`). |
| `visibleChatTail` | `0` or more | `30` | Render only the newest N chat items for speed. Use `0` to render everything. |
| `revealAnimation` | `true`, `false` | `true` | Streamed answers appear character by character with the newest characters fading in (truecolor). Finished and resumed messages always show at once. `false` (or `PI_REDUCED_MOTION=1`) shows streamed text in chunks. |
| `imageAttachments` | `true`, `false` | `true` | Paste images as `[Image #N]` tokens. The bytes are copied right away to the project's session directory (`~/.pi/agent/sessions/--<cwd>--/images/<N>.<ext>`; the host's tmp file is removed), so links and the newest 16 re-sendable tokens survive restart and resume. Ids are never reused; files older than 7 days are deleted at startup. Slash commands and `!` bash keep Pi's own path. `false` restores Pi's behavior of inserting the file path. |

## Profiling

Render profiling is disabled by default. To capture render/update/git metrics plus memory, CPU delta, and event-loop utilization:

```sh
PI_GEEK_PROFILE=1 PI_GEEK_PROFILE_OUT=/tmp/pi-geek-profile.jsonl pi
```

Useful environment variables:

- `PI_GEEK_PROFILE=1` enables profiling.
- `PI_GEEK_PROFILE_OUT=/path/profile.jsonl` writes JSONL output. Use `stderr` or `stdout` for stream output.
- `PI_GEEK_PROFILE_INTERVAL_MS=5000` controls summary cadence.

Synthetic self-check:

```sh
npm run profile:render
```

The synthetic bench exercises footer/editor rendering, assistant/tool debounce, and git status refresh. Runtime terminal paint/GPU cost still needs a real Pi TUI capture.

## Notes

- Colors come from the fixed palette, not the active Pi theme; it paints TUI cells explicitly and uses OSC 11 terminal background sync on non-Windows hosts to cover terminal-owned padding/remainder areas. Windows/WSL/Windows Terminal skip OSC 11 unless `forceOSC11` is enabled.
- `transparentBackground: true` skips page/frame background painting and resets OSC 11 so the terminal's own default background (wallpaper, blur) shows through. Real selections and diff accents stay opaque for readability.
- Set `working`, `thinking`, `answering`, and `running` in `customWorkingMessage` to customize the live-state words.
- Existing legacy `customWorkingMessage: true` or `false` values are normalized back to the default label object.

## License

MIT
