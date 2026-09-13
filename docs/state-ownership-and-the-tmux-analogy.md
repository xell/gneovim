# State ownership and the tmux analogy

## Current architecture

Neovim owns durable editing state. The frontend owns an ephemeral projection of
that state.

The native Tauri shell creates one `nvim --embed --headless` child for every GUI
window. A macOS GUI tab is also a Tauri window grouped into an AppKit tab group,
so it has its own webview and its own Neovim process. A Neovim tabpage is
different: it lives inside one of those processes.

Each Tauri window has a generated label such as `gnv-1`. `AppState.windows` maps
that label to a `WindowBridge`, which holds both the RPC bridge and the child
process. Commands automatically carry the calling window, and `bridge_for`
selects its bridge by `window.label()`. Events include the same label in names
such as `gnv://gnv-1/grid`.

There is no WebSocket transport and Neovim has no `--listen` socket. RPC runs
over the child process's embedded stdio.

## What each side owns

Neovim is authoritative for:

1. Buffer text and modified state
2. Cursor and mode
3. Undo history
4. Windows, tabpages, folds, highlights, and options
5. Plugin state

The frontend temporarily mirrors enough state to render and route input:

1. Normalized multigrid cells and placements
2. Grid to Neovim window relationships
3. Window filetypes, buffers, preview flags, and gutters
4. The latest cursor, mode, and command-line notifications
5. CodeMirror island documents and decorations

`src/session-model.js` owns the window and cursor relationships. This shadow
state is not durable and is never a competing source of editing truth. Buffer
mutations made by external editors are immediately sent back to Neovim, and
Neovim's buffer notifications remain authoritative.

## Reload and lifetime

A webview reload discards DOM, renderer, session-model, and CodeMirror state. It
does not remove the corresponding `WindowBridge` from Tauri's `AppState`, so the
Neovim child and its buffers continue running. The new frontend registers its
listeners before requesting UI startup and replaying window metadata,
decorations, gutters, and options.

Closing a GUI window removes its `WindowBridge`. Dropping the stored child
handle terminates that window's Neovim process. Restarting the application also
ends all of its child processes. There is currently no daemon or session that
survives application exit.

## The tmux analogy

The useful part of the analogy is separation between an authoritative process
and a replaceable view:

| tmux | gneovim |
|---|---|
| tmux server owns sessions and running programs | Neovim child owns buffers, edits, cursor, and undo |
| terminal renders a session | webview renders one Neovim UI |
| replacing a terminal does not replace session state | reloading a webview does not replace its Neovim child |
| protocol carries state to the view | msgpack RPC and Tauri events carry state to the view |

The analogy has important limits:

1. A tmux server is a standalone daemon. Here Neovim is owned by the Tauri
   application.
2. Multiple terminals can attach to one tmux session. Here every GUI window or
   macOS GUI tab has its own Neovim process.
3. tmux normally uses a socket. Here Neovim uses embedded stdio.
4. The frontend is not stateless. It has substantial projection state, but none
   of that state is authoritative for the editing session.

## Possible persistent sessions

A future design could run Neovim independently with `--listen` and have GUI
windows connect to its socket. That would permit sessions to survive application
restarts and could permit more than one view to share a process. It would be a
different process-lifetime and routing model, not a description of the current
implementation.
