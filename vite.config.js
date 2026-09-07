import { spawn } from "node:child_process";
import { defineConfig } from "vite";
import { WebSocketServer } from "ws";
import { attach, findNvim } from "neovim";

const WS_PATH = "/nvim";

const INITIAL = [
  "# hello from neovim",
  "",
  "This buffer lives in a real `nvim --embed` process.",
  "Keystrokes go to nvim_input(); nvim's changes stream back as minimal diffs.",
  "Edits made in CodeMirror (Grammarly, paste) are forwarded via nvim_buf_set_text.",
  "",
  "The bridge follows the active buffer, so `:e somefile` works:",
  "whatever buffer is in the current window is what you see here.",
  "",
  "try:   i ... <Esc>    o    dd    u    :%s/hello/HELLO/g    :e /tmp/notes.md",
];

// Apply edit regions (already sorted bottom-up so earlier offsets stay valid).
const LUA_APPLY_EDIT = `
  local regions = ...
  for _, r in ipairs(regions) do
    vim.api.nvim_buf_set_text(0, r.sr, r.sc, r.er, r.ec, r.repl)
  end
`;

/**
 * Buffer-sync step 3 + active-buffer-following. One headless `nvim --embed`.
 *  - the buffer in the current window  -> minimal CM6 diffs (rebased on switch)
 *  - nvim cursor / mode                -> CM6 selection + decoration
 *  - CM6 edits                         -> nvim_buf_set_text (echo-suppressed)
 *  - CM6 clicks / keys                 -> nvim_win_set_cursor / nvim_input
 */
