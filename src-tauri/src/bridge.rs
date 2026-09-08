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
    compat::tokio::Compat, create::tokio as create, Buffer, Handler, Neovim,
    UiAttachOptions, Value,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc::UnboundedSender, Mutex};

pub type NWriter = Compat<ChildStdin>;
pub type Nvim = Neovim<NWriter>;

// Apply edit regions to a specific buffer (regions already sorted bottom-up so
// earlier offsets stay valid). The island buffer is not always the current one.
const LUA_APPLY_EDIT: &str = r#"
  local bufnr, regions = ...
  for _, r in ipairs(regions) do
    vim.api.nvim_buf_set_text(bufnr, r.sr, r.sc, r.er, r.ec, r.repl)
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
    /// One flushed frame of normalized grid ops (spike: multigrid renderer).
    Grid(Vec<Json>),
    /// A window's filetype, so the client can pick which grid is the CM island.
    WinFt { win: i64, buf: i64, ft: String },
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
    /// Grid ops accumulated since the last `flush` (spike multigrid renderer).
    grid_batch: Arc<std::sync::Mutex<Vec<Json>>>,
    /// Set once `ui_attach` has run, so a webview reload does not attach twice.
    ui_attached: Arc<AtomicBool>,
}

/// Decode a Neovim ext handle (window/buffer/tabpage) to its integer id.
fn ext_id(v: &Value) -> Option<i64> {
    if let Value::Ext(_, bytes) = v {
        rmpv::decode::read_value(&mut bytes.as_slice())
            .ok()
            .and_then(|x| x.as_i64())
    } else {
        v.as_i64()
    }
}

fn jcell(v: &Value) -> Json {
    // grid_line cell: [text, hl_id?, repeat?]
    let a = v.as_array().map(|x| x.as_slice()).unwrap_or(&[]);
    json!([
        a.first().and_then(Value::as_str).unwrap_or(""),
        a.get(1).and_then(Value::as_i64),
        a.get(2).and_then(Value::as_i64),
    ])
}

fn attr_map(v: &Value) -> Json {
    let mut o = serde_json::Map::new();
    if let Some(m) = v.as_map() {
        for (k, val) in m {
            let Some(k) = k.as_str() else { continue };
            let jv = match val {
                Value::Boolean(b) => json!(b),
                Value::Integer(_) => json!(val.as_i64()),
                Value::String(_) => json!(val.as_str()),
                _ => continue,
            };
            o.insert(k.to_string(), jv);
        }
    }
    Json::Object(o)
}

