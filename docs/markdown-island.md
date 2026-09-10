# The markdown island

Context for the CodeMirror 6 editor that is layered over a `filetype=markdown` window when its live preview flag is on.
Everything else is the grid renderer, see [multigrid-renderer.md](multigrid-renderer.md).
The working spec and phase plan is `plans/milestone2.md` (gitignored); this file is the committed record of how the island actually behaves and why.

One CodeMirror instance per previewed markdown window, keyed by window id in the `islands` map in `src/main.js`, mounted and unmounted by `reconcileIslands`.
Two windows on one buffer share a single refcounted `nvim_buf_attach` in `bridge.rs`.
A markdown file shown in a float stays on the grid.
`:MarkdownLivePreviewOff` drops a window back to grid rendering; `w:gnv_md_preview` (0 or 1, maintained by `runtime/md_preview.lua`) is the single source of truth for "is this window an island".

## Neovim is the sole editor

The island carries no `basicSetup`.
No keymap, no history, no `closeBrackets`, no `autocompletion`, no `indentOnInput`.
Every key that reaches a focused island is forwarded to `nvim_input` by the global `keydown` handler, which also calls `preventDefault()` so the contenteditable never inserts the character locally.
So `imap`, `:iabbrev`, `<C-r>=`, `<C-x>` completion, `<C-o>`, and `u` all run in Neovim and their text result streams back through `nvim_buf_attach`.
There is no CodeMirror command competing for `<CR>` / `<BS>` / arrows / `Mod-z`.

The `onUpdate` to `nvim_edit` path stays for mutations that bypass `keydown` entirely: Grammarly, macOS autocorrect, spell replace, drag and drop, IME commit.
`onComposeEnd` reverts the local IME composition and sends the committed text through `nvim_input`.

Prose niceties that CodeMirror's keymap used to give (bracket matching, list continuation) are expected to come from Neovim config or plugins, not from CodeMirror.

## The cursor

The island cursor is our own `nvimCursorField` decoration in every mode: a block mark over the char in normal mode, an end of line block widget at EOL, a thin bar widget in insert mode.
`drawSelection()` is not used and the native caret is hidden (`caret-color: transparent`).

Reason: `drawSelection` and the native caret both track CodeMirror's selection state, and `applyBufLines` replaces the whole current line on every keystroke, which maps a caret inside the replaced range to `line.from`.
That produced a bar that flickered at the far left of the current line on every keypress.
Driving the caret only from `setNvimCursor` (the `gnv_cursor` feed) removes that class of bug.
Under fast typing the decoration can trail one character for a single frame until the cursor feed arrives; it never jumps to the line edge.

## The number column

`runtime/md_preview.lua` also mirrors each markdown window's `number`, `relativenumber`, `numberwidth`, `signcolumn`, `foldcolumn` to the client, on `OptionSet` for those names and on the window events, with a `win_gutters` pull for first attach.
The island renders `number` and `relativenumber` through a `lineNumbers()` in a compartment (`gutterComp`).
`relativenumber` repaints on cursor line change via an rAF coalesced compartment reconfigure.
`numberwidth` sets a `--gutter-numw` CSS var used as the column min width.
`signcolumn` and `foldcolumn` are carried in the payload but not painted yet; they get content with the display bridge.

## End of buffer scroll

The island box is `p.h` monospace cells tall, where `p.h` is the Neovim window's row count, but CodeMirror lines are taller (proportional serif), so the box fits roughly `0.66 * p.h` lines.
Mid buffer this is invisible: Neovim keeps scrolling and re-sends `topline`, the island follows.
At the end of the buffer Neovim stops scrolling once it believes the last line is on the last row, and pinning that `topline` to the top of the box left the last `~0.34 * p.h` lines clipped and unreachable (the count tracked `p.h`, so a split changed it).

`Island.scrollTo` takes `botline` and `linecount` from `win_viewport`.
When `botline >= linecount` (Neovim is already showing the end of the buffer) it sits the last line on the box bottom instead of pinning `topline`, so every trailing line that fits is shown.
Away from the end, `topline` is pinned to the top as before.
The one accepted cost is a jump of about `p.h - capacity` lines at the single scroll step where you cross into or out of the end zone.

## The display bridge (`runtime/md_decor.lua`)

Mirrors Neovim's already computed per window display state for a previewed markdown window into CodeMirror decorations.

### It does not reimplement anything

`md_decor.lua` never runs its own `foldexpr`, its own conceal evaluation, treesitter, a syntax file, or `render-markdown.nvim`.
It reads the results those produce with built-in calls and forwards them:

