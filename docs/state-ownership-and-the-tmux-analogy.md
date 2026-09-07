# State ownership, and the tmux analogy

## The question

> How does the buffer I load with `:e` survive a browser refresh (Cmd+R)?

## The answer

The browser keeps **zero durable state**. It survives refresh because the
thing that owns the buffer is not in the browser at all.

The `nvim --embed` process is a child of the Vite dev-server process. It is
spawned once (`vite.config.js`, `neovimBridge()` → `start()` → `spawn(nvimPath,
["--embed", "--headless", ...])`) and killed only in `stop()` (Vite shutdown /
`closeBundle` / SIGINT/SIGTERM). A browser refresh never touches it. Buffers,
edits, cursor, undo tree, which buffer is active — all live in memory in that
one nvim process.

### What Cmd+R actually does

1. Browser tears down the page → the WebSocket closes (server side: the client
   just drops out of `wss.clients`).
2. Vite re-serves `index.html` + `src/main.js`.
3. `main.js` runs `connect()` → opens a fresh WebSocket to `/nvim`.
4. Server's `wss.on("connection")` → `resetPayload()` reads the **current live
   state** of the still-running nvim:

   ```js
   currentBuf.lines
   nvim.eval('[line("."), charcol(".")]')
   nvim.eval("mode()")
   currentBuf.name
   ```

   → sends one `reset` message.
5. Client applies `reset`: full-document replace of CodeMirror + cursor +
   filename in the status bar.

The fresh page re-derives its entire view from nvim. It is the same
full-snapshot path used by `resync` and by the very first connect. The browser
is a stateless projection.

### Corollaries

- **Multiple tabs** share the one nvim; every tab gets the same `broadcast` /
  `reset`.
- **Unsaved edits survive refresh** — they are in the nvim buffer. This includes
  Grammarly fixes, because those are forwarded into the buffer via
  `nvim_buf_set_text`.
- **What does not survive:** restarting Vite itself (editing `vite.config.js`,
  Ctrl+C on `npm run dev`). That runs `stop()`, kills nvim, and a new one starts
  with the `INITIAL` scratch buffer. `-u NONE -i NONE` means no shada, so nothing
  persists to disk across nvim restarts anyway.
- No `localStorage`, no service worker. Pure "process = source of truth,
  reconnect = re-fetch".

## The tmux analogy

This is **not a loose analogy**. It is the same design, because Neovim was built
for it (unlike Vim). Neovim's `--embed` / remote-UI model is "headless core +
detachable clients": the core runs without any UI, and any number of UIs
(`nvim_ui_attach`) or RPC clients can attach and detach at will.

| tmux | here |
|---|---|
| `tmux` server (daemon) — holds sessions, panes, running programs, scrollback | `nvim --embed` process — holds buffers, edits, cursor, undo tree |
| terminal running `tmux attach` — stateless view | browser tab — stateless view |
| detach / close the terminal → server keeps running | Cmd+R → nvim keeps running |
| `tmux attach` again → back exactly where you were | reconnect → `reset` snapshot rebuilds the view |
| multiple terminals attached to one session (mirrored) | multiple tabs, all replaying the same broadcast events |
| unix socket | WebSocket |

The browser is just another UI client.

## Where the analogy breaks

tmux's server is a **true standalone daemon**: it outlives the terminal that
first spawned it, and dies only on `tmux kill-server` (or when its last session
ends).

Our nvim is a **child of the Vite dev-server**, so `stop()` kills it when you
Ctrl+C `npm run dev`. Browser refreshes survive; a Vite restart does not.

### How to close the gap (future)

Run nvim as its own persistent process:

```sh
nvim --headless --listen /tmp/gnv.sock
```

and have the bridge `attach({ socket: "/tmp/gnv.sock" })` instead of spawning it.
Then restarting Vite — or swapping the entire front-end — would not touch the
editing session. You would genuinely "re-attach" to the same nvim, exactly like
`tmux attach`. This is what `nvim --listen` / `--remote` is designed for.

Not needed yet; recorded here because it is the natural end state of this
architecture.

## Why this matters

Every capability of this project follows from the split:

- The renderer can be thrown away and rebuilt (CodeMirror today, something else
  tomorrow) without losing an editing session.
- Crash isolation: a front-end bug reloads to a clean view; the buffer is safe
  in nvim.
- Real Neovim, not an emulation — the browser never holds an editable document,
  it holds a *view* of one that nvim owns. (This is the load-bearing principle
  from `plans/Neovim GUIs 2026-09-06.md`: "Neovim is the source of truth, and
  the renderer is a paint surface fed exact, already-decided content.")
