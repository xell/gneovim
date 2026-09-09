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

- conceal and highlights: `nvim_buf_get_extmarks(buf, -1, a, b, { details = true })`, plus `nvim_get_hl` to resolve a group name to colours (highlights land in a later slice)
- folds: `foldclosed` / `foldclosedend` / `foldtextresult` (later slice)
- visual range: `mode()`, `getpos("v")`, `getpos(".")` (later slice)

The only Neovim rule it re-encodes is the one liner "suppress conceal on the window's own cursor line unless `concealcursor` names the current mode".
Change `foldexpr` or swap the markdown plugin and the island follows with no code change, because it only reads live state.

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

`gnv_md_decor` carries `(win, json)` where `json` is `vim.json.encode` of `{ first, last, conceal: [ [row, startByte, endByte, text], ... ] }` in absolute buffer coordinates.
Columns are byte offsets (extmark convention); the client converts to UTF-16 with `byteToCol` against its own copy of the line.
Sending a JSON string keeps every later slice from needing a new Rust type: extend the Lua table, add a key handler in `Island.applyDecor`.

Decorations are view only, so nothing here reaches `nvim_edit`; `onUpdate` bails on a non `docChanged` transaction.

### Conceal, what is implemented

`conceallevel` 0 emits nothing.
Level 1 emits the extmark's `conceal` string as a `ConcealWidget` (its `cchar`), or a single space when the string is empty.
Levels 2 and 3 emit an empty string, rendered as a plain `Decoration.replace` (the run vanishes).
An entry whose row range covers the guarded cursor line is dropped in Lua.
Overlapping conceal runs (two plugins concealing the same span) are coalesced on the client because replace decorations may not overlap.

Known limits of this slice:

- extmark conceal only. A `conceal` from a syntax file (the builtin markdown syntax hiding `_` and `**`) is not in `nvim_buf_get_extmarks` and stays visible in the island.
- single line conceal only. Multi line conceal marks (`d.end_row ~= d.row`) are skipped; they are rare in markdown.
- the cursor line gate uses the global `mode()`, so for an unfocused island it is the focused window's mode. `concealcursor=n` (the common case) is unaffected.
- under fast typing a payload can be one debounce interval stale; the next `TextChanged` corrects it.

## Files

- `src/main.js`: `Island` class (`editableComp`, `gutterComp`, `applyCursor`, `onUpdate`, `onComposeEnd`, `scrollTo`, `applyGutter`, `applyDecor`), `nvimCursorField` and `islandDecorField`, `reconcileIslands`, `byteToCol`, the global `keydown` handler, the `md_decor` / `win_gutter` / `md_preview` listeners.
- `src-tauri/src/runtime/md_preview.lua`: the `w:gnv_md_preview` flag, the `:MarkdownLivePreview*` commands, the gutter option feed.
- `src-tauri/src/runtime/md_decor.lua`: the display bridge feed.
- `src-tauri/src/bridge.rs`: `BridgeEvent::MdPreview` / `WinGutter` / `MdDecor`, the `gnv_*` notify arms, `win_gutters`, `md_decor_refresh`, `island_snapshot`, the refcounted buffer attach.
- `src-tauri/src/lib.rs`: the per window event emits, `nvim_winfts` / `nvim_wingutters` / `nvim_md_decor` commands.
- `styles.css`: `.island`, `.cm-*` overrides, `.nvim-cursor-*`, `.cm-concealed`.
