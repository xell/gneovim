# GUI window model and the nvim process

This is the target shape of the app, independent of which wrapper (SwiftUI, Tauri, Electron) ends up hosting it. Terminology uses `gui-` prefixes to avoid collisions with Neovim's own tabpages and windows.

## The invariant

**One gui-window has one dedicated headless nvim, reached over one socket, rendered by one webview.**

- A `gui-window` is a macOS window (`NSWindow`).
- A `gui-tab` is a merged tab inside a tabbed window frame. macOS window tabbing makes every tab its own `NSWindow` in a tab group, so a gui-tab is the same unit as a gui-window: its own nvim, its own socket, its own webview.
- Merging or unmerging windows into a tabbed frame is pure AppKit window grouping. It never shares, merges, or moves nvims.
- Creating a new gui-window (or gui-tab) creates a new headless nvim.

So the native shell manages N `NSWindow`s, each with a `WKWebView` (or Chromium view) pointed at its own `--listen` socket, each with its own nvim. Tabbing comes free once every tab is a real window.

## Inside a gui-window

Exactly one nvim, rendered whole. Its `nvim-tabs` (tabpages) and `nvim-windows` (the splits inside a tabpage) stay nvim's to own. The app renders them; it does not substitute AppKit tabs or split views for them.

That multi pane rendering is built (milestone 2): the `ext_multigrid` grid renderer draws every window verbatim, with one CodeMirror island laid over each `filetype=markdown` window. Splits, floats, and tabpages all fall out of the grid stream. See [multigrid-renderer.md](multigrid-renderer.md).

## Who provisions nvim

The native shell spawns `nvim --headless --listen <sock>` per gui-window and hands the socket path to that window's webview (query param, injected config, or IPC). The webview's bridge then only does `attach({ socket })`; it never spawns.

In dev, the Vite plugin (`vite.config.js`, `provisionNvim`) plays that shell role, with **one shared socket for the whole dev server** (`$TMPDIR/gnv.sock`). Every browser tab in dev is a view of that one nvim. The real per gui-window split happens in the shell.

## Lifetime

**One rule: nvim is a child of its host and dies when the host dies gracefully.**

- Prod: the host is the per gui-window shell context. Close the gui-window or quit the app, its nvim goes. This falls out of process tree teardown for free.
- Dev: the host is the Vite dev server. A graceful stop (Ctrl+C, SIGINT, SIGTERM, a `vite.config.js` edit) kills the nvim it spawned.

The webview is never nvim's parent in any wrapper, so a webview reload or crash never kills nvim. That is the tmux style property (detach and reattach the view, the session lives), and it needs no special handling.

### Unsaved-changes guard

Because `nvim` is `kill_on_drop`, a bare Cmd+W / Cmd+Q would SIGKILL it and leave swap files behind. So `WindowEvent::CloseRequested` (Cmd+W) and `RunEvent::ExitRequested` (Cmd+Q) are intercepted: the guard asks each window's nvim `unsaved_blockers()` (a Lua scan for modified file buffers, `E37`, and `:terminal` buffers with a live job, `E947`). If a window is clean it is quit with `:qall` so shada and `VimLeave` run, then destroyed. If anything blocks, a native `NSAlert` (`lib.rs::warn_unsaved`) offers Cancel / (for Cmd+Q) Review, which focuses the first offending window / Discard, which runs `:qall!`. The `QUITTING` flag lets the guard's own `app.exit(0)` through without re-entering.

### Dev only: crash recovery

If the dev server is killed ungracefully (`kill -9`, a hard crash), `stop()` cannot run, so nvim is orphaned and keeps listening on the socket. The next `npm run dev` probes the socket, finds it alive, and **attaches instead of spawning**, so the editing session survives the crash. A nvim reused this way is no longer a child of anything, so it will not be killed by a later graceful stop; it lingers until `npm run nvim:stop` (or `:qa`).

### Dev only: a deliberately persistent nvim

Set `GNV_NVIM_SOCK=/path/to/sock` and run `nvim --headless --listen /path/to/sock` yourself. The plugin attaches to it and never spawns or kills it. Useful when iterating on the bridge, since Vite restarts no longer touch the session.

Session restore across a full app restart in prod is a future feature. It would need orphan reaping and is not planned yet.

## Files opened from outside (Open with, drag to dock)

Default: a new gui-window, a new nvim, launched as `nvim --headless --listen <sock> <file>`. Opening into an existing gui-window would be a menu choice added later.

## What this does not change

The decoupling is transport only. The browser client (`src/main.js`) still talks to the bridge over the `/nvim` WebSocket and cannot tell whether the bridge reached nvim over stdio or a socket. Buffer-sync, cursor, cmdline mirror, active buffer following: all unchanged. See `docs/state-ownership-and-the-tmux-analogy.md` for the state ownership model this builds on.
