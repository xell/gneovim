# External file changes and the markdown island

Leo's question (2026-09-15): with `autoread` on and some autocmds calling
`:checktime` (on `FocusGained`, presumably `CursorHold`, etc.), the grid
reflects an external tool's changes to a file perfectly. Does the live
markdown island know about that kind of change too — passively, or does it
need something active?

## Answer: no, not before this change

Verified with a headless `nvim -l` probe (not the live app) rather than
assumed:

- `:checktime` silently reloading a buffer after `autoread` detects an
  external change fires `BufReadPost` and `FileChangedShellPost`. It does
  **not** fire an `on_lines` event on a `nvim_buf_attach` listener, and it
  does **not** fire `TextChanged` / `TextChangedI` / `CursorHold`.
- A manual `:edit!` (force-reload, discard local state) behaves identically:
  fires `BufReadPost` only, no `on_lines`, no `TextChanged`.
- Not tested further: whatever external tools or workflows exist that
  *don't* go through `:checktime` / `:edit!` (e.g. a plugin calling
  `nvim_buf_set_lines` directly) still go through the ordinary edit path and
  are unaffected by any of this.

The grid works regardless, because it is not any of these channels: it is
Neovim's own `ext_multigrid` screen redraw, which repaints whenever the
buffer's displayed content changes for any reason at all, autoread reload
included. The island depends on two narrower channels that both go quiet for
this specific case:

1. **Content.** `Island.applyBufLines` (`src/main.js`) is driven entirely by
   `nvim_buf_attach`'s `on_lines`. If that never fires, the CodeMirror
   document keeps showing the pre-reload text forever, with nothing to tell
   it otherwise.
2. **Decorations.** `runtime/md_decor.lua`'s trigger set (`CursorMoved`,
   `TextChanged`, `CursorHold`, ...) doesn't include the two events an
   autoread reload actually fires, so folds/headings/highlights would also
   never refresh even if the content somehow had.

This is also the missing half of the fold-desync investigation
(`docs/markdown-island-fold-desync.md`): Leo's report that "even deleting
the buffer and rereading/reloading the file doesn't help" lines up exactly
with `:edit!` firing none of the events the island's content sync depends
on — reloading genuinely did nothing for the island's own document, on top
of the frozen-caret bug fixed separately in `ada8b86`.

## Fix

Reuses the `:GneovimResyncIsland` machinery
(`docs/markdown-island-fold-desync.md`) rather than inventing a second
mechanism, but scoped: a manual `:GneovimResyncIsland` still means "every
island, right now" (`win = 0`), while this automatic path means "just the
window whose buffer actually reloaded."

- `runtime/md_decor.lua`: a new autocmd on `BufReadPost` /
  `FileChangedShellPost` walks every window, and for any that both show the
  reloaded buffer and are a live-preview window (`preview_on`), sends
  `gnv_resync_island` with that window's id, then calls `schedule()` (covers
  decorations for every visible island, not just this one, which is fine —
  a decor recompute is cheap and the fingerprint cache in `push()` skips the
  work for anything whose content didn't actually change).
- `bridge.rs`: `BridgeEvent::ResyncIsland` now carries a window id; `0` (the
  manual command's payload) means every island, matching `MdPreview`'s
  existing "0 disabled" style sentinel convention in this file; a specific
  id means just that one.
- `src/island-manager.js`: `IslandManager.resyncWindow(win)` does the same
  detach-then-reattach-from-a-fresh-snapshot sequence `reconcile(true)`
  already does per window, but for exactly one island, so a reload in one
  buffer cannot flicker or disturb every other open markdown window.
- `src/main.js`'s `resync_island` listener branches on the payload: truthy
  window id → `resyncWindow(win)`; `0` → the existing global
  `reconcile(true)`.

Verified headless (`nvim -l`, patched `vim.rpcnotify` to capture calls):
both the `:checktime` autoread path and `:edit!` correctly send
`gnv_resync_island` with the reloading window's id. `:checktime` sends it
twice (`BufReadPost` and `FileChangedShellPost` both fire for that path) —
harmless, `resyncWindow` is idempotent and a resync is cheap by design, not
worth the extra bookkeeping to de-duplicate. `npm test`: 116/116 (added
`island-manager.test.js` coverage for the new scoped path).

Not yet verified against the live app with a real external tool and a real
`autoread` autocmd — the headless probe proves the Lua/bridge/JS wiring is
correct, not that Leo's own `autoread` autocmds trigger it end to end in
practice.