- conceal: a union of three reads, because no single Neovim API reports conceal from every source. `synconcealed(lnum, col)` walked over the viewport gives `:syntax` conceal. `vim.treesitter.query.get(lang, 'highlights')` iterated over the viewport, collecting captures whose `conceal` metadata is set, gives treesitter conceal (the base language tree and every injected one). `nvim_buf_get_extmarks(buf, -1, a, b, { details = true })` filtered to marks with a `conceal` field gives render-markdown style extmark conceal.
- highlights: `nvim_buf_get_extmarks(buf, -1, a, b, { details = true })` plus `nvim_get_hl` (later slice)
- visual range: `nvim_get_mode()` for the kind (charwise, linewise, blockwise, and the select-mode variants), `getpos("v")` and `getpos(".")` for the two ends. Only emitted when the island's window is the current window.
- folds: `foldclosed` / `foldclosedend` / `foldtextresult` inside `nvim_win_call`, walking the padded viewport and jumping past each closed fold. Source agnostic: whatever `foldmethod` and `foldtext` the user set is what shows.

The treesitter read is the same `highlights.scm` query the treesitter highlighter itself runs; `md_decor.lua` reads its `conceal` metadata, it does not decide what to conceal. Change `foldexpr` or swap the markdown plugin and the island follows with no code change, because it only reads live state.

Why three reads. `synconcealed()` is `:syntax` only on every Neovim version (its implementation calls `syn_get_id` and nothing else), so it misses treesitter conceal, which is where a modern markdown setup hides most markers. `nvim_buf_get_extmarks` returns only extmarks a plugin explicitly set, so it misses treesitter conceal (applied as ephemeral extmarks during redraw, never returned) and `:syntax` conceal (not an extmark at all). Each read covers what the others cannot. Overlapping or duplicate runs across the three are expected and the client drops them.

Neither `synconcealed()` nor the raw query honours `concealcursor`, so `md_decor.lua` re-encodes the one rule "suppress conceal on the window's own cursor line unless `concealcursor` names the current mode" and applies it to all three.

### Lifecycle: always on, guarded per window

There is one augroup, `gnv_md_decor`, registered once at connect and never torn down.
It fires on `CursorMoved`, `CursorMovedI`, `TextChanged`, `TextChangedI`, `WinScrolled`, `ModeChanged`, `WinEnter`, `BufWinEnter`, and `OptionSet conceallevel,concealcursor`.
On each fire it iterates the windows and, per window, checks `w:gnv_md_preview == 1` before doing any work.
A grid window costs one variable read per event and nothing else.
`:MarkdownLivePreviewOff` / `On` never touches this augroup: `md_preview.lua` flips the flag it reads, and the client mounts or unmounts the island.

The callback is debounced with `vim.defer_fn(flush, 20)` because the trigger events arrive in bursts (a held `j`, a paste, an insert).

The payload covers the Neovim window's `topline..botline` padded by 40 rows each side, so it always spans what the island can show even though the island fits a different line count than the Neovim window (see the scroll section).
The client rebuilds its whole decoration set from each payload; anything outside the padded range is simply absent.

### Getting the first payload

No trigger event has fired for a window at the moment it becomes an island (mount) or at first attach.
So the client pulls: `attachIsland` calls `invoke("nvim_md_decor")` after the buffer snapshot loads, and the connect replay block calls it once.
`Bridge::md_decor_refresh` runs `nvim_exec_autocmds('CursorMoved', { group = 'gnv_md_decor' })`, which drives the same debounced push path; the payload arrives as a `gnv_md_decor` event a beat later.
This one path covers both mount and live toggle on.

### Payload and coordinates

`gnv_md_decor` carries `(win, json)` where `json` is `vim.json.encode` of `{ first, last, conceal: [ [row, startByte, endByte, text], ... ], visual: [ [row, startByte, endByte], ... ], folds: [ [startRow, endRow, text], ... ] }` in absolute buffer coordinates.
Columns are byte offsets; the client converts to UTF-16 with `byteToCol` against its own copy of the line.
Sending a JSON string keeps every later slice from needing a new Rust type: extend the Lua table, add a key handler in `Island.applyDecor`.

Decorations are view only, so nothing here reaches `nvim_edit`; `onUpdate` bails on a non `docChanged` transaction.

### Conceal, what is implemented

`conceallevel` 0 returns nothing.
Otherwise each source contributes runs `{ row, startByte, endByte, text }`:

