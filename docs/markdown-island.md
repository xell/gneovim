# The markdown island

Context for the CodeMirror 6 editor that is layered over a `filetype=markdown` window when its live preview flag is on.
Everything else is the grid renderer, see [multigrid-renderer.md](multigrid-renderer.md).
The working spec and phase plan is `plans/milestone2.md` (gitignored); this file is the committed record of how the island actually behaves and why.
For the separate macOS Grammarly Desktop compatibility boundary, see [grammarly-markdown-island.md](grammarly-markdown-island.md).

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

### The empty-line cursor widget and the "shake"

The EOL cursor widget (`.nvim-cursor-eol`, used when the cursor sits on an empty line or at end of line) needs `position: absolute` (anchored by `.island .cm-line { position: relative }`), not the more obvious `display: inline-block`.
CodeMirror measures each line's own actual rendered DOM height for its internal scroll math (virtualization, keeping the viewport anchored), not a fixed CSS `line-height`.
As ordinary in-flow content, the widget's own box height feeds into that measurement, so any mismatch between its height and whatever height CodeMirror already expects for that line, in either direction, changes the line's measured height the moment the widget arrives at or leaves it.
That is one half of what showed up as the whole window "shaking" on plain `j` / `k`: a real, if tiny, corrective scroll fired to keep the viewport visually anchored while the line above or below it changed size.
Matching the line's own `line-height` exactly made it worse, not better (the mismatch just moved to every line instead of only empty ones); a shorter fixed height had the same problem in the other direction.
`position: absolute` removes the widget from the line's flow entirely, so its own height can never affect the line's measured height regardless of what it is.

The other half was `Island.scrollTo`, called from the `win_viewport` grid op unconditionally on every redraw touching the window, including a bare cursor move that never actually scrolls (`win_viewport` carries `curline` / `curcol` too, so Neovim resends the same `topline` / `botline` on a plain `j` / `k`).
`EditorView.scrollIntoView` is not a no-op just because its target is already visible: it still re-measures and re-aligns.
When that re-measure lands in the same tick as the cursor widget arriving at or leaving the exact line being aligned to, `topline` itself, it can compute against a height CodeMirror has not finished settling into: one small corrective scroll, then a snap back.
That is why only the very top line of a long, already-scrolled buffer shook, never the middle: `scrollTo` always re-aligns to `topline`, so only a decoration change landing on `topline` itself can race it.
Fixed by having `scrollTo` track the last `{topline, botline, linecount}` it saw and skip the dispatch entirely when nothing about the viewport actually changed, removing the redundant re-align the race depended on.
Reset that tracked state in `applyReset`, since a buffer switch reuses the same `Island` and must not skip its new buffer's first real scroll just because the numbers happen to coincide with the old buffer's last ones.

## Buffer sync: minimal edits

`nvim_buf_attach` reports at line granularity (`on_lines(buf, tick, firstline, lastline, new_lastline)` plus the new line text), so a naive translation would replace the whole changed line range on every edit, even a single keystroke.
`applyBufLines` computes that line-range replace first, then strips the common prefix and common suffix between the old span and the new text before dispatching, so a one character keystroke becomes a one character insertion.

This matters beyond tidiness. A CodeMirror decoration maps through a change by shrinking or dropping whatever the change actually touches, so a whole-line replace drops every decoration on that line (conceal, highlight marks) for one push cycle: `**bold**` before the cursor lost its conceal and bold on every keystroke, changing width and shaking the line, until the minimal-edit fix landed alongside the cursor-field fix above.
The minimal edit leaves decorations outside the actual change untouched.

