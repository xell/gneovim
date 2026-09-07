//! Neovim buffer-sync bridge, Tauri-free so it stays testable.
//!
//! Connects to a spawned `nvim --embed` over stdio via `nvim-rs`, mirrors the
//! active buffer, forwards edits back, and reports cursor / mode / cmdline.
//! Outbound updates go on an `mpsc` channel as [`BridgeEvent`]; the Tauri layer
//! forwards those to the webview and calls the `Bridge` methods for the reverse
//! direction.

use std::sync::{
    atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
    Arc,
};
use std::time::Duration;

use async_trait::async_trait;
use nvim_rs::{
    compat::tokio::Compat, create::tokio as create, Buffer, Handler, Neovim, Value,
};
use serde::{Deserialize, Serialize};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc::UnboundedSender, Mutex};

pub type NWriter = Compat<ChildStdin>;
pub type Nvim = Neovim<NWriter>;

const INITIAL: &[&str] = &[
    "# hello from neovim",
    "",
    "This buffer lives in a real headless `nvim`, driven from Rust via nvim-rs.",
    "Keystrokes go to nvim_input(); nvim's changes stream back as minimal diffs.",
    "Edits made in CodeMirror (Grammarly, paste) are forwarded via nvim_buf_set_text.",
    "",
    "The bridge follows the active buffer, so `:e somefile` works.",
    "",
    "try:   i ... <Esc>    o    dd    u    :%s/hello/HELLO/g    :e /tmp/notes.md",
];

// Apply edit regions (already sorted bottom-up so earlier offsets stay valid).
const LUA_APPLY_EDIT: &str = r#"
  local regions = ...
  for _, r in ipairs(regions) do
    vim.api.nvim_buf_set_text(0, r.sr, r.sc, r.er, r.ec, r.repl)
  end
"#;

// ---------------------------------------------------------------------------
// Wire payloads
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
pub struct ResetPayload {
    pub lines: Vec<String>,
    pub row: i64,
    pub col: i64,
    pub mode: String,
    pub name: String,
}

#[derive(Clone, Serialize)]
pub struct LinesPayload {
    pub firstline: i64,
    pub lastline: i64,
    pub linedata: Vec<String>,
}

#[derive(Clone, Serialize)]
pub struct CursorPayload {
    pub row: i64,
    pub col: i64,
    pub mode: String,
}

#[derive(Clone, Serialize)]
pub struct CmdlinePayload {
    pub ctype: String,
    pub content: String,
    pub pos: i64,
}

pub enum BridgeEvent {
    Reset(ResetPayload),
    Lines(LinesPayload),
    Cursor(CursorPayload),
    Cmdline(CmdlinePayload),
    CmdlineHide,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Region {
    pub start_row: i64,
    pub start_col: i64,
    pub end_row: i64,
    pub end_col: i64,
    pub replacement: Vec<String>,
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Shared {
    tx: UnboundedSender<BridgeEvent>,
    /// > 0 while we apply a CM6-originated edit; its echo lines events are dropped.
    suppress: Arc<AtomicI64>,
    /// Drop the one full snapshot `nvim_buf_attach` sends; we send our own reset.
    skip_snapshot: Arc<AtomicBool>,
    /// Debounce generation for the BufEnter/WinEnter burst from one `:e`.
    buf_epoch: Arc<AtomicU64>,
}

struct BufState {
    buf: Buffer<NWriter>,
    id: i64,
}

// ---------------------------------------------------------------------------
// Notification handler
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct NvHandler {
    shared: Shared,
    bufstate: Arc<Mutex<Option<BufState>>>,
}

#[async_trait]
impl Handler for NvHandler {
    type Writer = NWriter;

    async fn handle_notify(&self, name: String, args: Vec<Value>, nvim: Nvim) {
        match name.as_str() {
            // [buf, changedtick, firstline, lastline, linedata, more]
            "nvim_buf_lines_event" => {
                let firstline = args.get(2).and_then(Value::as_i64).unwrap_or(0);
                let lastline = args.get(3).and_then(Value::as_i64).unwrap_or(-1);
                if firstline == 0
                    && lastline == -1
                    && self.shared.skip_snapshot.swap(false, Ordering::SeqCst)
                {
                    return;
                }
                if self.shared.suppress.load(Ordering::SeqCst) > 0 {
                    return;
                }
                let linedata = args
                    .get(4)
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .map(|v| v.as_str().unwrap_or("").to_string())
                            .collect()
                    })
                    .unwrap_or_default();
                let _ = self.shared.tx.send(BridgeEvent::Lines(LinesPayload {
                    firstline,
                    lastline,
                    linedata,
                }));
            }
            "gnv_cursor" => {
                let row = args.first().and_then(Value::as_i64).unwrap_or(0);
                let col = args.get(1).and_then(Value::as_i64).unwrap_or(0);
                let mode = args.get(2).and_then(Value::as_str).unwrap_or("n").to_string();
                let _ = self
                    .shared
                    .tx
                    .send(BridgeEvent::Cursor(CursorPayload { row, col, mode }));
            }
            "gnv_cmdline" => {
                let ctype = args.first().and_then(Value::as_str).unwrap_or(":").to_string();
                let content = args.get(1).and_then(Value::as_str).unwrap_or("").to_string();
                let pos = args.get(2).and_then(Value::as_i64).unwrap_or(1);
                let _ = self.shared.tx.send(BridgeEvent::Cmdline(CmdlinePayload {
                    ctype,
                    content,
                    pos,
                }));
            }
            "gnv_cmdline_hide" => {
                let _ = self.shared.tx.send(BridgeEvent::CmdlineHide);
            }
            "gnv_bufchanged" => {
                let this = self.clone();
                tokio::spawn(async move { this.sync_buffer(nvim).await });
            }
            _ => {}
        }
    }
}