- `synconcealed()` per byte column, adjacent cells with the same `region_id` coalesced into one run, `text` taken from its replacement string (already correct for the level).
- treesitter: each single line capture node with `conceal` metadata, `text` from `text_for(cchar)` which applies the level rules (1 -> cchar or space, 2 -> cchar or nothing, 3 -> nothing).
- extmarks: each single line mark with a `conceal` field, `text` from `text_for`.

An empty `text` renders as a plain `Decoration.replace` (the run vanishes); a non empty one renders once for the run as a `ConcealWidget`.
The client sorts every run by start and drops any that overlaps the previous one, so duplicates across the three sources and rare cross source overlaps are handled.

Known limits of this slice:

- single line conceal only. A treesitter or extmark conceal whose range spans a line break is skipped, as is `conceal_lines` (whole line conceal). Rare in markdown.
- the padded rows outside Neovim's own viewport rely on `parser:parse({first,last})` having run; `md_decor.lua` calls it, but a brand new buffer can be one debounce behind on those rows.
- the treesitter read iterates every highlight capture in the viewport per debounced push, and `synconcealed` walks every byte of every viewport line. Fine for prose; a pathological long minified line or a huge injected code block would be the worst case.
- under fast typing a payload can be one debounce interval stale; the next `TextChanged` corrects it.

### Visual range, what is implemented

`collect_visual` runs only when the island's window is the current window and `nvim_get_mode()` is a visual or select mode.
It normalises the `getpos("v")` and `getpos(".")` ends, then emits one `{ row, startByte, endByte }` run per line, clamped to the padded viewport:

- charwise: the first line starts at the anchor column, the last line ends just past the character under the far end (`strpart` gives that character's byte length), inner lines are full width.
- linewise: every line full width.
- blockwise: the column band `[min, max]` on every line, right edge inclusive by the same `strpart` rule.

The client renders each run as a `Decoration.mark` with class `cm-nvim-visual`, a neutral background wash, added to the same decoration set as conceal. Marks may overlap the conceal replaces (a hidden marker inside the selection) and each other, so no dedup is needed.
Leaving visual mode fires `ModeChanged`, the next push carries an empty `visual`, and the wash clears.

Known limits: the character-under-cursor byte width fix covers multibyte, but `selection=exclusive`, `virtualedit`, and ragged blockwise right edges are not modelled. The real `Visual` highlight colour is not resolved yet; the wash is a fixed tint until the highlight slice.

### Folds, what is implemented

`collect_folds` walks the padded viewport with `foldclosed` / `foldclosedend`, and for each closed fold emits `{ startRow, endRow, foldtextresult }` with the trailing fill run trimmed, then jumps past `foldclosedend`. The real fold bounds are used even when they extend past the padded range.

The client renders each fold as a `block: true` `Decoration.replace` from the start of the first folded line to the start of the line after the fold (consuming the newlines, so no blank gap), with a `FoldWidget` showing the fold text. A replace may not nest, so any conceal run or visual mark that falls inside a fold is dropped before the set is built. This is why folds are computed first in `applyDecor`.

`FoldWidget` is display only. Open a fold from Neovim (`zo`), and the next push drops the decoration.

Trigger gap: Neovim has no fold autocmd. `zR` / `zM` / `zi` are caught by `OptionSet foldlevel,foldenable`; a `zc` that moves the cursor to the fold start is caught by `CursorMoved`; a bare `zo` with a stationary cursor is only caught by the `CursorHold` backstop (after `updatetime`) or the next cursor move or scroll.

## Files

- `src/main.js`: `Island` class (`editableComp`, `gutterComp`, `applyCursor`, `onUpdate`, `onComposeEnd`, `scrollTo`, `applyGutter`, `applyDecor`), `nvimCursorField` and `islandDecorField`, `reconcileIslands`, `byteToCol`, the global `keydown` handler, the `md_decor` / `win_gutter` / `md_preview` listeners.
- `src-tauri/src/runtime/md_preview.lua`: the `w:gnv_md_preview` flag, the `:MarkdownLivePreview*` commands, the gutter option feed.
- `src-tauri/src/runtime/md_decor.lua`: the display bridge feed.
- `src-tauri/src/bridge.rs`: `BridgeEvent::MdPreview` / `WinGutter` / `MdDecor`, the `gnv_*` notify arms, `win_gutters`, `md_decor_refresh`, `island_snapshot`, the refcounted buffer attach.
- `src-tauri/src/lib.rs`: the per window event emits, `nvim_winfts` / `nvim_wingutters` / `nvim_md_decor` commands.
- `styles.css`: `.island`, `.cm-*` overrides, `.nvim-cursor-*`, `.cm-concealed`.
