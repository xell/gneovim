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

**Live attempt, 2026-09-15, inconclusive.** Drove the real dev app (real
embedded Neovim, real WKWebView, `System Events` keystrokes, not the headless
harness above) against a duplicate of the reporter's own note: 70 `##`
headings, `foldmethod=expr` + treesitter foldexpr from their real config,
`zM`/`zR` interleaved with typing at three levels of aggression (whole
heading+body blocks; single characters; a mid-document insert that shifts
every later closed fold's row number, specifically to attack the "stale row
number" mechanism above). None of it reproduced the reported symptom: no
`invalid md_decor payload` / `island decor build failed` / `island desync`
/ `fold remap failed` ever logged, and every heading rendered with the
correct icon and size at every checkpoint. The aggressive runs did corrupt
buffer text (words merged, fragments duplicated) — but a `:w` after each run
showed the corruption on disk byte-for-byte identical to what the island
rendered, which rules out an island-only decoration bug for those runs: it
was this test's own blind keystroke automation racing Neovim's search
command and insert-mode transitions, not a client/server disagreement.
Net result: the theory above is unconfirmed. Either the window is narrower
than these synthetic bursts modeled, it needs conditions this session
couldn't reproduce (a much larger document, a longer live session, real
human pause/burst timing, Grammarly or another accessibility client also
polling the same island), or there is a real contributing cause not yet
identified. If it recurs, the next step is turning the `tick` `push()`
already computes into a logged value on both the Lua push and the client's
last-applied buf-lines edit, so a live capture can show whether the two
ever actually diverge.

The real fix, not yet implemented, is giving channel 2 a version stamp (send
`tick` in the `md_decor` payload; have the client's buffer-echo path record
its own last-applied tick; drop or requeue a `md_decor` payload whose tick is
older than what the island has already applied) so a stale payload is
detected and discarded instead of silently mis-painted.

## The actual mechanism caught live, 2026-09-15 (second recurrence)

The above is still an untested theory for how a *display* glitch starts. But
when the bug recurred for real on Leo's live note (not a synthetic repro) and
made editing itself impossible ("what I type or delete cannot be displayed
correctly", surviving `:GneovimResyncIsland` and even closing and reopening
the buffer), the app log (`~/Library/Logs/com.xell.gneovim/gneovim.log`)
caught the actual proximate mechanism directly, and it is a different bug
from the one theorized above — one that turns *any* transient rendering
glitch into a permanent, self-reinforcing one:

```
external caret 7:6 before j
external caret 7:6 before j
external caret 7:6 before j
...
```

The same `{row, col}` repeated across many unrelated subsequent keys.
`IslandInputController.syncSelectionBeforeInput` (`src/island-input-controller.js`)
samples WebKit's real native `Selection` before every keystroke and, if it
disagrees with Neovim's authoritative cursor, treats the disagreement as a
genuine external move (Grammarly, a click) and drags Neovim's cursor back to
wherever the DOM reports — that is by design, it is how a Grammarly
correction reaches Neovim at all. The design assumption is that a real
external client sets a *new* target each time it acts. It does not hold once
the native caret gets stuck: if WebKit's Selection freezes at one spot (most
likely because CodeMirror tried to place it inside a decoration's replaced
range and the browser cannot seat a real caret there — the same class of
problem `isCursorHidden` exists for, just not a case it currently catches),
every subsequent keystroke reads that same frozen spot, is honoured as if it
were a fresh external correction, and drags Neovim's real cursor backward to
it before applying the key. The two prior same-day fixes to this exact
function (`bea7c4b`, `8bfc859`) both describe this identical failure shape —
"froze the visible cursor... corruption of the buffer" — but only handle a
mismatch that is stale by exactly one keystroke (`priorCursor`); a caret that
never recovers at all, across arbitrarily many keys, was not covered.

This also explains why the existing mitigations only ever helped briefly:
`:GneovimResyncIsland` and a buffer reload refresh the *display* and
reattach the island, but neither resets this input-side state, and whatever
first froze the DOM caret can refreeze it within the next few keystrokes —
which the log confirms: a `resync_island` line is followed within ten
seconds by the same `external caret` loop starting again at a new frozen
spot.

**Fix (commit after 323a17e):** `IslandInputController` now also tracks
`lastExternalTarget`, the last collapsed-caret target *this boundary itself*
asked Neovim to adopt. If the DOM still reports that same target after
Neovim's cursor has since moved away from it for a real reason (proof the
correction was superseded by genuine input, not merely still in flight), the
mismatch is no longer honoured — the key is just let through at Neovim's own
cursor, and `syncSelectionToCursor()` is called to give WebKit an explicit,
fresh reason to re-seat its caret at the real position. This stops the
active-corruption feedback loop unconditionally, regardless of what froze
the caret in the first place. Covered in
`src/island-input-controller.test.js` ("stops chasing a native caret that
never recovers across many real keys"). It does **not** explain or fix why
the caret freezes to begin with — that is still the open question above (the
untick'd `md_decor` race, a stray decoration `isCursorHidden` does not check,
or something else). If it recurs, `frozen external caret ROW:COL ignored
before KEY` in the log now marks exactly when a freeze started, which is far
more useful for finally chasing the root cause than the corruption it used
to cause.

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