Verified against fifteen cases (single-char insert and delete, multi-line paste, `:%s`, `J`, `dap`, `o` / `gO`, buffer-boundary edits, and a full `:e` reload both unchanged and fully different): the computed change always reconstructs the target text exactly, and an unchanged `:e` now produces an empty change that `applyBufLines` skips rather than dispatches.

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
- highlights: a union of three reads, same shape as conceal. The treesitter `highlights` query iterated over the viewport (base tree and every injection), one run per capture. Every `nvim_buf_get_extmarks` mark that carries an `hl_group` (LSP diagnostics and semantic tokens, gitsigns, render-markdown). `getmatches(win)`, resolving `matchaddpos()`'s literal positions directly and `matchadd()`'s pattern with `matchbufline()` over the viewport, for plugins that colour a window with `:match` instead of extmarks or `:syntax` (vim-easymotion's jump-target letters, quick-scope). Each group name, from any of the three, is resolved once with `nvim_get_hl(0, { name = g, link = false })` and memoised until `ColorScheme`.
- visual range: `nvim_get_mode()` for the kind (charwise, linewise, blockwise, and the select-mode variants), `getpos("v")` and `getpos(".")` for the two ends. Only emitted when the island's window is the current window.
- folds: `foldclosed` / `foldclosedend` / `foldtextresult` inside `nvim_win_call`, walking the padded viewport and jumping past each closed fold. Source agnostic: whatever `foldmethod` and `foldtext` the user set is what shows.

The treesitter read is the same `highlights.scm` query the treesitter highlighter itself runs; `md_decor.lua` reads its `conceal` metadata, it does not decide what to conceal. Change `foldexpr` or swap the markdown plugin and the island follows with no code change, because it only reads live state.

Why three reads. `synconcealed()` is `:syntax` only on every Neovim version (its implementation calls `syn_get_id` and nothing else), so it misses treesitter conceal, which is where a modern markdown setup hides most markers. `nvim_buf_get_extmarks` returns only extmarks a plugin explicitly set, so it misses treesitter conceal (applied as ephemeral extmarks during redraw, never returned) and `:syntax` conceal (not an extmark at all). Each read covers what the others cannot. Overlapping or duplicate runs across the three are expected and the client drops them.

Neither `synconcealed()` nor the raw query honours `concealcursor`, so `md_decor.lua` re-encodes the one rule "suppress conceal on the window's own cursor line unless `concealcursor` names the current mode" as `conceal_guard_row`, and applies it to all three, plus the heading and blockquote marker hiding below, which is not real conceal and would otherwise ignore the option entirely.

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

`gnv_md_decor` carries `(win, json)` where `json` is `vim.json.encode` of `{ first, last, conceal: [ [row, startByte, endByte, text], ... ], visual: [ [row, startByte, endByte], ... ], folds: [ [startRow, endRow, text], ... ], hl: { runs: [ [row, startByte, endByte, group], ... ], defs: { group: attrs }, codespans: [ ... ], virt: [ [row, col, hideBytes, [[text, group], ...]], ... ] }, heads: [ [startRow, endRow, level], ... ], codes: [ [startRow, endRow], ... ], quotes: [ [startRow, endRow], ... ], visual_hl }` in absolute buffer coordinates.
Columns are byte offsets; the client converts to UTF-16 with `byteToCol` against its own copy of the line.
Sending a JSON string keeps every later slice from needing a new Rust type: extend the Lua table, add a key handler in `Island.applyDecor`.

Decorations are view only, so nothing here reaches `nvim_edit`; `onUpdate` bails on a non `docChanged` transaction.

Decorations live in two fields.

`islandDecorField` holds conceal, highlights, and the visual range: marks and short single line replaces. It maps through edits (`v.map(tr.changes)`) so they stay put between the ~20ms pushes without flashing on every keystroke. The map is wrapped in a `try`: on the (so far unreproduced) chance the mapped set becomes one CodeMirror cannot re-map, it drops to `Decoration.none` rather than throwing, which would abort the transaction and wedge the island for good.

`islandFoldField` holds only the closed fold replaces. Passing a multi-line replace set through `RangeSet.map(tr.changes)` corrupted it so that every later map threw, aborting the transaction and freezing the island permanently: `dd` stopped updating the CM doc, and neither `:e` nor a forced re-attach recovered because `applyReset`'s own full-doc replace hit the same throw. Only destroying the `EditorView` (`:MarkdownLivePreviewOff` then on) escaped.

So this field never calls `RangeSet.map`. On a `docChanged` transaction it walks its ranges and maps each fold's two ends independently with `tr.changes.mapPos` (which cannot throw), keeping a fold whose ends still bracket some content and dropping one whose content was entirely deleted. The rebuild via `Decoration.set` is wrapped in `try`. This keeps folds collapsed through an edit, so the layout does not jump by the fold's line count on every keystroke, which the earlier "drop on any doc change" version did. `applyReset` also clears both fields before its replace, as a belt-and-braces recovery path.

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

### Highlights, what is implemented

Full fidelity, mirror everything the grid shows. `collect_highlights` emits one `{ row, startByte, endByte, group }` run per single line treesitter capture, per `hl_group` extmark, and per `getmatches(win)` overlay over the padded viewport, and a `defs` table mapping each group name to `{ fg, bg, sp, bold, italic, underline, undercurl, strikethrough, reverse }` from `nvim_get_hl` (which resolves the dotted fallback, so `@markup.strong.markdown_inline` returns `@markup.strong`'s attrs).

Client: `mergeHlDefs` turns each group into one CSS rule in a shared `<style>`, keyed by a short stable class (`cm-h-<n>`), so the long group names never enter the DOM. `reverse` swaps fg and bg; `fg == bg` drops both and keeps only the squiggle, matching the grid renderer's `hlCss`. `applyDecor` adds one `Decoration.mark` per run. Marks overlap freely; CM nests the spans and CSS resolves, the same way a browser renders treesitter output. There is no priority resolution: runs keep the query's capture order, so a later (more specific) capture nests inside and wins in the cascade.

`hl.defs` accumulates across payloads (a group seen once keeps its rule even after you scroll away) and is cleared, along with the `<style>`, on the `default_colors_set` grid op. `md_decor.lua` clears its own `hl_cache` on `ColorScheme` and re-resolves. A per window `hl_by_win` snapshot, keyed by `changedtick` and the viewport range, skips the whole collection (treesitter walk, extmark scan, and the match read) on a bare cursor move.

**vim-easymotion and friends.** vim-easymotion's jump-target letters are not virtual text: `s:SetLines` in the plugin genuinely calls `setline()` to swap the target character for the prompt letter while it blocks on `getchar()`, then restores it. That is an ordinary buffer edit, and the island already mirrors ordinary buffer edits through `nvim_buf_attach`, so the letter itself needs nothing new here. The *colour* is the part that needed a new read: easymotion colours the overlay with `matchaddpos()` (`EasyMotionTarget2First` / `Second` and friends), a window-local match, not an extmark or a `:syntax` item, so none of the other three sources saw it. `getmatches(win)` is that fourth source; `matchaddpos()` entries resolve directly from their `pos1..pos8` literal positions, `matchadd()` entries (pattern based) resolve with `matchbufline()` over the viewport, the same way Neovim itself would find them.

Two bugs kept the colour from showing at all, both confirmed against a live headless Neovim with the real plugin loaded, not just reasoned about:

- **The trigger never fired while the overlay was up.** `md_decor.lua`'s push was driven only by VimL autocmds (`TextChanged`, `CursorMoved`, ...), and `TextChanged` in particular is documented to not reliably fire for a change made inside a blocking call. A live trace confirmed it: while easymotion's overlay was visible (buffer already mutated, matches already added, `changedtick` already bumped), zero autocmd events fired; the letters showed only because `nvim_buf_attach`'s low-level `on_lines` (bridge.rs's own, separate attach, for content sync) is unconditional and fires regardless. `md_decor.lua` now takes the same medicine: it lazily attaches its own `on_lines` callback per buffer (`ensure_attached`, called from `push`) that calls `schedule()` directly, alongside the autocmds. A second live trace with `vim.defer_fn`'s own timer instrumented confirmed the deferred callback *does* run during a `getchar()` block, so the debounced push now genuinely happens while the overlay is showing, not just after it closes.
- **`matchbufline`'s 5th argument.** `vim.fn.matchbufline(buf, pattern, first, last, {})` throws `E1206: Dictionary required for argument 5`: a bare Lua `{}` converts to an empty List, not a Dict, the same ambiguity `vim.json.encode({})` has in the other direction. `EasyMotionShade` is a `matchadd()` pattern match and is typically first in `getmatches()`'s list; the original code wrapped the *entire* match loop in one `pcall`, so this error silently aborted processing of every match after it too, including `EasyMotionTarget`'s. Fixed with `vim.empty_dict()`, and each match now gets its own `pcall` so one bad entry cannot take the rest down with it.

**Group priority.** easymotion also adds `EasyMotionShade`, a `matchadd()` covering the *entire* line (dims everything so the bright target letters stand out), layered under its `EasyMotionTarget` marks on the individual letters. Both cover the same character at the target position, and the client flattens overlapping marks onto one element rather than nesting `<span>`s, so which colour wins comes down to whichever group's CSS rule happens to land later in the shared `<style>`. Left to Lua table / JSON iteration order, that has no defined relationship to which layer should show through and could go either way.

Fixed by giving every source a priority, mirroring Neovim's own compositing order (`:syntax` and treesitter lowest at a fixed 100, extmarks at their own `details.priority` or the 4096 default, `:match` always on top at `10000 + getmatches()`'s own `priority` field so relative order among matches, e.g. Target over Shade, is preserved). `collect_highlights` stores it on the group's own resolved attrs (`a.priority`) rather than a side table, since a Lua table used as a JSON object has no defined key order for the client to read a rank from otherwise. `rebuildHlStyle` sorts by that field before emitting rules, so a higher layer's colour always wins a same-specificity tie, deterministically.