impl NvHandler {
    async fn sync_buffer(&self, nvim: Nvim) {
        // Debounce: only the last event in a burst does the work.
        let epoch = self.shared.buf_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        tokio::time::sleep(Duration::from_millis(15)).await;
        if self.shared.buf_epoch.load(Ordering::SeqCst) != epoch {
            return;
        }

        let new_buf = match nvim.get_current_buf().await {
            Ok(b) => b,
            Err(_) => return,
        };
        let new_id = new_buf.get_number().await.unwrap_or(-1);

        {
            let mut st = self.bufstate.lock().await;
            if st.as_ref().map(|s| s.id) == Some(new_id) {
                return;
            }
            if let Some(old) = st.as_ref() {
                let _ = old.buf.detach().await;
            }
            self.shared.skip_snapshot.store(true, Ordering::SeqCst);
            let _ = new_buf.attach(true, vec![]).await;
            *st = Some(BufState {
                buf: new_buf,
                id: new_id,
            });
        }

        if let Ok(p) = build_reset(&nvim, &self.bufstate).await {
            let _ = self.shared.tx.send(BridgeEvent::Reset(p));
        }
    }
}

// ---------------------------------------------------------------------------
// Reset snapshot
// ---------------------------------------------------------------------------

async fn build_reset(
    nvim: &Nvim,
    bufstate: &Mutex<Option<BufState>>,
) -> Result<ResetPayload, String> {
    let buf = bufstate
        .lock()
        .await
        .as_ref()
        .map(|s| s.buf.clone())
        .ok_or("no current buffer")?;

    let lines = buf.get_lines(0, -1, false).await.map_err(err)?;
    let cur = nvim
        .eval("[line(\".\"), charcol(\".\")]")
        .await
        .map_err(err)?;
    let arr = cur.as_array().ok_or("cursor eval shape")?;
    let row = arr.first().and_then(Value::as_i64).unwrap_or(1) - 1;
    let col = arr.get(1).and_then(Value::as_i64).unwrap_or(1) - 1;
    let mode = nvim
        .eval("mode()")
        .await
        .map_err(err)?
        .as_str()
        .unwrap_or("n")
        .to_string();
    let name = buf.get_name().await.unwrap_or_default();

    Ok(ResetPayload {
        lines,
        row,
        col,
        mode,
        name,
    })
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// Locate the `nvim` binary. A bundled macOS app launches with a stripped
/// `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), so `Command::new("nvim")` alone is
/// not enough.
async fn find_nvim() -> String {
    // 1. explicit override
    if let Ok(p) = std::env::var("GNV_NVIM") {
        if !p.is_empty() {
            return p;
        }
    }
    // 2. common absolute install locations
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        "/opt/homebrew/bin/nvim".to_string(),
        "/usr/local/bin/nvim".to_string(),
        format!("{home}/.local/share/bob/nvim-bin/nvim"),
        format!("{home}/.local/bin/nvim"),
        "/opt/nvim/bin/nvim".to_string(),
        "/usr/bin/nvim".to_string(),
    ];
    for c in candidates {
        if std::path::Path::new(&c).is_file() {
            return c;
        }
    }
    // 3. ask a login shell, which sources the user's real PATH
    if let Ok(shell) = std::env::var("SHELL") {
        if let Ok(out) = Command::new(&shell)
            .args(["-lc", "command -v nvim"])
            .output()
            .await
        {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !p.is_empty() && std::path::Path::new(&p).is_file() {
                return p;
            }
        }
    }
    // 4. last resort
    "nvim".to_string()
}

// ---------------------------------------------------------------------------
// Public bridge
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct Bridge {
    nvim: Nvim,
    shared: Shared,
    bufstate: Arc<Mutex<Option<BufState>>>,
}