/// Translate one redraw call (event name already stripped) into a normalized op.
fn grid_op(ev: &str, a: &[Value]) -> Option<Json> {
    let i = |n: usize| a.get(n).and_then(Value::as_i64);
    Some(match ev {
        "grid_resize" => json!({"op":"resize","grid":i(0),"w":i(1),"h":i(2)}),
        "grid_clear" => json!({"op":"clear","grid":i(0)}),
        "grid_destroy" => json!({"op":"destroy","grid":i(0)}),
        "grid_cursor_goto" => json!({"op":"cursor","grid":i(0),"row":i(1),"col":i(2)}),
        "grid_scroll" => json!({"op":"scroll","grid":i(0),"top":i(1),"bot":i(2),
            "left":i(3),"right":i(4),"rows":i(5)}),
        "grid_line" => json!({"op":"line","grid":i(0),"row":i(1),"col":i(2),
            "cells": a.get(3).and_then(Value::as_array)
                .map(|c| c.iter().map(jcell).collect::<Vec<_>>()).unwrap_or_default(),
            "wrap": a.get(4).and_then(Value::as_bool)}),
        "win_pos" => json!({"op":"win_pos","grid":i(0),"win":a.get(1).and_then(ext_id),
            "srow":i(2),"scol":i(3),"w":i(4),"h":i(5)}),
        "win_float_pos" => json!({"op":"win_float","grid":i(0),"win":a.get(1).and_then(ext_id),
            "anchor":a.get(2).and_then(Value::as_str),"agrid":a.get(3).and_then(ext_id),
            "arow":a.get(4).and_then(Value::as_f64),"acol":a.get(5).and_then(Value::as_f64),
            "zindex":i(7)}),
        "win_hide" => json!({"op":"win_hide","grid":i(0)}),
        "win_close" => json!({"op":"win_close","grid":i(0)}),
        "msg_set_pos" => json!({"op":"msg_pos","grid":i(0),"row":i(1)}),
        "win_viewport" => json!({"op":"viewport","grid":i(0),"win":a.get(1).and_then(ext_id),
            "topline":i(2),"botline":i(3),"curline":i(4),"curcol":i(5),"linecount":i(6)}),
        "default_colors_set" => json!({"op":"colors","fg":i(0),"bg":i(1),"sp":i(2)}),
        "hl_attr_define" => json!({"op":"hl","id":i(0),"attr":attr_map(a.get(1).unwrap_or(&Value::Nil))}),
        "mode_change" => json!({"op":"mode","name":a.first().and_then(Value::as_str),"idx":i(1)}),
        "mode_info_set" => json!({"op":"mode_info",
            "enabled": a.first().and_then(Value::as_bool),
            "modes": a.get(1).and_then(Value::as_array)
                .map(|m| m.iter().map(attr_map).collect::<Vec<_>>()).unwrap_or_default()}),
        "flush" => json!({"op":"flush"}),
        _ => return None,
    })
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
            "gnv_winft" => {
                let win = args.first().and_then(Value::as_i64).unwrap_or(0);
                let buf = args.get(1).and_then(Value::as_i64).unwrap_or(0);
                let ft = args.get(2).and_then(Value::as_str).unwrap_or("").to_string();
                let _ = self.shared.tx.send(BridgeEvent::WinFt { win, buf, ft });
            }
            "redraw" => {
                let mut batch = self.shared.grid_batch.lock().unwrap();
                for group in &args {
                    let Some(arr) = group.as_array() else { continue };
                    let Some(ev) = arr.first().and_then(Value::as_str) else {
                        continue;
                    };
                    for call in &arr[1..] {
                        if let Some(op) =
                            grid_op(ev, call.as_array().map(|x| x.as_slice()).unwrap_or(&[]))
                        {
                            let is_flush = ev == "flush";
                            batch.push(op);
                            if is_flush {
                                let frame = std::mem::take(&mut *batch);
                                let _ = self.shared.tx.send(BridgeEvent::Grid(frame));
                            }
                        }
                    }
                }
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
    // 1. explicit env override (tests, CI, one-offs)
    if let Ok(p) = std::env::var("GNV_NVIM") {
        if !p.is_empty() {
            return p;
        }
    }
    // 2. config file: [neovim] path
    if let Some(p) = crate::config::get().neovim.path.as_deref() {
        let expanded = crate::config::expand_tilde(p);
        if std::path::Path::new(&expanded).is_file() {
            return expanded;
        }
        log::warn!(
            "config: neovim.path = {p:?} is not a file, falling back to auto-detection"
        );
    }
    // 3. common absolute install locations
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
    // 4. ask a login shell, which sources the user's real PATH
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
    // 5. last resort
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
        grid_batch: Arc::new(std::sync::Mutex::new(Vec::new())),
        ui_attached: Arc::new(AtomicBool::new(false)),
    };
    let bufstate: Arc<Mutex<Option<BufState>>> = Arc::new(Mutex::new(None));

    let handler = NvHandler {
        shared: shared.clone(),
        bufstate: bufstate.clone(),
    };

    let (nvim, _io, child) = create::new_child_cmd(&mut cmd, handler)
        .await
        .map_err(|e| format!("spawn nvim ({bin}): {e}"))?;

    // filetype detection on, and a light background for the prose surface. No
    // scene is staged here: the renderer draws whatever windows and buffers the
    // launch args (or the user) produce.
    nvim.command("filetype on").await.ok();
    // Neovim 0.10+ ships a built-in default colorscheme and defaults to
    // background=dark (Normal = NvimLightGrey on NvimDarkGrey). This is a prose
    // editor, so switch to the light palette. The client pins Normal to pure
    // black-on-white and renders the other hl groups (StatusLine, Visual, ...)
    // as sent.
    nvim.command("set background=light").await.ok();

    // Autocmds in one augroup, targeted at our channel.
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
            "autocmd gnv CmdlineEnter,CmdlineChanged * \
             call rpcnotify({chan}, 'gnv_cmdline', getcmdtype(), getcmdline(), getcmdpos())"
        ),
        format!("autocmd gnv CmdlineLeave * call rpcnotify({chan}, 'gnv_cmdline_hide')"),
        format!(
            "autocmd gnv BufWinEnter,FileType,WinEnter,WinNew,WinClosed * \
             call rpcnotify({chan}, 'gnv_winft', win_getid(), bufnr(), &filetype)"
        ),
    ] {
        nvim.command(&spec).await.map_err(err)?;
    }

    // Attach the current buffer for buffer-sync. The markdown island consumes
    // this stream; a session with no markdown window simply never shows it.
    // Dynamic per-window attach is a later step.
    let buf = nvim.get_current_buf().await.map_err(err)?;
    let bufnr = buf.get_number().await.map_err(err)?;
    *bufstate.lock().await = Some(BufState {
        buf: buf.clone(),
        id: bufnr,
    });
    shared.skip_snapshot.store(true, Ordering::SeqCst);
    buf.attach(true, vec![]).await.map_err(err)?;

    // NOTE: the UI is *not* attached here. `nvim_ui_attach` immediately emits a
    // full redraw, and the webview has not registered its `listen()` handlers
    // yet, so that first frame (every window's `grid_line`) would be lost with
    // no way to make nvim resend it. The client calls `ui_start` once its
    // listeners are live; see `Bridge::ui_start`.

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
        let bufnr = match self.bufstate.lock().await.as_ref() {
            Some(s) => s.id,
            None => return Ok(()), // no island attached, nothing to forward
        };
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
            .exec_lua(
                LUA_APPLY_EDIT,
                vec![Value::from(bufnr), Value::Array(lua_regions)],
            )
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

    /// Point the buffer-sync stream (the markdown island) at `win`'s buffer,
    /// detaching whatever was attached before. Returns a fresh snapshot for the
    /// client to load into the island's CodeMirror. `win` is a raw window id.
    pub async fn island_attach(&self, win: i64) -> Result<ResetPayload, String> {
        let buf_val = self
            .nvim
            .call("nvim_win_get_buf", vec![Value::from(win)])
            .await
            .map_err(err)?
            .map_err(|e| format!("nvim_win_get_buf: {e:?}"))?;
        let new_id = ext_id(&buf_val).ok_or("nvim_win_get_buf returned no id")?;

        let mut st = self.bufstate.lock().await;
        if st.as_ref().map(|s| s.id) != Some(new_id) {
            if let Some(old) = st.as_ref() {
                let _ = old.buf.detach().await;
            }
            let new_buf = Buffer::new(Value::from(new_id), self.nvim.clone());
            self.shared.skip_snapshot.store(true, Ordering::SeqCst);
            new_buf.attach(true, vec![]).await.map_err(err)?;
            *st = Some(BufState {
                buf: new_buf,
                id: new_id,
            });
        }
        drop(st);
        build_reset(&self.nvim, &self.bufstate).await
    }

    /// Detach the buffer-sync stream. Called when no markdown window is visible.
    pub async fn island_detach(&self) -> Result<(), String> {
        if let Some(old) = self.bufstate.lock().await.take() {
            let _ = old.buf.detach().await;
        }
        Ok(())
    }

    /// Attach the Neovim UI (multigrid) at `cols`x`rows`. Called by the client
    /// once its event listeners are live, so no redraw frame is lost. Safe to
    /// call again after a webview reload: it just resizes.
    pub async fn ui_start(&self, cols: i64, rows: i64) -> Result<(), String> {
        let cols = cols.max(20);
        let rows = rows.max(4);
        if self.shared.ui_attached.swap(true, Ordering::SeqCst) {
            return self.resize(cols, rows).await;
        }
        let mut opts = UiAttachOptions::new();
        opts.set_linegrid_external(true).set_multigrid_external(true);
        self.nvim
            .ui_attach(cols, rows, &opts)
            .await
            .map_err(err)
    }

    pub async fn resize(&self, cols: i64, rows: i64) -> Result<(), String> {
        let cols = cols.max(20);
        let rows = rows.max(4);
        self.nvim
            .call("nvim_ui_try_resize", vec![cols.into(), rows.into()])
            .await
            .map_err(err)?
            .map_err(|e| format!("{e:?}"))
            .map(|_| ())
    }

    /// Force nvim to repaint the whole screen (recovers a lost first frame).
    pub async fn redraw(&self) -> Result<(), String> {
        self.nvim.command("mode").await.map_err(err)
    }

    /// `[[winid, bufnr, filetype], ...]` for every window (winft replay).
    pub async fn win_fts(&self) -> Result<Vec<(i64, i64, String)>, String> {
        let v = self
            .nvim
            .eval(
                "map(getwininfo(), {_,w -> \
                 [w.winid, w.bufnr, getbufvar(w.bufnr, '&filetype')]})",
            )
            .await
            .map_err(err)?;
        Ok(v.as_array()
            .into_iter()
            .flatten()
            .filter_map(|row| {
                let r = row.as_array()?;
                Some((
                    r.first().and_then(Value::as_i64)?,
                    r.get(1).and_then(Value::as_i64)?,
                    r.get(2).and_then(Value::as_str).unwrap_or("").to_string(),
                ))
            })
            .collect())
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