`visual_hl` carries `Visual`'s background (or its fg when `Visual` is `reverse`); the client sets it as `--visual-bg` on the island, replacing the fixed tint the visual slice shipped with.

**hop.nvim and overlay virt_text.** A second jump plugin, architecturally different from easymotion: no `setline()`, no `matchadd()`. hop.nvim's hint letters are pure `nvim_buf_set_extmark` calls with `virt_text` and `virt_text_pos = 'overlay'` (its default `hint_type`), real extmarks the moment they are added, confirmed live with the actual plugin. Two more things this exposed, both general, not hop specific:

- **No signal fires at all with no buffer edit.** easymotion's fix (hook `nvim_buf_attach`'s `on_lines`) does not help hop: it never edits the buffer, so `on_lines` never fires. The general fix is a `nvim_set_decoration_provider` registered once, whose `on_win` calls `schedule()` and returns `false` (no need for `on_line`). A decoration provider runs on every redraw of every window, including inside a blocking `getchar()` / `getcharstr()`, the same way `vim.defer_fn`'s timers do (verified live for both); it is the same mechanism treesitter's own highlighter is built on, so it is guaranteed to be live whenever Neovim is drawing anything. `schedule()` is a single boolean check once a push is already pending, so firing on every window's every redraw costs nothing measurable.
- **`hl_by_win`'s cache invalidation missed extmark-only or match-only changes.** It kept a snapshot keyed on `changedtick` and the viewport range, which is exactly right for treesitter/`:syntax` colour (those only change on an edit or a scroll) but wrong for hop's hints or any `matchadd()` added with no accompanying edit: `changedtick` never moves, so the cache kept serving the pre-hint snapshot forever, confirmed live (the decoration provider fired, `push` ran, `getmatches` / the extmarks genuinely had the new data, and the cache still returned the stale empty one). A first fix added a plain count of matches and of extmarks over the viewport to the cache key. That was not enough: hop clears its N `HopPreview` extmarks and creates N `HopNextKey` extmarks in the same breath, so the count is unchanged across a very real content swap, confirmed live with the real plugin (hint letters stayed invisible while blind selection still worked, meaning the state existed but the pushed payload was stale). A second attempt summed extmark ids into the key, reasoning that ids are monotonic and never reused. Also not enough, and for a subtler reason: extmark ids are monotonic only *within a namespace*, not across a buffer. hop's preview marks and hint marks live in two different namespaces, each freshly created and each counting its own ids from 1, so a same-count swap at the same buffer positions produces an identical id sum by construction, not coincidence. Folding in row/col does not help either, since both mark sets sit at the same jump-target positions. What actually differs between the two sets is their *content*, an `hl_group` string versus a `virt_text` payload, so the final fingerprint hashes each mark's id, row, col, priority, `hl_group` bytes, and `virt_text` segment bytes together. This is computed from the one `details = true` extmark fetch `collect_highlights` itself needs anyway, taken once in `push` and passed down, rather than queried twice with two different signatures.