function neovimBridge() {
  let proc;
  let wss;

  async function start(server) {
    const log = server.config.logger;

    const { matches } = findNvim({ minVersion: "0.9.0" });
    const nvimPath = process.env.GNV_NVIM || matches[0]?.path;
    if (!nvimPath) {
      log.error("[neovim-bridge] no usable nvim found on PATH");
      return;
    }
    log.info(`[neovim-bridge] nvim: ${nvimPath}`);

    proc = spawn(
      nvimPath,
      ["--embed", "--headless", "-n", "-u", "NONE", "-i", "NONE"],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    proc.on("exit", (c, s) => log.warn(`[neovim-bridge] nvim exited: ${c} ${s}`));

    const nvim = attach({ proc });

    // ---- buffer tracking -----------------------------------------------------
    let currentBuf = null;
    let currentKey = null;
    let skipNextSnapshot = false; // the full snapshot nvim_buf_attach sends
    let suppressLines = 0; // window while we apply a CM6-originated edit

    const onLines = (_b, _tick, firstline, lastline, linedata) => {
      if (firstline === 0 && lastline === -1 && skipNextSnapshot) {
        skipNextSnapshot = false;
        return;
      }
      if (suppressLines > 0) return;
      broadcast({ type: "lines", firstline, lastline, linedata });
    };

    const bindBuffer = (buf) => {
      if (currentBuf && currentBuf !== buf) {
        try {
          currentBuf.unlisten("lines", onLines);
        } catch {}
      }
      currentBuf = buf;
      currentKey = String(buf.data);
      skipNextSnapshot = true;
      buf.listen("lines", onLines);
    };

    let bufSyncPending = false;
    const scheduleBufSync = () => {
      if (bufSyncPending) return;
      bufSyncPending = true;
      setTimeout(async () => {
        bufSyncPending = false;
        try {
          const buf = await nvim.buffer;
          if (String(buf.data) === currentKey) return;
          bindBuffer(buf);
          await sendResetAll();
        } catch (e) {
          log.error(`[neovim-bridge] buffer switch: ${e.message}`);
        }
      }, 15); // coalesce the BufEnter/BufWinEnter/WinEnter burst from one :e
    };

    // ---- socket plumbing ----------------------------------------------------
    wss = new WebSocketServer({ noServer: true });
    wss.on("error", (e) => log.error(`[neovim-bridge] ws error: ${e.message}`));

    const broadcast = (obj) => {
      const s = JSON.stringify(obj);
      for (const c of wss.clients) {
        if (c.readyState !== 1) continue;
        if (c.gnvReady === false) c.gnvQueue.push(s);
        else c.send(s);
      }
    };

    const resetPayload = async () => {
      const [lines, cur, mode, name] = await Promise.all([
        currentBuf.lines,
        nvim.eval('[line("."), charcol(".")]'),
        nvim.eval("mode()"),
        currentBuf.name.catch(() => ""),
      ]);
      return {
        type: "reset",
        lines,
        row: cur[0] - 1,
        col: cur[1] - 1,
        mode,
        name,
      };
    };

    const sendResetAll = async () => {
      const s = JSON.stringify(await resetPayload());
      for (const c of wss.clients) {
        if (c.readyState !== 1) continue;
        c.gnvReady = true;
        c.gnvQueue = [];
        c.send(s);
      }
    };

    // ---- nvim setup -------------------------------------------------------------
    bindBuffer(await nvim.buffer);
    await currentBuf.setLines(INITIAL, { start: 0, end: -1, strictIndexing: false });
    await nvim.command("setlocal buftype=nofile noswapfile");
    await nvim.command(
      "autocmd CursorMoved,CursorMovedI,ModeChanged,TextChanged,TextChangedI * " +
        'call rpcnotify(0, "gnv_cursor", line(".") - 1, charcol(".") - 1, mode())',
    );
    await nvim.command(
      'autocmd BufEnter,BufWinEnter,WinEnter * call rpcnotify(0, "gnv_bufchanged")',
    );
    await nvim.command(
      "autocmd CmdlineEnter,CmdlineChanged * " +
        'call rpcnotify(0, "gnv_cmdline", getcmdtype(), getcmdline(), getcmdpos())',
    );
    await nvim.command(
      'autocmd CmdlineLeave * call rpcnotify(0, "gnv_cmdline_hide")',
    );

    nvim.on("notification", (method, args) => {
      if (method === "gnv_cursor") {
        const [row, col, mode] = args;
        broadcast({ type: "cursor", row, col, mode });
      } else if (method === "gnv_bufchanged") {
        scheduleBufSync();
      } else if (method === "gnv_cmdline") {
        const [ctype, content, pos] = args;
        broadcast({ type: "cmdline", ctype, content, pos });
      } else if (method === "gnv_cmdline_hide") {
        broadcast({ type: "cmdline_hide" });
      }
    });

    wss.on("connection", (ws) => {
      ws.gnvReady = false;
      ws.gnvQueue = [];
      resetPayload()
        .then((p) => {
          ws.send(JSON.stringify(p));
          ws.gnvReady = true;
          for (const s of ws.gnvQueue) ws.send(s);
          ws.gnvQueue = [];
        })
        .catch((e) => log.error(`[neovim-bridge] reset: ${e?.stack || e}`));

      ws.on("message", async (data) => {
        let msg;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        try {
          if (msg.type === "input" && typeof msg.keys === "string") {
            nvim.input(msg.keys);
          } else if (msg.type === "cursor-set") {
            await nvim.request("nvim_win_set_cursor", [0, [msg.row + 1, msg.col]]);
          } else if (msg.type === "edit" && Array.isArray(msg.regions)) {
            const regions = msg.regions.map((r) => ({
              sr: r.startRow,
              sc: r.startCol,
              er: r.endRow,
              ec: r.endCol,
              repl: r.replacement,
            }));
            suppressLines++;
            try {
              await nvim.lua(LUA_APPLY_EDIT, [regions]);
            } finally {
              setTimeout(() => {
                suppressLines--;
              }, 0);
            }
          } else if (msg.type === "resync") {
            const p = await resetPayload();
            ws.send(JSON.stringify(p));
          }
        } catch (e) {
          log.error(`[neovim-bridge] ${msg.type} failed: ${e.message}`);
          try {
            ws.send(JSON.stringify(await resetPayload()));
          } catch {}
        }
      });
    });

    if (!server.httpServer) {
      log.error("[neovim-bridge] no server.httpServer — cannot bind WebSocket");
      return;
    }
    server.httpServer.on("upgrade", (req, socket, head) => {
      let pathname;
      try {
        pathname = new URL(req.url, "http://localhost").pathname;
      } catch {
        return;
      }
      if (pathname !== WS_PATH) return; // leave HMR upgrades to Vite
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });

    log.info(`[neovim-bridge] ready on ${WS_PATH}`);
  }

  function stop() {
    try {
      wss?.close();
    } catch {}
    try {
      proc?.kill();
    } catch {}
    wss = undefined;
    proc = undefined;
  }

  return {
    name: "neovim-bridge",
    configureServer(server) {
      start(server).catch((e) => {
        server.config.logger.error(`[neovim-bridge] failed: ${e?.stack || e}`);
        stop();
      });
      server.httpServer?.once("close", stop);
    },
    closeBundle: stop,
  };
}

export default defineConfig({
  plugins: [neovimBridge()],
  // CodeMirror breaks if @codemirror/state or /view load as two instances.
  resolve: { dedupe: ["@codemirror/state", "@codemirror/view"] },
});