/// Spawn `nvim --embed` and wire the bridge. Returns the bridge plus the child
/// handle so the caller can keep it alive (and kill it) with the app.
pub async fn connect(tx: UnboundedSender<BridgeEvent>) -> Result<(Bridge, Child), String> {
    let bin = find_nvim().await;
    log::info!("using nvim at {bin}");
    let mut cmd = Command::new(&bin);
    cmd.args(["--embed", "--headless", "-n", "-u", "NONE", "-i", "NONE"])
        .kill_on_drop(true);

    let shared = Shared {
        tx,
        suppress: Arc::new(AtomicI64::new(0)),
        skip_snapshot: Arc::new(AtomicBool::new(false)),
        buf_epoch: Arc::new(AtomicU64::new(0)),
    };
    let bufstate: Arc<Mutex<Option<BufState>>> = Arc::new(Mutex::new(None));

    let handler = NvHandler {
        shared: shared.clone(),
        bufstate: bufstate.clone(),
    };

    let (nvim, _io, child) = create::new_child_cmd(&mut cmd, handler)
        .await
        .map_err(|e| format!("spawn nvim ({bin}): {e}"))?;

    let buf = nvim.get_current_buf().await.map_err(err)?;
    let id = buf.get_number().await.map_err(err)?;

    // Seed the welcome text only into a genuinely fresh session.
    let bufs = nvim.list_bufs().await.map_err(err)?;
    let name0 = buf.get_name().await.unwrap_or_default();
    let lines0 = buf.get_lines(0, -1, false).await.map_err(err)?;
    if bufs.len() == 1 && name0.is_empty() && lines0 == [""] {
        buf.set_lines(
            0,
            -1,
            false,
            INITIAL.iter().map(|s| s.to_string()).collect(),
        )
        .await
        .map_err(err)?;
        nvim.command("setlocal buftype=nofile noswapfile")
            .await
            .map_err(err)?;
    }

    // Autocmds in one augroup, targeted at our channel, so a reused nvim does
    // not accumulate duplicates.
    let api = nvim.get_api_info().await.map_err(err)?;
    let chan = api.first().and_then(Value::as_i64).ok_or("no channel id")?;
    nvim.command("augroup gnv | autocmd! | augroup END")
        .await
        .map_err(err)?;
    for spec in [
        format!(
            "autocmd gnv CursorMoved,CursorMovedI,ModeChanged,TextChanged,TextChangedI * \
             call rpcnotify({chan}, 'gnv_cursor', line('.') - 1, charcol('.') - 1, mode())"
        ),
        format!(
            "autocmd gnv BufEnter,BufWinEnter,WinEnter * call rpcnotify({chan}, 'gnv_bufchanged')"
        ),
        format!(
            "autocmd gnv CmdlineEnter,CmdlineChanged * \
             call rpcnotify({chan}, 'gnv_cmdline', getcmdtype(), getcmdline(), getcmdpos())"
        ),
        format!("autocmd gnv CmdlineLeave * call rpcnotify({chan}, 'gnv_cmdline_hide')"),
    ] {
        nvim.command(&spec).await.map_err(err)?;
    }

    *bufstate.lock().await = Some(BufState {
        buf: buf.clone(),
        id,
    });
    shared.skip_snapshot.store(true, Ordering::SeqCst);
    buf.attach(true, vec![]).await.map_err(err)?;

    Ok((
        Bridge {
            nvim,
            shared,
            bufstate,
        },
        child,
    ))
}

impl Bridge {
    pub async fn input(&self, keys: &str) -> Result<(), String> {
        self.nvim.input(keys).await.map(|_| ()).map_err(err)
    }

    pub async fn cursor_set(&self, row: i64, col: i64) -> Result<(), String> {
        let win = self.nvim.get_current_win().await.map_err(err)?;
        win.set_cursor((row + 1, col)).await.map_err(err)
    }

    pub async fn edit(&self, regions: Vec<Region>) -> Result<(), String> {
        let lua_regions: Vec<Value> = regions
            .iter()
            .map(|r| {
                Value::Map(vec![
                    (Value::from("sr"), Value::from(r.start_row)),
                    (Value::from("sc"), Value::from(r.start_col)),
                    (Value::from("er"), Value::from(r.end_row)),
                    (Value::from("ec"), Value::from(r.end_col)),
                    (
                        Value::from("repl"),
                        Value::Array(
                            r.replacement.iter().map(|s| Value::from(s.as_str())).collect(),
                        ),
                    ),
                ])
            })
            .collect();

        self.shared.suppress.fetch_add(1, Ordering::SeqCst);
        let res = self
            .nvim
            .exec_lua(LUA_APPLY_EDIT, vec![Value::Array(lua_regions)])
            .await;
        // Let trailing lines events for this edit drain, then reopen.
        let suppress = self.shared.suppress.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(3)).await;
            suppress.fetch_sub(1, Ordering::SeqCst);
        });
        res.map(|_| ()).map_err(err)
    }

    pub async fn reset(&self) -> Result<ResetPayload, String> {
        build_reset(&self.nvim, &self.bufstate).await
    }

    /// `:edit` a file path, splitting nothing on spaces.
    pub async fn open_file(&self, path: &str) -> Result<(), String> {
        self.nvim
            .exec_lua(
                "vim.cmd({ cmd = 'edit', args = { (...) } })",
                vec![Value::from(path)],
            )
            .await
            .map(|_| ())
            .map_err(err)
    }
}
