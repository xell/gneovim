# Grammarly and the Markdown island

This note records the debugging model for Grammarly Desktop corrections in a
Markdown live-preview island. It is deliberately separate from
`markdown-island.md`: Grammarly is an external macOS integration with timing
and ownership rules that are easy to mistake for ordinary CodeMirror editing.

## The observed failure

Grammarly finds and highlights errors at the right text location. Its
suggestion panel also appears at that location. But clicking **Fix** could
insert the correction at Neovim's typing cursor somewhere else in the buffer.

For example, with the Neovim cursor after `ok` on one line, Grammarly offered
to change `ADHD people` to `ADHD, people` on a later line. It inserted `,` after
`ok`.

## What Grammarly Desktop does

This is not a browser extension injected into the WKWebView. Grammarly Desktop
is a separate macOS process, so its useful paths into the webview are macOS
Accessibility and posted keyboard events.

The live trace showed this sequence:

1. Grammarly set the island's DOM selection to the error location, for example
   `283:283`. The collapsed selection means "place a caret here, then type",
   rather than a direct range replacement.
2. No DOM `beforeinput` followed.
3. Neovim reported its original cursor advancing one column, exactly matching
   the first character of Grammarly's correction.

The consistent explanation is that Grammarly sets `AXSelectedTextRange`, then
posts keyboard events for its correction. WKWebView reports posted `CGEvent`
keys as `KeyboardEvent.isTrusted === true`. `isTrusted` means the browser
created the event, not that a human physically pressed a key.

Before this work, the global `keydown` handler called `preventDefault()` and
forwarded every key to `nvim_input`. That cancelled WebKit's native insertion
and sent Grammarly's character to Neovim, which only knows its own cursor
position. Hence the correction landed at the typing cursor.

## Compatibility bridge

The island now treats a collapsed CodeMirror selection transaction as an
external cursor placement only when all of these are true:

* it changed no document text
* it was not annotated `fromNvim`
* it was not `select.pointer`, because `onMousedown` already handles an
  ordinary mouse placement
* it differs from the last known Neovim cursor

`onExternalSelection` converts that CodeMirror position to Neovim's
row plus UTF-8 byte column and queues `nvim_cursor_set`. All island
`nvim_input` calls share the same promise queue. Thus a Grammarly key cannot
overtake the cursor placement request: Neovim moves to Grammarly's requested
position first, then receives the posted correction keys normally.

If Grammarly later restores its Accessibility selection to the original typing
location, the same selection bridge moves Neovim back. This preserves the
expected workflow without making CodeMirror locally authoritative for buffer
contents.

The queue is also used for an island mouse placement and an IME commit, which
removes an otherwise possible cursor versus next-input ordering race.

## What not to infer

* Grammarly annotations prove that it can read the editable accessibility tree.
  They do not prove that it has a direct DOM range-edit API.
* A missing `beforeinput` does not mean no correction happened. In this case it
  is evidence that the global key forwarder intercepted a posted key first.
* Do not use `KeyboardEvent.isTrusted` to distinguish Grammarly Desktop from
  hardware input.
* Do not introduce a timed "external edit mode" that lets arbitrary keys edit
  CodeMirror natively. That would create a second editor whose Backspace,
  Enter, IME, undo, and mapping semantics can diverge from Neovim.
* Do not restore CodeMirror's native selection immediately after every external
  selection change. Grammarly needs that selection long enough to start its
  posted key sequence.

## Residual intermittent failure

The bridge works in normal use but is not yet a guarantee. An occasional
correction still reaches the old Neovim cursor. The remaining race is likely
between Accessibility setting the DOM selection, CodeMirror's
`selectionchange` observer dispatching the selection transaction, and
Grammarly posting its first key. The JavaScript queue orders operations only
after the selection transaction has reached `onExternalSelection`; it cannot
order a key that arrives before that notification.

Do not paper over this with a timeout. If this is revisited, collect one
causal timeline with:

1. capture-phase `selectionchange` and `beforeinput` events
2. CodeMirror selection transactions and their `userEvent`
3. every `nvim_cursor_set` and `nvim_input` request with a monotonic id
4. the existing native key monitor's `CGEvent` source process id, compared to
   Grammarly's process id

That will establish whether the first posted key precedes the AX notification,
or whether another path is involved. A native macOS-level ordering solution may
then be warranted, but only with this evidence.

## Coordinate rule

Neovim cursor columns are UTF-8 byte columns. CodeMirror positions are UTF-16
code-unit offsets. Convert Neovim columns with `byteToCol` when applying a
cursor to CodeMirror; convert CodeMirror offsets with `byteLen` when sending a
cursor or edit region to Neovim. This matters as soon as text before the cursor
contains accented characters, CJK, or emoji.

## Regression checklist

When changing this bridge, manually check:

1. A Grammarly insertion, deletion, and replacement before and after the
   typing cursor.
2. A correction that returns the cursor to its original position.
3. Normal click-to-place-cursor followed immediately by typing.
4. Normal island typing, Backspace, Enter, and undo.
5. IME composition immediately after an external correction.
6. A correction in text containing a multibyte character before either cursor.
