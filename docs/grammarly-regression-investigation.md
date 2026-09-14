# Grammarly regression after the architecture refactor

## Status

**Resolved on 2026-09-14.** The cause was not a refactor regression in the cursor bridge. Grammarly Desktop selects the error span as a *ranged* Accessibility selection and then types the correction over it, and every island path only honoured a *collapsed* external selection. The sections after "Resolution" are kept as the record of the three earlier attempts and why they could not work.

**Regressed again on 2026-09-15 by `bea7c4b`, re-resolved the same day.** See "Second regression" below: an unrelated fast-typing-burst fix gated every collapsed-caret mismatch behind a 250ms quiet window, which also silently dropped genuine Grammarly corrections.

## Second regression: the fast-typing-burst fix (2026-09-15)

`bea7c4b` ("Stop chasing a stale DOM caret during fast typing bursts") fixed a real, separately-confirmed bug: during ordinary fast own typing, the DOM's native Selection can read one keystroke behind CodeMirror's own already-applied position, and honouring that as an external move corrupted the buffer. Its fix added `EXTERNAL_CARET_QUIET_MS`, a 250ms quiet window since the *previous* key (own or external) that every collapsed-caret mismatch had to clear before being trusted.

That gate shared its trigger with Grammarly's own collapsed-placement path (`syncSelectionBeforeInput`'s `range.from === range.to` branch), which is exactly the path a plain "place a caret here, then type" correction uses. Grammarly applies every correction in a detected range one after another, reading `AXValue` back in between rather than waiting for a human pause, so a second correction posted less than 250ms after the first (or after the user's own last keystroke) was silently dropped. Grammarly then read back a result that never landed and stopped, which looked exactly like "Grammarly does nothing" — reported live the same day.

Reasoning about the original bug shape more precisely: the stale DOM read isn't just "recent", it is *exactly* wherever Neovim's cursor stood one call ago (`priorCursor`), because that's the one position CodeMirror's DOM rendering hasn't caught up to yet. `IslandInputController` now compares a mismatch against `priorCursor` instead of timing it: a mismatch equal to `priorCursor` (and no longer equal to the current cursor) is the known stale-echo artifact and is suppressed unconditionally; everything else — including a second external placement one millisecond after the first — is honoured immediately. `src/island-input-controller.test.js` covers both shapes: a synthetic fast-typing burst with a moving one-behind DOM read, and two distinct Grammarly-style corrections posted back to back with no pause.

This was found and fixed by static reasoning plus the existing unit test harness (constructing the exact "moving stale target" shape the original commit described, and confirming `EXTERNAL_CARET_QUIET_MS` was not actually load-bearing for the frozen-target shape its own test used). It was **not** re-verified live against real Grammarly Desktop or `scripts/ax-driver.swift`; do that before considering this closed, per the decision rule below.

## Resolution

### What was observed live

The stand in in `scripts/ax-driver.swift` drives the same two channels Grammarly Desktop has: `AXSelectedTextRange` on the focused Accessibility element, and posted keyboard events. Against the dev build with the island in Insert mode it showed:

1. WKWebView exposes the island's `.cm-content` as one `AXTextArea`. Its `AXValue` is the island's DOM text, and both `AXSelectedTextRange` and `AXSelectedText` report as settable.
2. Setting `AXSelectedTextRange` to a nonempty range selects it in the DOM, which is the light blue highlight over Grammarly's detected range. CodeMirror observes it as an ordinary ranged selection transaction.
3. Setting `AXSelectedText` returns success but changes nothing: no DOM mutation, no `beforeinput`, no CodeMirror transaction. So the only channel that can carry the correction into the island is posted keys.
4. Before the fix, a posted key with a ranged selection reached the global `keydown` handler, which forwarded it to `nvim_input` at Neovim's own cursor. `onSelectionUpdate` returned on `!selection.empty`, and `syncDomSelectionBeforeKey` returned on `!selection.isCollapsed`. That is exactly the reported failure: the correction typed at the typing cursor, the detected range fully intact, no stray deletions anywhere.

The one by one batch failure follows from that. Grammarly reads `AXValue` back after each correction, and when the first correction did not land where its own model says it should, it stops.

### The fix

`IslandInputController.syncSelectionBeforeInput(event, keys)` runs at the same causal boundary as before, immediately before a key is queued, and now reads the whole DOM selection:

* A collapsed selection is a cursor placement, as in `a42cda1`.
* A ranged selection plus a text key (a printable character, `<Space>`, `<CR>`, `<Tab>`) is a replacement. The controller deletes the range in CodeMirror with the `fromNvim` annotation, queues `nvim_edit` for the same region, queues `nvim_cursor_set` at the range start, and only then lets the key through. All three go through `IslandInputQueue`, so Neovim sees delete, cursor, key in that order.
* A ranged selection plus `<BS>` or `<Del>` deletes the range and consumes the key.
* A ranged selection plus any other key, or outside Insert and Replace mode, is dropped by restoring CodeMirror's selection to Neovim's cursor, so a later key cannot replace a span the user never selected.

The deletion is mirrored into CodeMirror locally because the bridge suppresses the buffer echo of its own `nvim_buf_set_text` (see `EditSync` in `bridge.rs`), exactly as for a native DOM edit.

The controller also keeps `pendingCursor`, the last cursor it requested that Neovim has not yet echoed through `gnv_cursor`. Between the request and the echo, the DOM selection already sits at the new position while `_nvimCursor` still reports the old one, so a second posted key in that window used to queue the same placement again behind the first key, which would move Neovim back and reverse the typed characters. The pending position now counts as already placed. That was the "theoretical risk" noted below; it becomes real as soon as typing over a range is allowed, and the ordering test covers it.

### Verified live

With the dev build, Insert mode, and the driver posting keys 3 ms apart:

* `ADHD peple` selected through AX, then `people` typed: the buffer became `ADHD people` and the caret ended right after the correction, which is what Grammarly reads before moving to the next error.
* A second correction (`teh` to `the`) with its range computed from the corrected text landed correctly, the one by one workflow.
* A collapsed AX placement followed by `,` still inserted at the placement (the original `a42cda1` case).
* The same with a multibyte prefix (`日本語 `) and with the typing cursor after the target on the same line.
* Ordinary typing, Backspace, Return, Escape, and undo were unchanged and produced no external selection log lines.

Each external placement or replacement writes one `[webview] external ...` line to the app log, so a future report can be checked against the log before any modelling.

### Follow up noticed on the way

`:e!` on the island's buffer reloaded Neovim's buffer but the island kept the old text (`AXValue` still showed the old line). That is a display reconciliation issue unrelated to Grammarly and was not changed here.

## Original report and the three attempted repairs

Everything below is the state of the investigation before the ranged selection was observed. It stays because it records what the unit tests can and cannot prove about this boundary.

## User-visible reproduction

1. Put Neovim's cursor at one location in a Markdown island.
2. Let Grammarly identify an error at another location.
3. Apply Grammarly's suggestion.
4. The correction text appears at Neovim's original cursor instead of at the error.

The important observation is not merely that the final position is wrong. The correction appears to be generated from the current Neovim cursor from the beginning. This suggests that Grammarly's intended selection is either not entering the synchronization path, is not representable through the DOM state being inspected, or is being superseded before Neovim processes the posted key.

## The original verified fix

Commit `a42cda1` established this model:

```text
Grammarly sets AXSelectedTextRange
→ CodeMirror reports a collapsed selection transaction
→ frontend converts the CodeMirror position to row plus UTF-8 byte column
→ frontend queues nvim_cursor_set
→ Grammarly posts correction keys
→ the same island queue waits for cursor placement
→ frontend sends nvim_input
```

The old implementation added:

1. `_nvimCursor`, the last authoritative Neovim byte position
2. `_nvimInputQueue`, one promise queue for island cursor and input requests
3. `onExternalSelection`, which recognized an eligible collapsed selection transaction
4. `queueNvimCursor` and `queueNvimInput`
5. mouse, IME commit, and global island key paths routed through the same queue
6. protection against stale `win_viewport` cursor coordinates overwriting the temporary external selection

The current architecture appears to retain each responsibility:

* `_nvimCursor` remains on `Island`
* `IslandInputQueue` serializes cursor and input requests
* `IslandInputController.onSelectionUpdate` handles CodeMirror selection transactions
* `IslandInputController.onMousedown` handles pointer placement
* global island keydown uses the Island queue
* `GridCoordinator.applyViewport` replays `SessionModel.lastCursor`, not viewport cursor coordinates
* `NvimClient.cursorSet` and `NvimClient.input` retain the frozen Tauri commands

Because the visible behavior is nevertheless wrong, structural similarity to the old fix is not sufficient evidence that the same causal path still runs.

## Failed repair 1: relax `view.composing`

Commit: `c5eb7b1784f5c824a95ad493e9c9c6ded08d3c3a`

### Hypothesis

`IslandInputController.onSelectionUpdate` rejected an Accessibility selection whenever CodeMirror's broad `view.composing` flag was true. WebKit can leave this advisory flag true after composition, so perhaps Grammarly's selection was being discarded.

### Change

The `view.composing` veto was removed while the controller's owned composition snapshot and post-commit settling state remained guards.

An integrated test proved that, when `onSelectionUpdate` receives an eligible selection, `IslandInputQueue` completes `nvim_cursor_set` before allowing `nvim_input`.

### Result

No observable change in the real Grammarly workflow.

### Lesson

The queue itself can satisfy the intended ordering in a unit test, but that does not prove Grammarly's selection reaches `onSelectionUpdate`. Removing one guard from that handler did not address the live failure.

## Failed repair 2: restore the exact transaction-local rule

Commit: `54d7411cccaba3f109db78fe05dfcb2fdaecc824`

### Hypothesis

Another persistent IME flag, either the owned composition snapshot or `compositionSettling`, still vetoed the selection.

### Change

The eligibility rule was restored to the original `a42cda1` shape. A selection is forwarded when:

1. the transaction does not change the document,
2. `selectionSet` is true,
3. it is not annotated `fromNvim`,
4. it is not `select.pointer`, and
5. the selection is collapsed and differs from `_nvimCursor`.

No persistent composition state participates in that decision.

A test explicitly set every persistent composition flag and proved that an otherwise eligible selection still queued the cursor.

### Result

No observable change in the real Grammarly workflow.

### Lesson

The failure is not caused by the additional guards in the extracted controller. The real workflow either does not produce the assumed CodeMirror transaction, produces a transaction with different properties, or never reaches this listener before the key is handled.

## Failed repair 3: sample the DOM selection at keydown

Commit: `f4e2b6226f2b1ccfe1de0e5ae8403a9616d18635`

### Hypothesis

The original Grammarly note documented a residual race: Grammarly might post its first key before CodeMirror's `selectionchange` observer dispatches a transaction. At keydown, WKWebView's native DOM selection might already be correct even though CodeMirror state is still old.

### Change

The physical island key path now calls `IslandInputController.syncDomSelectionBeforeKey` before queuing the key. That method:

1. reads `contentDOM.ownerDocument.getSelection()`,
2. requires a collapsed selection whose focus node is inside `.cm-content`,
3. maps the node and offset through `EditorView.posAtDOM`,
4. converts the resulting CodeMirror position to a Neovim UTF-8 byte column,
5. queues `nvim_cursor_set` when it differs from `_nvimCursor`, and
6. then allows the same `IslandInputQueue` to send the key.

A test reproduced the intended race in memory: CodeMirror state stayed at the old cursor while the fake DOM selection was at Grammarly's target. The queue ordering passed.

### Result

No observable change in the real Grammarly workflow.

### Lesson

At least one assumption in the DOM fallback is false in the live WKWebView:

* the posted correction may not pass through the global JavaScript `keydown` handler,
* the DOM selection may not be collapsed,
* its node may not be inside CodeMirror's `contentDOM`,
* `document.getSelection()` may not expose the Accessibility selection,
* `posAtDOM` may not map Grammarly's selected accessibility object,
* the selection may already have been restored before keydown, or
* another cursor or input path may run after the sampled request.

Changing the fallback without knowing which condition fails would be another guess.

## What the tests prove, and what they do not

The current unit tests prove:

1. a synthetic eligible CodeMirror selection queues a UTF-8 cursor position,
2. persistent composition flags do not veto that synthetic transaction,
3. a synthetic DOM selection can be mapped at keydown,
4. `IslandInputQueue` does not start the key request until the cursor request resolves, and
5. owned input and cursor calls use the expected `NvimClient` methods.

They do **not** prove:

1. what Accessibility object Grammarly changes in a real WKWebView,
2. whether WKWebView exposes that change through `document.getSelection`,
3. whether CodeMirror emits a transaction for it,
4. which JavaScript or native event carries Grammarly's correction,
5. whether the correction uses `keydown`, `beforeinput`, `input`, composition, or a native replacement API,
6. whether the app instance being tested runs the expected frontend commit, or
7. whether another authoritative cursor event overtakes the external placement.

The distinction matters. All three failed changes improved modeled paths which may not be the live path.

## Highest-value next direction: find the first bad commit

The most economical next step is a manual `git bisect` using Grammarly itself as the test. This uses the known working behavior instead of inventing another model.

Start with:

* known good: `a42cda1be6d99e31fc3015e8ed4117ffa9cad4e6`, after confirming it still works in the current machine and Grammarly version
* known bad: `f4e2b6226f2b1ccfe1de0e5ae8403a9616d18635`

At each selected commit:

1. stop every running dev or installed gneovim instance,
2. build and launch that exact commit,
3. verify the window identifies the expected build if a temporary build marker is available,
4. perform the same correction with the typing cursor and Grammarly target on clearly different lines,
5. mark the commit good or bad, and
6. continue until the first behavior-changing commit is found.

Do not assume `a42cda1` is still good without retesting it. Grammarly Desktop, WKWebView, macOS Accessibility, and CodeMirror may have changed independently. If `a42cda1` is now also bad, this is not a refactor regression in the narrow sense and source comparison cannot recover the old behavior by itself.

This direction has the highest expected value because it answers two decisive questions:

1. Is there actually a good historical commit in today's environment?
2. If so, which exact code change first breaks it?

## Second direction: one causal trace in the real app

If bisect cannot establish a good commit, add temporary observability before changing behavior again. Capture one correction from the moment Grammarly chooses its target until Neovim inserts the first character.

Every record should carry a monotonic sequence number and high-resolution timestamp. Record:

### Browser and CodeMirror

1. capture-phase `selectionchange`
2. `document.getSelection()` anchor and focus node identity, offsets, collapsed state, and whether each node is inside `.cm-content`
3. `EditorView.state.selection`
4. every update listener call with `docChanged`, `selectionSet`, annotations, and `userEvent`
5. capture-phase and bubble-phase `keydown`
6. `beforeinput` and `input`, including `inputType`, `data`, `isComposing`, and target ranges
7. `compositionstart`, `compositionupdate`, and `compositionend`
8. the result or exception from `posAtDOM`

### Frontend requests

1. every call to `IslandInputQueue.cursor`
2. every call to `IslandInputQueue.input`
3. when each queued action actually starts
4. when each `NvimClient` promise resolves or rejects
5. the window id, row, byte column, and key data

### Neovim and bridge

1. entry and completion of `nvim_cursor_set`
2. entry and completion of `nvim_input`
3. the current window and cursor immediately before and after each call
4. every `gnv_cursor`, `grid_cursor_goto`, `win_viewport`, and buffer line event during the correction

The trace should be written to the existing application log, not inferred from DevTools screenshots. One ordered timeline will reveal which assumed arrow in the model is missing or reversed.

## Third direction: verify which native event Grammarly posts

The original investigation inferred posted keyboard events because Neovim's cursor advanced one character and no `beforeinput` appeared. That inference should be reconfirmed.

Use the existing native macOS key monitor, or a temporary focused monitor, to record:

* the `CGEvent` type,
* source process id,
* virtual key code,
* Unicode payload,
* target window,
* and time relative to JavaScript events.

Compare the source process id with Grammarly Desktop. If native monitoring sees the correction but JavaScript `keydown` does not, the global key fallback cannot solve it. The ordering boundary would need to move into the Tauri or AppKit layer, or the correction must be allowed to become a native text replacement which is then mirrored to Neovim.

## Fourth direction: inspect the Accessibility tree, not only the DOM

Grammarly may set an Accessibility range on WKWebView's exposed text object without producing a DOM Selection inside CodeMirror's content node.

Inspect the focused accessibility element and:

* `AXSelectedTextRange`,
* `AXSelectedText`,
* `AXValue`,
* `AXFocused`,
* its role and parent chain,
* and whether the reported character range corresponds to raw Markdown source or rendered replacement text.

Tables, concealed markers, images, and replacement widgets complicate the accessibility text tree. Reproduce first in undecorated plain Markdown prose. If plain prose works but decorated prose fails, the target is likely represented by replacement DOM rather than CodeMirror source positions. If neither works, the issue is earlier in WKWebView or event routing.

## Fifth direction: test the actual correction mechanism separately

Run four distinct cases and trace them independently:

1. Grammarly inserts punctuation at a collapsed AX selection.
2. Grammarly replaces a noncollapsed range.
3. macOS spelling correction applies `insertReplacementText`.
4. a manually dispatched or Accessibility-driven collapsed selection is followed by a normal physical key.

These may use different paths. A fix for posted keys does not automatically fix `insertReplacementText`, and a direct replacement should normally flow through `onDocumentUpdate` and `nvim_edit`, not cursor plus `nvim_input`.

If Grammarly now sends a replacement event instead of posted keys, the correct solution is likely:

```text
beforeinput or CodeMirror document change
→ exact old and new range
→ externalEditRegions
→ nvim_edit
```

In that case, cursor synchronization is the wrong subsystem entirely.

## Sixth direction: look for a later authoritative cursor overwrite

Even if `nvim_cursor_set` is sent correctly, another event might move the cursor back before the correction key is processed.

Specifically inspect:

* `gnv_cursor` replay in the frontend,
* `GridCoordinator.applyViewport`,
* delayed scrolloff handling,
* focus changes which switch the current Neovim window,
* duplicate cursor requests from both the transaction listener and DOM fallback,
* and any plugin autocmd triggered by `nvim_set_current_win`.

The proof needed is the Neovim cursor immediately after `nvim_cursor_set` and immediately before `nvim_input`. Promise ordering proves RPC completion order, but it does not prove that an independent autocmd or request did not move the cursor between those calls.

## Seventh direction: reduce to a minimal island

Test with:

* plain Markdown text,
* no table or image presentation,
* no conceal,
* no folds,
* no EasyMotion or hop overlays,
* no external Markdown rendering plugin,
* and a minimal Neovim configuration.

Then add those layers back one at a time. This distinguishes an input bridge failure from an Accessibility tree problem caused by replacement decorations.

## Changes which should probably be reverted before the next experiment

Commits `c5eb7b1` and `54d7411` changed composition-related selection guards but did not affect the bug. Commit `f4e2b62` added a DOM-selection sample on every physical island key and also did not affect the bug.

The keydown sample has a theoretical risk: if CodeMirror state has the new authoritative Neovim cursor while its DOM selection is briefly stale, a very fast ordinary key could queue the stale DOM position back to Neovim. There is no observed report of this secondary regression yet, but the failed Grammarly result means the added complexity currently has no demonstrated benefit.

Before further investigation, consider reverting the runtime portions of these three commits while retaining this note and any useful tests. Alternatively, keep them only for the first causal trace if their logging points are useful. Do not build another fix on top of them merely because their unit tests pass.

## Decision rule for the next implementation

Do not implement another production change until one of these statements is demonstrated by a live trace:

1. CodeMirror receives the AX selection transaction, but a specific condition drops it.
2. The DOM selection is correct at keydown, but a specific mapping or containment check drops it.
3. The cursor RPC completes at the target, but a named event moves it back before input.
4. Grammarly no longer uses posted keys and instead exposes a concrete replacement transaction.
5. JavaScript never sees the correction event, so the boundary must move to native code.

Once one statement is proven, put the fix in the module which owns that boundary:

* transaction eligibility or DOM mapping in `IslandInputController`,
* request ordering in `IslandInputQueue`,
* Tauri wire behavior in `NvimClient`,
* Neovim cursor and input sequencing in `bridge.rs`,
* or native Accessibility and event handling in `lib.rs`.

Until then, the honest status is that the original causal path is no longer observed, and the three post-refactor repairs modeled the wrong or incomplete path.
