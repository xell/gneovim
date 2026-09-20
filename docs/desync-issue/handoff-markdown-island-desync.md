# Handoff: markdown island / grid desync (still happening)

**Update 2026-09-16 (Paseo session 11945a01-ed47-494e-abc9-b300ddc15dcb):** The root cause was found and fixed: a buffer attach Neovim silently dropped (`nvim_buf_detach_event` on `:bdelete`, plain `:e`, `:e!`, autoread) that the bridge kept believing in, made permanent by a refcount leak in `IslandManager`. See the last section of `docs/markdown-island-fold-desync.md`. The rest of this file is the pre-fix state of knowledge and is kept for history.

## Symptom

In the markdown live-preview island (not the grid), typing or navigating stops landing correctly: what Leo types doesn't display right, the cursor seems to fight back to a wrong position, and this persists badly enough that live preview is not currently usable for real editing sessions. It correlates with documents that have many headings, but the cause is not confirmed to be fold- or heading-specific per se (see below).

`:GneovimResyncIsland` (an escape-hatch command, see `docs/markdown-island-fold-desync.md`) clears it visually for a moment but it comes back within seconds of continued editing. A buffer reload (`:edit!`) does not help either.

## What's confirmed and fixed so far

Two real, distinct bugs were found from live app logs (`~/Library/Logs/com.xell.gneovim/gneovim.log`) and fixed in `src/island-input-controller.js`'s `syncSelectionBeforeInput`:

1. **`ada8b86`** — a stale DOM caret read got re-honoured as a "genuine external move" (the same mechanism that lets Grammarly work) on every subsequent keystroke, dragging Neovim's real cursor backward in a feedback loop. Fixed by remembering the last such drag and refusing to repeat it once Neovim's cursor has since moved for a real reason.
2. **`010fc29`** — the fix above only blocked *repeats*. The *first* bogus drag still got through, because the hidden-widget guard (`isCursorHidden`) only checked Neovim's cursor *before* the drag, never the target position the drag was about to send it *to*. A document full of headings is full of `HeadingIconWidget` replace-decoration boundaries at column 0, and the DOM's own Selection kept landing on one — dragging Neovim's cursor onto a heading it never asked to visit. Fixed by also checking `isCursorHidden(target)`.

Both are real, tested (`island-input-controller.test.js`, 117/117 passing), and correct as far as they go. **Neither explains why the DOM caret misreads/freezes in the first place** — they only stop it from corrupting Neovim's actual cursor once it does.

## What's been ruled out

A same-day investigation (`docs/markdown-island-fold-desync.md`, look for "Trying to catch the DOM-node-recreation theory in the act") built a scripted headless-**WebKit** (Playwright, matching the real WKWebView, not Chromium) harness running the real, unmocked decoration pipeline against **real** `gnv_md_decor` payloads captured from a real embedded Neovim
editing Leo's real note. Tested and got **zero drift** for:

- Pure decoration-set rebuild (the theory: rebuilding `Decoration.set()` recreates widget DOM nodes and orphans the browser's Selection).
- Rebuild + real concurrent typing.
- Rebuild + typing + the cursor's own widget (`nvimCursorField`) redrawing every step, toggling insert/normal mode.

So: decoration churn alone, even combined with real typing and cursor widget updates, does not reproduce the freeze in isolation. The harness cannot reproduce one thing production has: the **real async Tauri IPC timing** — a real keydown → real `nvim_input` → an independently-arriving redraw echo, racing an independently-debounced `gnv_md_decor` push over a *separate* channel, with real (if small) latency on both. That's the leading remaining suspect, and it is not something a synchronous in-process replay can exercise.

One incidental, unconfirmed finding from the same harness: a freshly mounted island's *first* cursor placement took several update cycles to actually reach WebKit's real Selection, regardless of an explicit double-`requestAnimationFrame` wait. If the freeze tends to happen right after `:GneovimResyncIsland` (a fresh remount) rather than well into a session, that's a concrete, different, and probably easier lead.

## Recommended next step

Since synthetic reproduction is likely exhausted for now, the highest-value move is a **live diagnostic in the real app**: log whenever `document.getSelection()` (mapped through `posAtDOM`) disagrees with CodeMirror's own `state.selection`, with a timestamp and enough context (row/col on both sides, what the most recent `gnv_md_decor`/`gnv_cursor` events were) to reconstruct the actual race the next time it happens live. That gets a real trace instead of another guess. This was proposed but not yet built — a good place to start.

## Key files

- `src/island-input-controller.js` — `syncSelectionBeforeInput`, both fixes above live here.
- `src/main.js` — `Island.applyCursor` / `syncSelectionToCursor`, the cursor-echo path; `isCursorHidden`.
- `src-tauri/src/runtime/md_decor.lua` — the debounced display-bridge push; independent channel from buffer content sync.
- `docs/markdown-island-fold-desync.md` — full investigation history, most detailed account, several dated sections in chronological order.
- `docs/external-file-changes-and-the-island.md` — a related but distinct, already-fixed gap (autoread/`:checktime`/`:edit!` reloads weren't noticed by the island at all).

