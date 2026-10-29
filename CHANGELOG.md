# Changelog

Forked from pi-droid-styling 2.18.0; earlier history: https://github.com/sting8k/pi-droid-styling/blob/main/CHANGELOG.md

## 0.2.2 - 2026-10-29

### Changed
- Removed pi-geek-tui's own render throttle (one frame per 29 ms, about 35 per second). Pi 1.x already limits rendering to one frame per 16 ms, so the extra layer only lowered the frame rate and spaced frames unevenly while scrolling. Measured on Pi 1.4 fullscreen: p95 gap between frames 61 ms → 45 ms (stock Pi: 39 ms).

## 0.2.1 - 2026-10-28

### Fixed
- Extension dialogs in the input area (pi-askuserquestion's ask_user_question, an extension's text input with a long prompt) no longer lose their last rows. The panel cut them to 8 rows and could not scroll to the rest, so the last option or the input field was hidden. Dialogs whose cursor marker the panel does not recognize now get as many rows as the screen holds.

## 0.2.0 - 2026-10-19

### Added
- Pasted images become `[Image #N]` tokens in the input (ported from pi-droid-styling). The image is copied to the session directory, one Backspace deletes the token, the token links to the copy in the chat, and submit sends the image when the model accepts images (the file path otherwise). `imageAttachments`, on by default.

## 0.1.0 - 2026-10-13

First release of pi-geek-tui, a single fixed terminal look for Pi 1.x. Screenshot and details in the README.

### Added
- A continuous rail down the chat. User and agent turns start with a head row (bold name, faint host, path and branch), and the user's prompt sits on a light surface.
- Tool calls are one row each: a badge and the main argument for Pi's built-in tools (`R` read, `$` bash, `E` edit, `W` write, `G` grep, `F` find, `L` ls), and the name plus `key value` pairs for any other tool. Consecutive calls fold under a `Done(N tool calls)` / `Running(…)` head, and Ctrl+O expands them with dim output.
- An input zone without a box. The head row shows the working-tree diff (`+N -N ~F`) and a matrix-scramble live state word.
- A one-row statusline: thinking-level badge, model, context use and cache hit, plus extension statuses. Context use is always kept.
- A slash-command panel above the input. Settings, model, resume and tree selectors use the same panel, height cap and windowing.
- Streamed answers reveal smoothly with a short fade at the end of the text (`revealAnimation`, on by default).

### Changed (from pi-droid-styling 2.18.0)
- Requires Pi 1.x: the peer dependency range for `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` is now `>=1.0.0 <2.0.0`. Pi 0.x is no longer supported.
- The extension no longer looks for `pi-ctx-kit`'s enhanced edit core to register its own `edit` tool. `pi-ctx-kit` dropped that core in 2.1.0, so the builtin `edit` (styled as before) is always used.
- Tool results no longer carry an unused `__outputChars` count in `details`. `__elapsedMs` is still stamped.
- Removed the dedicated renderers for the third-party `quick_edit`, `substitute_edit` and `target_edit` tools (no installed extension provides them any more). Their calls in old sessions now show as generic tool rows.
