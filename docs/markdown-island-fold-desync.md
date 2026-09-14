# Markdown island / grid desync under heavy folding

Reported symptom: editing a markdown outline (many `## heading` lines, one
blank line between each, `foldmethod=expr` /
`foldexpr=v:lua.vim.treesitter.foldexpr()`) with frequent `zR` / `zM` produces
visible rendering glitches in the live-preview island: several headings
render as plain text, other decorations look wrong, and eventually typing
stops landing where expected. The island and the grid (Neovim's own idea of
the buffer) have diverged. Toggling `:MarkdownLivePreviewOff` / `On` clears it
for a while; it comes back, and the only durable fix so far has been closing
the gui-window/tab and reopening the note.

## The two channels

The island keeps in sync with Neovim over two entirely independent paths:

1. **Content.** `nvim_buf_attach`'s `on_lines` fires synchronously on every
   real edit (`bridge.rs`, `BridgeEvent::Lines`). The client applies it
   immediately in `Island.applyBufLines` (`src/main.js`), with an explicit
   changedtick protocol (`EditSync` in `bridge.rs`) to tell CM6's own edit
   echoes apart from genuine external ones.
2. **Display.** `runtime/md_decor.lua` mirrors Neovim's conceal / fold /
   highlight / heading state into a JSON payload, debounced 20ms
   (`schedule` / `flush` / `vim.defer_fn(flush, 20)`) and pushed over its own
   `gnv_md_decor` notification. The client applies it in
   `IslandDisplayDecorations.set` / `.apply()` (`src/island-display-decorations.js`).

Payload rows in channel 2 (`folds`, `heads`, `codes`, `quotes`, `hl.runs`,
...) are plain 0-based buffer line numbers. They are only meaningful against
the buffer state they were computed from. Channel 2 carries **no version
stamp** — no changedtick, no sequence number — and
`main.js`'s `nvim.on("md_decor", ...)` applies whatever arrives with no check
against what the island's own CodeMirror document currently is. `push()` in
`md_decor.lua` does compute `local tick = vim.api.nvim_buf_get_changedtick(buf)`,
but only to fingerprint its own highlight-reuse cache; it never leaves the
Lua file.

## The race

`flush()` always reads fresh buffer state at the moment it *runs*, so a given
payload is internally consistent with Neovim's buffer at that instant. The
problem is what happens between that instant and the moment the client
applies it:

- Channel 1 (`Lines`) has no debounce; each keystroke's edit lands in the
  island's document within roughly one IPC round trip.
- Channel 2 (`md_decor`) is deliberately debounced by 20ms, then still has to
  cross the same IPC boundary, get `JSON.parse`d, and reach `apply()`.

If the user keeps typing (or keeps folding/unfolding, which reschedules the
same debounce) during that window, one or more further line-count-changing
edits can land on the CM6 document *before* an in-flight `md_decor` payload
computed against the *previous* line count is applied. Its row numbers are
still in range (so nothing throws — `headingMarkerRanges`, `structuralLineStarts`,
`foldRanges` all bounds-check against `doc.lines`), but they now point at the
wrong lines:

- `headingMarkerRanges` (`src/pure/markdown-decoration-plan.js`) re-derives
  the heading marker from the *current* line text with
  `/^(#{1,6})(\s+)/`. If the shifted row's text is no longer a heading, the
  regex fails to match and that heading silently gets no icon / marker
  decoration — it renders as plain text. This matches the reported symptom
  exactly.
- `addLines` (`island-display-decorations.js`) has no such content check: it
  unconditionally tags whatever line now sits at the stale row with
  `cm-h{level}` / `cm-code-block` / `cm-blockquote`, so an unrelated line can
  pick up heading/code/quote styling it should not have.
- `foldRanges` (`src/pure/fold-ranges.js`) does the same for closed-fold
  spans: a stale `[startRow, endRow]` now hides (`Decoration.replace`) a
  different, currently-live span of text than the one Neovim actually has
  folded.

That last one is what turns a cosmetic flash into a stuck island. A
`Decoration.replace` placed over text the user is actively editing, at a
position `isCursorHidden()` (`src/main.js`) then reports as hidden, pushes
the cursor rendering down the "cursor inside a fold" path
(`island-decoration-state.js`'s `cursorDecorations`): a block caret pinned to
the fold's left edge instead of the real DOM caret. Once that happens the
external-caret sync and the input controller are reconciling against a
position that does not correspond to anything Neovim thinks is folded, which
is consistent with "I cannot type again."

Recovery normally happens for free: the *next* successful `md_decor` push
computes `ranges` and `foldSpans` from scratch (never incrementally from the
previous decoration set), so one clean payload should immediately supersede a
stale one. The reported case is worse specifically *because of* the volume
of fold activity: every `zR` / `zM` and every `OptionSet` on
`foldlevel`/`foldenable`, plus the decoration-provider backstop that fires on
every redraw, reschedules `flush()`. On a document that is simultaneously
being typed into quickly (writing the outline itself), that raises how often
an in-flight payload is stale by the time it lands, and once the cursor gets
wedged behind a bogus fold decoration, the user is no longer generating the
`CursorMoved` / `TextChanged` events that would otherwise schedule the
correcting push — a stable stuck state instead of a one-frame flicker.

## Why this is a theory, not a proven root cause

This is inferred from reading the two channels' code, not from an
instrumented repro (no changedtick or sequence number is logged anywhere
today, so a live capture could not yet distinguish "stale payload race" from
"Neovim's own treesitter foldexpr returned a stale fold" — a second,
independent possibility: `vim.treesitter.foldexpr()` has a documented history
of caching quirks under bulk fold-level changes on some Neovim versions).
The two are not mutually exclusive and the fix below is deliberately blunt
enough to paper over either.

The real fix, not yet implemented, is giving channel 2 a version stamp (send
`tick` in the `md_decor` payload; have the client's buffer-echo path record
its own last-applied tick; drop or requeue a `md_decor` payload whose tick is
older than what the island has already applied) so a stale payload is
detected and discarded instead of silently mis-painted.

## The escape hatch: `:GneovimResyncIsland`

Until the tick-based fix lands, `:GneovimResyncIsland`
(`runtime/md_preview.lua`) is a hard, always-global reset, for when toggling
live preview off/on has not held:

1. `zX` in every markdown window: re-applies `'foldlevel'` to every fold,
   discarding whatever the fold engine's own state currently disagrees with
   foldexpr about (the second, unproven possible cause above).
2. `_G.__gnv_resync_decor(win)` (`runtime/md_decor.lua`): drops that window's
   highlight-cache fingerprint and calls `push(win)` synchronously, bypassing
   the 20ms debounce, so this reset's own decor payload cannot itself race a
   later edit the way a normal scheduled one can.
3. `gnv_resync_island` notifies the client, which runs
   `islandManager.reconcile(true)` (`src/island-manager.js`) — the same
   detach-and-reattach-from-a-fresh-snapshot path `applyBufLines` already
   falls back to on a caught desync — followed by
   `nvim.refreshMarkdownDecorations()`.

It is global and takes no bang: a full resync is meant to be the one command
that always works, not a per-window scalpel.
