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

WKWebView exposes the island's `.cm-content` as a single `AXTextArea`. Its
`AXValue` is the island's DOM text and `AXSelectedTextRange` is settable.
`AXSelectedText` also reports as settable, but setting it does nothing inside
a contenteditable island (no DOM mutation, no `beforeinput`), so the
correction itself can only arrive as posted keys. WKWebView reports posted
`CGEvent` keys as `KeyboardEvent.isTrusted === true`. `isTrusted` means the
browser created the event, not that a human physically pressed a key.

Grammarly uses two selection shapes:

1. A collapsed `AXSelectedTextRange`, for example `283:283`, followed by the
   inserted text. This is "place a caret here, then type".
2. A ranged `AXSelectedTextRange` over the erroneous span, followed by the
   replacement text. This is "select this, then type over it", the same thing
   a human does in any GUI editor, and it is what the light blue highlight
   over a detected range is. When it fixes several errors in one detected
   range it does this once per error, left to right, reading `AXValue` back
   in between and stopping if the text did not change as expected.

Before this work, the global `keydown` handler called `preventDefault()` and
forwarded every key to `nvim_input`. That cancelled WebKit's native insertion
and sent Grammarly's characters to Neovim, which only knows its own cursor
position. Hence the correction landed at the typing cursor. The first fix
(`a42cda1`) handled shape 1 only; shape 2 was ignored because every check
required a collapsed selection, which produced the second reported failure:
the correction typed at the typing cursor and the erroneous span left intact.

## Compatibility bridge

`IslandInputController.syncSelectionBeforeInput(event, keys)` runs right
before an island key is queued. It reads WebKit's DOM selection (not
CodeMirror's state, which may lag the Accessibility change) and maps both
ends through `posAtDOM`:

* Collapsed and different from the last known or pending Neovim cursor: queue
  `nvim_cursor_set`, then the key.
* Ranged, in Insert or Replace mode, and the key inserts text (a printable
  character, `<Space>`, `<CR>`, `<Tab>`): delete the range in CodeMirror with
  the `fromNvim` annotation, queue `nvim_edit` for the same region, queue
  `nvim_cursor_set` at the range start, then the key. The local deletion is
  needed because the bridge suppresses the buffer echo of its own
  `nvim_buf_set_text`.
* Ranged and the key is `<BS>` or `<Del>`: same deletion, key consumed.
* Ranged and anything else, or not in Insert or Replace mode: restore
  CodeMirror's selection to Neovim's cursor and forward the key unchanged.

`IslandInputController.onSelectionUpdate` still forwards a collapsed external
selection transaction as soon as CodeMirror observes it, using the same rule as
`a42cda1`: no document change, not annotated `fromNvim`, not `select.pointer`,
different from the Neovim cursor. A ranged transaction is left alone; it only
gains a meaning when a key arrives while it is still selected.

All cursor, edit, and input requests of one island share `IslandInputQueue`,
so a posted key cannot overtake the deletion or the cursor placement.

### Pending cursor

Between `nvim_cursor_set` and its `gnv_cursor` echo, the DOM selection already
sits at the new position while `_nvimCursor` still reports the old one. A
second posted key in that window would otherwise queue the same placement
again, behind the first key, moving Neovim back and reversing the typed
characters. The controller therefore remembers `pendingCursor`, the position it
last requested, and treats a DOM selection at that position as already placed
until Neovim echoes it. This closes the residual race the first version of
this note described without any timeout.

Each external placement or replacement writes one `[webview] external ...`
line to the app log. Check that line before modelling any future report.

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
  posted key sequence. A ranged selection in particular must survive until the
  first correction key arrives, because that key is what gives it a meaning.
* Do not treat a ranged Accessibility selection as a Visual or Select mode
  request. Grammarly also sets it merely to highlight a detected range, and
  Select mode would expose typed correction characters to `vmap` mappings.

## Opting a window out

`:GrammarlyOff` (and `On` / `Toggle`, with `!` for every markdown window in
the tabpage) sets `w:gnv_grammarly`; `[markdown] grammarly_default` sets the
initial value. The flag is enforced natively, not in the DOM: Grammarly's
documented web opt-out attributes (`data-gramm="false"` and friends) were tried
first and Grammarly Desktop ignores them, as expected for a client that reads
native Accessibility rather than HTML.

`syncGrammarlyAccessibility` in `main.js` computes one boolean per GUI window,
"the cursor is in an island whose flag is off", re-evaluates it on every
cursor event, redraw batch, preview change, and flag change, and calls
`set_accessibility_hidden` only when it changes. In `lib.rs`,
`webview_accessibility` swizzles the three WKWebView methods that publish web
content to macOS Accessibility, `accessibilityAttributeValue:` (for
`AXChildren`), `accessibilityFocusedUIElement`, and `accessibilityHitTest:`,
and answers with the webview itself and no children while that webview is in
the hidden set. The web process and its content are untouched; only the
projection into the AX tree is withheld, and a
`AXFocusedUIElementChanged` notification is posted so clients re-query.

Observed with the driver below: while hidden, the focused element is an
`AXGroup` with no children, no `AXValue`, and no selection attributes, and
setting `AXSelectedTextRange` has nothing to act on; typing in the island keeps
working; `On` restores the `AXTextArea` immediately. VoiceOver and dictation
lose that window's web content while hidden, by design.

One caveat remains for a client that already holds a handle to the island's
remote element from before the toggle: the handle stays valid until the web
process drops it. In practice Grammarly re-detects the field on focus changes,
which is what the posted notification triggers.

## Reproducing without Grammarly

`scripts/ax-driver.swift` drives the two channels Grammarly has, against the
running dev build, from a terminal with Accessibility permission:

```sh
swiftc -O scripts/ax-driver.swift -o /tmp/ax-driver
/tmp/ax-driver activate        # bring the dev app forward
/tmp/ax-driver probe           # role, AXValue, AXSelectedTextRange
/tmp/ax-driver select 8 5      # ranged selection, UTF 16 offsets into AXValue
/tmp/ax-driver type 'people' 3 # posted keys, 3 ms apart (0 ms is dropped)
```

Put the island in Insert mode first, and keep the typing cursor on a different
line from the target. The buffer, the `AXValue`, and the caret after the
correction should all agree.

## Coordinate rule

Neovim cursor columns are UTF-8 byte columns. CodeMirror positions are UTF-16
code-unit offsets. Convert Neovim columns with `byteToCol` when applying a
cursor to CodeMirror; convert CodeMirror offsets with `byteLen` when sending a
cursor or edit region to Neovim. This matters as soon as text before the cursor
contains accented characters, CJK, or emoji.

## Regression checklist

When changing this bridge, manually check:

1. A Grammarly insertion, deletion, and replacement before and after the
   typing cursor, including two corrections in one detected range.
2. A correction that returns the cursor to its original position.
3. Normal click-to-place-cursor followed immediately by typing.
4. Normal island typing, Backspace, Enter, and undo.
5. IME composition immediately after an external correction.
6. A correction in text containing a multibyte character before either cursor.