Rendering: `collect_highlights`'s existing extmark scan (already reading every mark for `hl_group`) also checks for `virt_text` with `virt_text_pos == 'overlay'`, summing each segment's byte length as how many buffer bytes the overlay covers and noting each segment's own group for colour resolution, same `resolve_hl` and priority pipeline as everything else. `hl.virt` is `{ row, col, hideBytes, [[text, group], ...] }` per mark. The client renders it as an `OverlayWidget` (one coloured `<span>` per segment, `hlClass(group)` reused) inside a `Decoration.replace` over the covered bytes, in the same overlap-safe span list as conceal, pushed ahead of Neovim's own conceal so an interactive overlay wins a tie.

Known limits: only `virt_text_pos == 'overlay'` is handled. `'eol'` / `'inline'` / `'right_align'` virt_text (appended or inserted content, not a replacement) and `virt_text_win_col`-positioned marks (hop's own past-end-of-line cursor indicator, placed by screen column rather than buffer column) are not rendered yet. hop's `HopUnmatched` dim highlight, which spans the whole window as one multi-row extmark, is also not shown: like a multi-line treesitter capture, a multi-row `hl_group` extmark is skipped by the single-line-only extmark reader.

Known limits: multi line captures are skipped (a fenced code block's raw content gets no colour here beyond the `cm-code-block` background from the structural slice). No `:syntax` `synID` walk yet, so a filetype without a treesitter parser, or a user's `after/syntax` highlight rules, would not colour; add it if it matters. The full `hl` block is sent on every push even when the snapshot was reused, so a fast scroll is the payload size worst case; splitting the feed into cheap (per trigger) and heavy (edit / scroll only) is the fix if it drags.

### Folds, what is implemented

`collect_folds` walks the padded viewport with `foldclosed` / `foldclosedend`, and for each closed fold emits `{ startRow, endRow }`, then jumps past `foldclosedend`. The real fold bounds are used even when they extend past the padded range.

Deliberately not a summary line. An earlier version replaced the whole fold range with a widget showing Neovim's own `foldtextresult()`, a second, synthetic rendering duplicating what the grid renderer already shows. The client now hides only the fold's *body*: one plain (non-block, `CONCEAL_HIDE`) `Decoration.replace` from the end of the first folded line to the `.to` of the last, in the never-mapped `islandFoldField`. The trailing newline is left in place so the next line flows normally. The first line itself is never touched by the replace, so every normal decoration on it (structural styling, heading icon, highlights, conceal) still applies exactly as if it were not folded; the only visible sign that the fold is closed is a `cm-fold-closed` mark recolouring that line's text to `--accent` (`Special`'s resolved fg, see below), added with `!important` so it wins over whatever colour a highlight mark already gives the same text. A replace may not nest, so any conceal run, highlight mark, or visual mark that falls inside the *hidden body* is dropped from `islandDecorField` before its set is built (the fold's own first line is explicitly excluded from that check, since it is not hidden); the fold spans are therefore computed first in `applyDecor`.

Display only. Open a fold from Neovim (`zo`), and the next push drops the decoration.

When the cursor is on a closed fold, Neovim reports it on the fold's first line, which is never hidden, so in practice the cursor renders normally. `cursorDeco` still checks `islandFoldField` for a fold covering the cursor position as a defensive fallback and snaps to the fold's left edge with `side: -1` if it ever lands inside the hidden body. `islandFoldField` is defined before `nvimCursorField` so `cursorDeco` reads the current fold set within the same transaction that adds a fold.

**The accent colour.** Neovim colorschemes share no naming convention beyond the built-in default groups (`:help highlight-default`), the closest thing to a template: nearly every colorscheme colours or sanely links them, since Neovim's own UI falls back to them when unset. `Special` is gneovim's chosen accent source, resolved once per push in `md_decor.lua` (`resolve_hl('Special').fg`) and sent as `accent_fg`; the client publishes it as `--accent` on the island's own root element (`setDecor`, alongside `--visual-bg`), so it is available to any island-scoped CSS, not just the fold-closed line.

Trigger gap: Neovim has no fold autocmd. `zR` / `zM` / `zi` are caught by `OptionSet foldlevel,foldenable`; a `zc` that moves the cursor to the fold start is caught by `CursorMoved`; a bare `zo` with a stationary cursor is only caught by the `CursorHold` backstop (after `updatetime`) or the next cursor move or scroll.

### Structural styling, what is implemented

`collect_structure` reads the base markdown tree (not a highlights query) and walks it by node type over the padded viewport: `atx_heading` and `setext_heading` (level from the marker child, `atx_h1_marker`..`atx_h6_marker`, or `setext_h2_underline` for level 2), `fenced_code_block` and `indented_code_block` (not recursed into, code content is not structurally interesting), `block_quote`. Each becomes `{ startRow, endRow }`, headings with a third `level` element.

The client turns each into one `Decoration.line({ attributes: { class } })` per affected line (`cm-h1`..`cm-h6`, `cm-code-block`, `cm-blockquote`), reusing one decoration instance per class so an unchanged push diffs to nothing. Line decorations at the same position combine their classes, so a heading inside a blockquote gets both. They live in `islandDecorField` alongside conceal and highlights: unlike a fold, a line decoration is a point anchored at `line.from`, so mapping it through edits is exactly what `tr.changes.mapPos` already does internally and carries none of the fold class of risk (see the safety rules below, this is the case study for the rule "prefer `Decoration.line` over a multi line replace"). A line inside a closed fold is skipped, same `inFold` guard as conceal and highlights.

Font size and background come from `Decoration.line`. Two more pieces ride alongside, both deliberately *not* mirroring Neovim's own conceal state:

- **Heading and blockquote markers are hidden unconditionally**, regardless of `conceallevel`. The client regexes the already-known heading and quote lines for the ATX `#..` run (`/^(#{1,6})(\s+)/`) and the blockquote `>` run (`/^(?:[ \t]*>[ \t]?)+/`) and conceals them with a plain hide, or for H1-H3 a `HeadingIconWidget` (see below), in the same overlap-safe span list as Neovim-driven conceal (pushed first, so they win a tie). This is a GUI styling choice layered on top of the block structure the bridge already read, not a second source of truth: given a line is a heading or a blockquote, hiding its marker in favour of the size or the bar is the point of doing size and bar at all. Neither is real conceal, so on its own neither would ever reveal a marker no matter the cursor position or `concealcursor`, unlike Neovim's own conceal.

  Fixed by skipping `guard_row` from the payload (`md_decor.lua`'s `conceal_guard_row(win)`, the same value real conceal is already guarded against, `-1` when `concealcursor` names the current mode and nothing should be revealed) instead of the client's own locally tracked cursor row. Confirmed live: with `concealcursor=nc`, `guard_row` is `-1` in normal mode (nothing revealed, matching real conceal, which was already correct for inline marks and is now also correct for markers) and the actual cursor row in a mode `concealcursor` does not name (matching default Vim behaviour, reveal the raw markup on the cursor line to edit it). Before this fix the client's own row was used unconditionally, which is exactly the *default* `concealcursor=""` behaviour, so it looked correct until a non default `concealcursor` was set.
- **`HeadingIconWidget`** replaces the marker on H1-H3 with a small masked SVG (`assets/heading-{1,2,3}-indicator.svg`, from zennotes commit `e4149083`, a dot then two then three bars). The source SVGs are solid white; CSS `mask-image` reads only their alpha and `background-color` supplies the real colour, so one asset per level covers every colourscheme. H4-H6 just hide, no icon, matching the source project's choice. Setext headings (`===` / `---` underline) have no marker on the text line the regex checks, so they keep font size only for now.

`collect_highlights` also flags every `code_span` node (inline `` `code` ``) it walks, in a `codespans` list alongside its normal capture handling, and the client adds a plain `cm-inline-code` mark for a monospace face: no Neovim highlight attribute carries font family, so this is the same kind of "read structure, add a CSS-only touch" as the marker hiding above, not a colour mirror.

## Decoration safety rules

Learned the hard way from the fold implementation (three rounds: a freeze that survived `:e`, a flash-every-keystroke overcorrection, then a layout-jump-every-keystroke overcorrection, before landing on the rule below). Keep these in mind for every future decoration, in particular the structural styling slice (heading sizes, code fence backgrounds, blockquote bars).

- A decoration that stays within one line is safe to map through edits. `Decoration.mark` and a single line `Decoration.replace` (conceal, highlights, the visual range) map correctly with `RangeSet.map(tr.changes)`: CodeMirror shrinks or drops whatever the change touches and shifts the rest. This is the default, low risk case, and it is what keeps decorations from flickering on every keystroke.
- A decoration that spans multiple lines is a different, higher risk case. The closed fold replace (`[firstLine.from, lastLine.to]`) corrupted `RangeSet.map` into a state where every later map threw, aborting the transaction, so Neovim's buffer echo never landed and the island froze for good; `:e` and a forced re-attach could not recover because they hit the same throw. Isolate any future multi line decoration into its own `StateField`, never call `RangeSet.map` on it, and map it by hand with `tr.changes.mapPos` on each end instead (see `islandFoldField`).
- Prefer `Decoration.line()` over a multi line `Decoration.replace` when the goal is per-line styling, not content replacement. A heading size, a code fence background, and a blockquote bar do not need to hide or swap any text, only add a class to each affected line. `Decoration.line` decorations are anchored at `line.from`, map trivially, and do not carry the fold class of risk at all. Reach for `Decoration.replace` only when content must actually disappear or be swapped for a widget, as conceal and folds do.
- `islandDecorField` (conceal, highlights, visual) and `islandFoldField` (folds) stay separate `StateField`s so a problem in one can never corrupt the other, and each uses the mapping strategy that fits what it holds.
- Recovery stays in place regardless of the above. `islandDecorField`'s map is wrapped in `try` and drops to `Decoration.none` rather than throwing; `applyReset` clears both fields before its full-doc replace, so a forced re-attach (`:MarkdownLivePreviewOff` / on, or the `island desync` catch in `applyBufLines`) can always recover even from an unanticipated case.

## Files

- `src/main.js`: `Island` class (`editableComp`, `gutterComp`, `applyCursor`, `applyBufLines`, `onUpdate`, `onComposeEnd`, `scrollTo`, `applyGutter`, `applyDecor`), `nvimCursorField` / `islandDecorField` / `islandFoldField`, `reconcileIslands`, `byteToCol`, `hlClass` / `mergeHlDefs`, the global `keydown` handler, the `md_decor` / `win_gutter` / `md_preview` listeners.
- `src-tauri/src/runtime/md_preview.lua`: the `w:gnv_md_preview` flag, the `:MarkdownLivePreview*` commands, the gutter option feed.
- `src-tauri/src/runtime/md_decor.lua`: the display bridge feed.
- `src-tauri/src/bridge.rs`: `BridgeEvent::MdPreview` / `WinGutter` / `MdDecor`, the `gnv_*` notify arms, `win_gutters`, `md_decor_refresh`, `island_snapshot`, the refcounted buffer attach.
- `src-tauri/src/lib.rs`: the per window event emits, `nvim_winfts` / `nvim_wingutters` / `nvim_md_decor` commands.
- `styles.css`: `.island`, `.cm-*` overrides, `.nvim-cursor-*`, `.cm-concealed`.
