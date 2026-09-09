# The multigrid renderer, and what the redraw protocol actually guarantees

Context for the grid renderer that draws every non `markdown` window verbatim from Neovim's `ext_multigrid` stream, with a CodeMirror island only inside `filetype=markdown` windows. See [state-ownership-and-the-tmux-analogy.md](state-ownership-and-the-tmux-analogy.md) and [gui-window-model.md](gui-window-model.md) for the surrounding model.

Everything below was learned by debugging the renderer while it was built. The through line: **Neovim's redraw stream is aggressively incremental. It sends only the delta since the last flush and assumes the client still holds everything else. Almost every rendering bug was the client throwing away state that Neovim was never going to resend.**

## The one rule

Never discard grid state unless Neovim told you to (`grid_clear`, `grid_destroy`) or you can prove it is about to be fully overwritten. In particular Neovim will not resend:

- a window grid that is not the current window, unless something changes on it
- cells that a resize did not actually move
- the parts of the screen that were correct before whatever you are reacting to

## `nvim_ui_attach` must wait for the client's listeners

`nvim_ui_attach` triggers a full redraw immediately, synchronously with the attach call. That first frame carries every window's `grid_line`, which is the only time the contents of non focused windows are sent unprompted.

If the webview has not yet registered its event handlers when attach runs, that frame is dropped (Tauri does not buffer events for listeners that do not exist yet). Neovim then never resends the non current windows, so they render blank until you physically touch them (`V` plus cursor motion in a window was the only way to force `grid_line` for those rows). This looked exactly like "redraw is broken", but the pipeline was fine, the frame just never had an audience.

Fix: `bridge::connect` builds the split, buffers, and autocmds but does **not** attach the UI. The client calls an explicit `nvim_ui_start(cols, rows)` command only after `Promise.all([...listen...])` resolves. `ui_start` is idempotent: a second call (webview reload) just resizes.

## Do not use `:mode` or `:redraw` to "replay" a lost frame

`:mode` (and a forced `ui_refresh` in general) resets the whole UI: `grid_resize` plus `grid_clear` on every grid, followed by a redraw of only the current window. So using it to recover a lost first frame actively destroys the other windows' content: they get cleared and never redrawn. The timed `nvim_redraw` calls that seemed to help early on were making the real problem worse. The correct fix is to not lose the frame in the first place (above).

## `grid_resize` does not imply a clear

`["grid_resize", grid, w, h]` keeps the overlapping cells. Neovim only sends `grid_line` for cells that genuinely change. A client that reallocates the cell buffer as blank on every resize will leave every unchanged row blank forever after any layout change that shrinks a window and then restores it: `q:` (the command line window is several rows tall), `:copen`, opening or closing devtools (the webview viewport shrinks, the `ResizeObserver` pushes a smaller `nvim_ui_try_resize`, then a larger one on close).

Fix: `GridWin.resize` copies the old cells into the new dimensions and only fills truly new cells with blanks.

A floating window can grow or shrink through `grid_resize` alone, with no fresh `win_float_pos` (a completion popup narrowing its match list). The placed DOM element's size is stored from the last `win_float_pos`, so `grid_resize` must also update that stored `w`/`h` or the old height lingers as a blank band below the real rows.

## `grid_scroll` has the same contract

`["grid_scroll", grid, top, bot, left, right, rows, cols]` moves a rectangle of cells within the grid. The vacated band is **not** cleared by the event; Neovim sends `grid_line` for the revealed cells afterwards. So the client moves cells and leaves the rest alone. Do not blank the vacated region preemptively.

## Row-level repaint

`GridWin` keeps one reused `<div class="grid-row">` per row plus a `dirtyRows` set. `grid_line` marks its row dirty; `repaint()` re-serializes only those rows. A full rebuild (`fullDirty`) happens on `grid_resize`, `grid_clear`, `default_colors_set` (every cell's colour can change), and the post-focus stale-surface repaint. This matters for a held `j` or `<C-d>`: rebuilding all ~50 rows of a window every frame was the dominant cost.

`grid_scroll` on a full-width region (`left == 0 && right == cols`, the normal case) rotates the row-node array to match the cell shift and re-inserts the nodes in the new order, so scrolled text is never re-serialized; only the vacated band is marked dirty and Neovim's following `grid_line` fills it. A sub-column scroll region cannot move whole nodes, so it falls back to marking the band dirty. The cursor is a separate absolutely-positioned overlay (`#grid-cursor`), so row rebuilds never touch it.

## Frame coalescing

`applyGridBatch` does not paint. It appends the incoming ops to `pendingOps` and schedules one `requestAnimationFrame`; `renderGridOps` then applies the whole accumulated list once per frame. Neovim flushes on its own cadence, which under a held `j`, `:%s`, or a large paste is faster than the display refresh, and each paint carries DOM work plus a forced reflow (the WKWebView compositor quirk). Ops keep their arrival order across the coalesced frames, so a later batch's cursor, colour, or layout op still wins. While the window is hidden `requestAnimationFrame` does not fire and `pendingOps` simply accumulates until it is shown again.

## Colors: Neovim 0.10+ ships a real default colorscheme

Even with `-u NONE` there is a built in colorscheme, and the default `background` is `dark`. So `default_colors_set` ships `Normal` as `NvimLightGrey2` on `NvimDarkGrey2`, roughly `#e0e2ea` foreground on `#14141b` background. Those exact values are easy to mistake for a hardcoded theme in the client.

The client honors `default_colors_set` verbatim and publishes it as `--fg` / `--bg` / `--sp`, so `:colorscheme` and `:set background` drive the whole UI. For a bare `-u NONE` session (no user config) the bridge forces `set background=light` so `StatusLine`, `Visual`, `NonText`, and friends get light variants to match the app's light surface; with a real user config that choice is left alone. The hardcoded `#000` / `#fff` / `#d40000` in the client are only a pre-connect fallback for when Neovim sends `-1` (no `Normal` colors).

Grid cells with the default highlight (`hl_id` 0) have no background of their own, so they show whatever is behind them. Give the grid window elements an opaque background, do not rely on the body showing through.

`fg == bg` is a deliberate camouflage convention, not a mistake. Neovim's default `DiagnosticUnderlineError` / `Warn` / `Info` / `Hint` groups (and themes that copy them) set `foreground` and `background` to the same value with `nocombine` and an undercurl/underline in `special`: the glyph is meant to be invisible so only the squiggle shows. Rendered verbatim (`color:X;background:X`) that is a solid block of unreadable text, and with a saturated theme colour it looks like a coloured rectangle over a diagnostic float or virtual-line region. `hlCss` detects `fg == bg` and drops both, so the run inherits Normal fg/bg and stays readable while the `text-decoration` still draws the squiggle in `sp`.

`blend` (0 to 100) on an attribute is the cell's transparency, driven by `winblend` and `pumblend`. `hlCss` appends an alpha byte to the cell's fg and bg colours so the cell composites over the grid element's background. The grid and float elements keep an opaque `--bg`, so a blended cell blends toward the default background rather than showing the buffer literally underneath the float. That is the common terminal-GUI behaviour and is enough unless someone explicitly sets `winblend`; true see-through would need the float element itself to be transparent, which risks hairline gaps between cell spans.

## Ext handles

The `win` field in `win_pos`, `win_float_pos`, and `win_viewport` is a msgpack ext value (the window handle), not a plain integer. Decode it with `rmpv::decode::read_value` and take `.as_i64()`. Same pattern for buffer and tabpage handles.

## Grid identity

- Grid 1 is the outer grid: tabline, window separators, statuslines, and the `~` end of buffer marker for the default grid only. In multigrid mode it does **not** carry window text.
- Each window has its own grid, created by `grid_resize` and placed by `win_pos` (or `win_float_pos` for floats).
- The message area is its own grid, positioned by `msg_set_pos`. Without `ext_cmdline` the command line is drawn into this same grid. Neovim's compositor special-cases it above every floating window, so the client gives it a very large z-index. Otherwise a completion popup that sits directly over the command line row (blink.cmp, nvim-cmp, the `wildoptions=pum` menu) paints its blank tail over the typed text: `:se ft` shows as `:se`.
- The `q:` command line window, `:help`, `:terminal`, netrw, and quickfix are all ordinary window grids. This is why `:terminal` renders with no extra work: a terminal buffer's screen is libvterm state that Neovim only ever exposes as grid cells, and the renderer already draws grid cells.
- A floating window's **border, title, and footer are cells in the float's own grid**, not a separate event. The grid is `width + 2` by `height + 2` when it has a border, and `win_float_pos` positions the outer rectangle. So there is nothing to query from `nvim_win_get_config` and nothing extra to draw: the border glyphs (`╭ ─ ╮ │ ╯ ╰`), the title text, and the footer text arrive as ordinary `grid_line` cells with their own highlight ids. This is a multigrid-only convenience; without `ext_multigrid` the border goes into grid 1.

## Cursor, with a CodeMirror island in the mix

The `gnv_cursor` feed (a `CursorMoved`/`CursorMovedI`/`ModeChanged` autocmd calling `rpcnotify`) reports the **global** cursor position, whichever window has focus. Mirroring it unconditionally into the island's document draws a phantom cursor in the island whenever focus is actually in a grid window, clamped to the island's line count (a cursor that tracks the focused grid window but shows in the island, stuck within its first few lines).

Rules that work:

- Only apply `gnv_cursor` to the island when `cursorGrid === islandGrid`, that is when `grid_cursor_goto` last targeted the island's grid.
- When `grid_cursor_goto` moves to a non island grid, clear the island's cursor decoration.
- `win_viewport` carries `curline` and `curcol` in buffer coordinates for its grid. Use them to re seat the island cursor after a bare window switch that fires no `CursorMoved`.

## WKWebView specifics

- **Measure cell metrics after styles are applied.** On a cold Vite start a `<link rel="stylesheet">` may not be applied when the module script runs, so a monospace probe reports the UA proportional default (about 14 by 18 instead of about 8 by 16). Import the stylesheet from the JS module graph (`import "../styles.css"`) so it is injected during module evaluation, and measure after `document.fonts.ready` with a one frame retry guard.
- **`contain: strict` implies `contain: size`.** An element carrying it does not size to its content, so a probe element with `contain: strict` measures 0 by 0. Keep containment off anything you measure.
- **Opaque backgrounds compose more reliably.** A transparent absolutely positioned layer over a transparent container can fail to paint in WKWebView until an unrelated event (a scroll, a resize). Opaque backgrounds on the grid window elements avoid it. This was a contributing symptom, not the root cause, of the "blank until scroll" behavior; the root cause was the lost first frame.

## General: events emitted before the client listens are gone

Tauri does not buffer events for listeners that do not exist yet. Anything the bridge emits during `connect` (window filetypes from `BufWinEnter` and `WinEnter` autocmds, for instance) is lost. The client registers every `listen()` first, then triggers work, and back fills anything pushed too early with a pull: `nvim_winfts` reads `getwininfo()` on demand to learn window filetypes that arrived as events during connect.

## Tauri: `emit_to(label, ...)` does not scope to one webview

In this app (Tauri 2.11) `AppHandle::emit_to("main", event, payload)` was delivered to **every** webview, not just the one labelled `main`. With one nvim per gui-window that meant window B rendered window A's `grid_line` stream and never its own, which looked like a compositing bug (stale "ghost" content on a macOS tab switch, blank until a keystroke forced fresh frames). The fix: make the event name carry the window label (`gnv://<label>/grid`, ...) and emit it globally with `emit()`; the frontend derives its own label from `getCurrentWebviewWindow().label` and listens for that. Commands are unaffected because they already route by `window.label()`.
