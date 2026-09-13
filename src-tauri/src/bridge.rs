//! Neovim buffer-sync bridge, Tauri-free so it stays testable.
//!
//! Connects to a spawned `nvim --embed` over stdio via `nvim-rs`, mirrors the
//! active buffer, forwards edits back, and reports cursor / mode / cmdline.
//! Outbound updates go on an `mpsc` channel as [`BridgeEvent`]; the Tauri layer
//! forwards those to the webview and calls the `Bridge` methods for the reverse
//! direction.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, MutexGuard, OnceLock,
};
use std::time::Duration;

use async_trait::async_trait;
use nvim_rs::{
    compat::tokio::Compat, create::tokio as create, Buffer, Handler, Neovim,
    UiAttachOptions, Value,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc::UnboundedSender, Mutex};

pub type NWriter = Compat<ChildStdin>;
pub type Nvim = Neovim<NWriter>;

// How long `connect()` waits for the whole post-spawn handshake (every
// nvim.command / exec_lua up to returning a usable Bridge) before giving up.
// Generous: a cold start with a heavy user config is normally well under a
// second. See the comment at its call site in `connect` for what this guards.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

// Apply edit regions to a specific buffer (regions already sorted bottom-up so
// earlier offsets stay valid). The island buffer is not always the current one.
const LUA_APPLY_EDIT: &str = r#"
  local bufnr, regions = ...
  local ticks = {}
  for _, r in ipairs(regions) do
    vim.api.nvim_buf_set_text(bufnr, r.sr, r.sc, r.er, r.ec, r.repl)
    ticks[#ticks + 1] = vim.api.nvim_buf_get_changedtick(bufnr)
  end
  return ticks
"#;

const LUA_ISLAND_SNAPSHOT: &str = r#"
  local win, expected_buf = ...
  return vim.api.nvim_win_call(win, function()
    local buf = vim.api.nvim_win_get_buf(win)
    if buf ~= expected_buf then
      error("window buffer changed during island attach")
    end
    return {
      vim.api.nvim_buf_get_lines(buf, 0, -1, false),
      vim.fn.line("."),
      vim.fn.col("."),
      vim.fn.mode(),
      vim.wo.scrolloff,
      vim.api.nvim_buf_get_name(buf),
    }
  end)
"#;

// ---------------------------------------------------------------------------
// Wire payloads
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
pub struct ResetPayload {
    /// bufnr this snapshot is for, so the client can route it to the right island
    pub buf: i64,
    pub lines: Vec<String>,
    pub row: i64,
    pub col: i64,
    pub mode: String,
    pub scrolloff: i64,
    pub name: String,
}

#[derive(Clone, Serialize)]
pub struct LinesPayload {
    /// bufnr this diff is for; several islands may share one buffer
    pub buf: i64,
    pub firstline: i64,
    pub lastline: i64,
    pub linedata: Vec<String>,
}

#[derive(Clone, Serialize)]
pub struct CursorPayload {
    /// Window that owns this cursor position. Cursor rows and columns are
    /// meaningful only in that window's buffer.
    pub win: i64,
    pub row: i64,
    pub col: i64,
    pub mode: String,
    pub scrolloff: i64,
}

#[derive(Clone, Serialize)]
pub struct CmdlinePayload {
    pub ctype: String,
    pub content: String,
    pub pos: i64,
}

#[derive(Clone, Serialize)]
pub struct WinFtPayload {
    pub win: i64,
    pub buf: i64,
    pub ft: String,
}

#[derive(Clone, Serialize)]
pub struct GuiOptPayload {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Serialize)]
pub struct MdPreviewPayload {
    pub win: i64,
    pub state: i64,
}

#[derive(Clone, Serialize)]
pub struct WinGutterPayload {
    pub win: i64,
    pub number: bool,
    pub relativenumber: bool,
    pub numberwidth: i64,
    pub signcolumn: String,
    pub foldcolumn: String,
}

#[derive(Clone, Serialize)]
pub struct MdDecorPayload {
    pub win: i64,
    pub json: String,
}

pub enum BridgeEvent {
    Reset(ResetPayload),
    Lines(LinesPayload),
    Cursor(CursorPayload),
    Cmdline(CmdlinePayload),
    CmdlineHide,
    /// One flushed frame of normalized grid ops for the multigrid renderer.
    Grid(Vec<Json>),
    /// A window's filetype, so the client can pick which grid is the CM island.
    WinFt(WinFtPayload),
    /// A GUI option changed (`guifont`, `linespace`, ...). No `ext_` event
    /// carries these; polled via an `OptionSet` autocmd.
    GuiOpt(GuiOptPayload),
    /// A window's markdown-live-preview flag changed. `state`: 1 preview island,
    /// 0 grid, -1 no longer a markdown window. From `runtime/md_preview.lua`.
    MdPreview(MdPreviewPayload),
    /// A markdown window's gutter options, so its island can mirror Neovim's
    /// number column. `signcolumn` / `foldcolumn` ride along for a later pass.
    /// From `runtime/md_preview.lua`.
    WinGutter(WinGutterPayload),
    /// Per-window display state for a markdown island (inline conceal now;
    /// highlights, folds, visual range later), as a JSON string.
    /// From `runtime/md_decor.lua`.
    MdDecor(MdDecorPayload),
    /// `:OpenInNewGneovimTab` / `_G.OpenInNewGneovimTab()`: open a new gui-tab
    /// with its own nvim. `paths` open one Neovim tabpage each; `content` (for a
    /// `[No Name]` buffer being moved) seeds the initial buffer's lines.
    /// From `runtime/open_in_new_tab.lua`.
    OpenNewTab {
        paths: Vec<String>,
        content: Option<Vec<String>>,
    },
    /// nvim's stdio closed (it exited or the connection dropped).
    Gone(String),
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

/// Files / text for a freshly spawned nvim to open. Threaded from the shell's
/// "new gui-window" path (`spawn_window`) into [`connect`].
#[derive(Default, Clone)]
pub struct OpenSpec {
    /// Paths to open, one Neovim tabpage each (`nvim -p`).
    pub paths: Vec<String>,
    /// Lines to seed the initial `[No Name]` buffer with (a moved unnamed
    /// buffer, from `:OpenInNewGneovimTab` with no args). Mutually exclusive
    /// with `paths` in practice.
    pub content: Option<Vec<String>>,
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct Shared {
    tx: UnboundedSender<BridgeEvent>,
    /// Cleared on the first send to a dropped frontend receiver.
    forwarding: Arc<AtomicBool>,
    /// Changedtick protocol for distinguishing CM6 edit echoes from independent
    /// Neovim edits without relying on scheduler timing.
    edit_sync: Arc<std::sync::Mutex<EditSync>>,
    /// Only one reverse edit establishes a pending changedtick range at a time.
    edit_lock: Arc<Mutex<()>>,
    /// Grid ops accumulated since the last `flush` (multigrid renderer).
    grid_batch: Arc<std::sync::Mutex<Vec<Json>>>,
    /// Set once `ui_attach` has run, so a webview reload does not attach twice.
    ui_attached: Arc<AtomicBool>,
}

impl Shared {
    fn send(&self, event: BridgeEvent) -> bool {
        if !self.forwarding.load(Ordering::Acquire) {
            return false;
        }
        if self.tx.send(event).is_err() {
            self.forwarding.store(false, Ordering::Release);
            return false;
        }
        true
    }
}

fn lock_recover<'a, T>(
    mutex: &'a std::sync::Mutex<T>,
    name: &str,
) -> MutexGuard<'a, T> {
    mutex.lock().unwrap_or_else(|poisoned| {
        log::error!("recovering poisoned {name} lock");
        poisoned.into_inner()
    })
}

#[derive(Default)]
struct EditSync {
    /// Lines notifications wait here while the matching edit request is in flight.
    pending: HashMap<i64, Vec<(i64, LinesPayload)>>,
    /// Exact changedticks produced by our own nvim_buf_set_text calls.
    suppress: HashMap<i64, HashSet<i64>>,
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
        "set_title" => json!({"op":"title","title":a.first().and_then(Value::as_str)}),
        "flush" => json!({"op":"flush"}),
        _ => return None,
    })
}

#[cfg(test)]
mod redraw_wire_tests {
    use super::*;

    #[test]
    fn ext_id_accepts_integer_and_msgpack_extension_handles() {
        assert_eq!(ext_id(&Value::from(42)), Some(42));

        let mut encoded = Vec::new();
        rmpv::encode::write_value(&mut encoded, &Value::from(73)).unwrap();
        assert_eq!(ext_id(&Value::Ext(0, encoded)), Some(73));
        assert_eq!(ext_id(&Value::Nil), None);
    }

    #[test]
    fn attr_map_keeps_only_supported_wire_values() {
        let attrs = Value::Map(vec![
            (Value::from("foreground"), Value::from(0x112233)),
            (Value::from("bold"), Value::from(true)),
            (Value::from("url"), Value::from("https://example.test")),
            (
                Value::from("unsupported"),
                Value::Array(vec![Value::from(1)]),
            ),
            (Value::from(5), Value::from("non-string key")),
        ]);

        assert_eq!(
            attr_map(&attrs),
            json!({
                "foreground": 0x112233,
                "bold": true,
                "url": "https://example.test"
            })
        );
    }

    #[test]
    fn grid_line_shape_and_cell_defaults_are_frozen() {
        let args = vec![
            Value::from(2),
            Value::from(4),
            Value::from(6),
            Value::Array(vec![
                Value::Array(vec![Value::from("a"), Value::from(9), Value::from(3)]),
                Value::Array(vec![Value::from("b")]),
            ]),
            Value::from(true),
        ];

        assert_eq!(
            grid_op("grid_line", &args),
            Some(json!({
                "op": "line",
                "grid": 2,
                "row": 4,
                "col": 6,
                "cells": [["a", 9, 3], ["b", null, null]],
                "wrap": true
            }))
        );
    }

    #[test]
    fn window_and_mode_shapes_are_frozen() {
        assert_eq!(
            grid_op(
                "win_pos",
                &[
                    Value::from(3),
                    Value::from(1000),
                    Value::from(1),
                    Value::from(2),
                    Value::from(80),
                    Value::from(24),
                ],
            ),
            Some(json!({
                "op": "win_pos",
                "grid": 3,
                "win": 1000,
                "srow": 1,
                "scol": 2,
                "w": 80,
                "h": 24
            }))
        );
        assert_eq!(
            grid_op("mode_change", &[Value::from("insert"), Value::from(1)]),
            Some(json!({"op": "mode", "name": "insert", "idx": 1}))
        );
        assert_eq!(grid_op("unknown", &[]), None);
    }

    #[test]
    fn typed_event_payload_shapes_are_frozen() {
        assert_eq!(
            serde_json::to_value(WinFtPayload {
                win: 1000,
                buf: 7,
                ft: "markdown".into(),
            })
            .unwrap(),
            json!({"win": 1000, "buf": 7, "ft": "markdown"})
        );
        assert_eq!(
            serde_json::to_value(WinGutterPayload {
                win: 1000,
                number: true,
                relativenumber: false,
                numberwidth: 4,
                signcolumn: "auto".into(),
                foldcolumn: "0".into(),
            })
            .unwrap(),
            json!({
                "win": 1000,
                "number": true,
                "relativenumber": false,
                "numberwidth": 4,
                "signcolumn": "auto",
                "foldcolumn": "0"
            })
        );
        assert_eq!(
            serde_json::to_value(MdDecorPayload {
                win: 1000,
                json: "{}".into(),
            })
            .unwrap(),
            json!({"win": 1000, "json": "{}"})
        );
    }

    #[test]
    fn poisoned_hot_path_lock_recovers_its_data() {
        let mutex = Arc::new(std::sync::Mutex::new(vec![1]));
        let poisoned = mutex.clone();
        let _ = std::thread::spawn(move || {
            let mut value = poisoned.lock().unwrap();
            value.push(2);
            panic!("poison the fixture");
        })
        .join();

        let mut recovered = lock_recover(&mutex, "test");
        recovered.push(3);
        assert_eq!(*recovered, vec![1, 2, 3]);
    }
}

struct BufState {
    buf: Buffer<NWriter>,
    /// how many islands are currently showing this buffer
    refs: u32,
}

/// bufnr -> attached buffer, shared by every island showing that buffer.
type Bufs = Arc<Mutex<HashMap<i64, BufState>>>;

// ---------------------------------------------------------------------------
// Notification handler
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct NvHandler {
    shared: Shared,
}

#[async_trait]
impl Handler for NvHandler {
    type Writer = NWriter;

    async fn handle_request(
        &self,
        name: String,
        _args: Vec<Value>,
        _nvim: Nvim,
    ) -> Result<Value, Value> {
        match name.as_str() {
            // g:clipboard paste callback: return [lines, regtype]
            "gnv_clip_get" => {
                let (lines, regtype) = clip_get();
                Ok(Value::Array(vec![
                    Value::Array(lines.into_iter().map(Value::from).collect()),
                    Value::from(regtype),
                ]))
            }
            _ => Err(Value::from(format!("unknown request: {name}"))),
        }
    }

    async fn handle_notify(&self, name: String, args: Vec<Value>, _nvim: Nvim) {
        match name.as_str() {
            // g:clipboard copy callback: [regname, lines, regtype]
            "gnv_clip_set" => {
                let lines = args
                    .get(1)
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let regtype = args.get(2).and_then(Value::as_str).unwrap_or("v");
                clip_set(&lines, regtype);
            }
            // [buf, changedtick, firstline, lastline, linedata, more]
            "nvim_buf_lines_event" => {
                let buf = args.first().and_then(ext_id).unwrap_or(-1);
                let changedtick = args.get(1).and_then(Value::as_i64).unwrap_or(-1);
                let firstline = args.get(2).and_then(Value::as_i64).unwrap_or(0);
                let lastline = args.get(3).and_then(Value::as_i64).unwrap_or(-1);
                let linedata = args
                    .get(4)
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .map(|v| v.as_str().unwrap_or("").to_string())
                            .collect()
                    })
                    .unwrap_or_default();
                let payload = LinesPayload {
                    buf,
                    firstline,
                    lastline,
                    linedata,
                };
                let mut sync = lock_recover(&self.shared.edit_sync, "edit sync");
                if let Some(pending) = sync.pending.get_mut(&buf) {
                    pending.push((changedtick, payload));
                    return;
                }
                if let Some(ticks) = sync.suppress.get_mut(&buf) {
                    if ticks.remove(&changedtick) {
                        if ticks.is_empty() {
                            sync.suppress.remove(&buf);
                        }
                        return;
                    }
                }
                drop(sync);
                self.shared.send(BridgeEvent::Lines(payload));
            }
            "gnv_cursor" => {
                let win = args.first().and_then(Value::as_i64).unwrap_or(0);
                let row = args.get(1).and_then(Value::as_i64).unwrap_or(0);
                let col = args.get(2).and_then(Value::as_i64).unwrap_or(0);
                let mode = args.get(3).and_then(Value::as_str).unwrap_or("n").to_string();
                let scrolloff = args.get(4).and_then(Value::as_i64).unwrap_or(0);
                self.shared.send(BridgeEvent::Cursor(CursorPayload {
                        win,
                        row,
                        col,
                        mode,
                        scrolloff,
                    }));
            }
            "gnv_cmdline" => {
                let ctype = args.first().and_then(Value::as_str).unwrap_or(":").to_string();
                let content = args.get(1).and_then(Value::as_str).unwrap_or("").to_string();
                let pos = args.get(2).and_then(Value::as_i64).unwrap_or(1);
                self.shared.send(BridgeEvent::Cmdline(CmdlinePayload {
                    ctype,
                    content,
                    pos,
                }));
            }
            "gnv_cmdline_hide" => {
                self.shared.send(BridgeEvent::CmdlineHide);
            }
            "gnv_winft" => {
                let win = args.first().and_then(Value::as_i64).unwrap_or(0);
                let buf = args.get(1).and_then(Value::as_i64).unwrap_or(0);
                let ft = args.get(2).and_then(Value::as_str).unwrap_or("").to_string();
                self.shared
                    .send(BridgeEvent::WinFt(WinFtPayload { win, buf, ft }));
            }
            "gnv_guiopt" => {
                let name = args.first().and_then(Value::as_str).unwrap_or("").to_string();
                let value = match args.get(1) {
                    Some(Value::String(s)) => s.as_str().unwrap_or("").to_string(),
                    Some(Value::Integer(n)) => n.to_string(),
                    _ => String::new(),
                };
                self.shared
                    .send(BridgeEvent::GuiOpt(GuiOptPayload { name, value }));
            }
            "gnv_md_preview" => {
                let win = args.first().and_then(Value::as_i64).unwrap_or(0);
                let state = args.get(1).and_then(Value::as_i64).unwrap_or(-1);
                self.shared
                    .send(BridgeEvent::MdPreview(MdPreviewPayload { win, state }));
            }
            "gnv_win_gutter" => {
                let win = args.first().and_then(Value::as_i64).unwrap_or(0);
                let (mut number, mut relativenumber) = (false, false);
                let mut numberwidth = 4;
                let mut signcolumn = String::from("auto");
                let mut foldcolumn = String::from("0");
                if let Some(map) = args.get(1).and_then(Value::as_map) {
                    for (k, v) in map {
                        match k.as_str() {
                            Some("number") => number = v.as_bool().unwrap_or(false),
                            Some("relativenumber") => {
                                relativenumber = v.as_bool().unwrap_or(false)
                            }
                            Some("numberwidth") => numberwidth = v.as_i64().unwrap_or(4),
                            Some("signcolumn") => {
                                signcolumn = v.as_str().unwrap_or("auto").to_string()
                            }
                            Some("foldcolumn") => {
                                foldcolumn = v.as_str().unwrap_or("0").to_string()
                            }
                            _ => {}
                        }
                    }
                }
                self.shared.send(BridgeEvent::WinGutter(WinGutterPayload {
                    win,
                    number,
                    relativenumber,
                    numberwidth,
                    signcolumn,
                    foldcolumn,
                }));
            }
            "gnv_md_decor" => {
                let win = args.first().and_then(Value::as_i64).unwrap_or(0);
                let json = args
                    .get(1)
                    .and_then(Value::as_str)
                    .unwrap_or("{}")
                    .to_string();
                self.shared
                    .send(BridgeEvent::MdDecor(MdDecorPayload { win, json }));
            }
            // [{ paths = [..]?, content = [..]? }]
            "gnv_open_new_tab" => {
                let field = |k: &str| {
                    args.first().and_then(Value::as_map).and_then(|m| {
                        m.iter()
                            .find(|(mk, _)| mk.as_str() == Some(k))
                            .map(|(_, v)| v)
                    })
                };
                let paths = field("paths")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
                let content = field("content").and_then(Value::as_array).map(|a| {
                    a.iter()
                        .map(|v| v.as_str().unwrap_or("").to_string())
                        .collect()
                });
                self.shared
                    .send(BridgeEvent::OpenNewTab { paths, content });
            }
            "redraw" => {
                let mut batch = lock_recover(&self.shared.grid_batch, "grid batch");
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
                                self.shared.send(BridgeEvent::Grid(frame));
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// Island snapshot
// ---------------------------------------------------------------------------

/// A fresh snapshot of `win`'s buffer for the client to load into an island's
/// CodeMirror. Cursor is read from `win` specifically (not the current window).
/// Columns are byte offsets, matching extmarks and `nvim_win_set_cursor`.
async fn island_snapshot(nvim: &Nvim, win: i64, id: i64) -> Result<ResetPayload, String> {
    let snapshot = nvim
        .exec_lua(
            LUA_ISLAND_SNAPSHOT,
            vec![Value::from(win), Value::from(id)],
        )
        .await
        .map_err(err)?;
    let fields = snapshot.as_array().ok_or("island snapshot lua shape")?;
    let lines = fields
        .first()
        .and_then(Value::as_array)
        .ok_or("island snapshot lines shape")?
        .iter()
        .map(|line| line.as_str().unwrap_or("").to_string())
        .collect();
    let row = fields.get(1).and_then(Value::as_i64).unwrap_or(1) - 1;
    let col = fields.get(2).and_then(Value::as_i64).unwrap_or(1) - 1;
    let mode = fields
        .get(3)
        .and_then(Value::as_str)
        .unwrap_or("n")
        .to_string();
    let scrolloff = fields.get(4).and_then(Value::as_i64).unwrap_or(0);
    let name = fields
        .get(5)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    Ok(ResetPayload {
        buf: id,
        lines,
        row,
        col,
        mode,
        scrolloff,
        name,
    })
}

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------------------------------------------------------------------------
// System clipboard, wired to nvim's `+` / `*` registers via a g:clipboard
// provider (set in connect). Both registers map to the macOS general pasteboard.
// ---------------------------------------------------------------------------

/// `[lines, regtype]` for a g:clipboard `paste` callback.
fn clip_get() -> (Vec<String>, &'static str) {
    let text = arboard::Clipboard::new()
        .and_then(|mut c| c.get_text())
        .unwrap_or_default();
    let regtype = if text.ends_with('\n') { "V" } else { "v" };
    let body = text.strip_suffix('\n').unwrap_or(&text);
    (body.split('\n').map(str::to_string).collect(), regtype)
}

/// Store a g:clipboard `copy` callback's `(lines, regtype)` on the pasteboard.
fn clip_set(lines: &[Value], regtype: &str) {
    let mut text = lines
        .iter()
        .map(|v| v.as_str().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");
    if regtype.starts_with('V') {
        text.push('\n');
    }
    let _ = arboard::Clipboard::new().and_then(|mut c| c.set_text(text));
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

/// A macOS app launched from Finder / Dock / Spotlight inherits a stripped
/// `launchd` environment: `PATH` is roughly `/usr/bin:/bin:/usr/sbin:/sbin` and
/// none of the user's shell startup files have run. The spawned nvim then can't
/// find LSP servers, formatters, telescope's `rg`/`fd`, node, etc., and reports
/// a `$PATH` unlike the one in a terminal.
///
/// Resolve the real login-shell environment once and return the variables to
/// overlay onto the nvim child. Cached for the life of the process. Set
/// `GNV_NO_SHELL_ENV` to skip. Skipped automatically when `PATH` already looks
/// like a normal interactive one (running from a terminal, e.g. `tauri dev`).
fn login_shell_env() -> &'static [(String, String)] {
    static ENV: OnceLock<Vec<(String, String)>> = OnceLock::new();
    ENV.get_or_init(|| {
        if !cfg!(target_os = "macos") || std::env::var_os("GNV_NO_SHELL_ENV").is_some() {
            return Vec::new();
        }
        // A stripped launchd PATH is only the system dirs; a real interactive
        // one has the user's home in it (~/.local/bin, ~/.cargo/bin, version
        // manager shims, ...) or a Homebrew prefix. If it already looks rich we
        // were launched from a terminal (e.g. `tauri dev`) and can skip.
        let path = std::env::var("PATH").unwrap_or_default();
        let home = std::env::var("HOME").unwrap_or_default();
        let already_rich =
            (!home.is_empty() && path.contains(&home)) || path.contains("/opt/homebrew/");
        if already_rich {
            return Vec::new();
        }

        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        // -i so shells that build PATH in .zshrc / .bashrc are covered; a NUL
        // sentinel so anything an rc file echoes to stdout is skipped; `env -0`
        // so values containing newlines survive. stdin is /dev/null so an
        // interactive shell with no tty hits EOF and exits instead of hanging.
        let out = std::process::Command::new(&shell)
            .args(["-ilc", "printf '\\0__GNV_ENV__\\0'; command env -0"])
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output();
        let stdout = match out {
            Ok(o) if o.status.success() => o.stdout,
            _ => {
                log::warn!("login-shell env probe failed; using inherited environment");
                return Vec::new();
            }
        };
        let text = String::from_utf8_lossy(&stdout);
        let body = match text.split_once("\0__GNV_ENV__\0") {
            Some((_, rest)) => rest,
            None => text.as_ref(),
        };
        let mut vars = Vec::new();
        for entry in body.split('\0') {
            let Some((k, v)) = entry.split_once('=') else {
                continue;
            };
            // never carry a nested-nvim marker or override nvim's own runtime
            // vars into the child
            if matches!(
                k,
                "NVIM" | "NVIM_LISTEN_ADDRESS" | "VIM" | "VIMRUNTIME" | "MYVIMRC" | "VIMINIT"
            ) {
                continue;
            }
            vars.push((k.to_string(), v.to_string()));
        }
        match vars.iter().find(|(k, _)| k == "PATH") {
            Some((_, p)) => log::info!("login-shell env: {} vars, PATH={p}", vars.len()),
            None => log::warn!("login-shell env: probe returned no PATH"),
        }
        vars
    })
}

// ---------------------------------------------------------------------------
// Public bridge
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct Bridge {
    nvim: Nvim,
    shared: Shared,
    bufs: Bufs,
}

/// Spawn `nvim --embed` and wire the bridge. Returns the bridge plus the child
/// handle so the caller can keep it alive (and kill it) with the app.
pub async fn connect(
    tx: UnboundedSender<BridgeEvent>,
    open: OpenSpec,
) -> Result<(Bridge, Child), String> {
    let bin = find_nvim().await;
    let nv = &crate::config::get().neovim;
    let init_args = nv.init_args();
    let shada_args = nv.shada_args();
    let extra_args = nv.extra_args();
    log::info!(
        "using nvim at {bin} (init: {init_args:?}, shada: {shada_args:?}, extra: {extra_args:?})"
    );
    // Resolve the user's login-shell environment once (off the async worker,
    // since it may spawn a shell) so nvim sees a terminal-equivalent $PATH.
    let extra_env = tokio::task::spawn_blocking(login_shell_env)
        .await
        .unwrap_or(&[]);
    let mut cmd = Command::new(&bin);
    cmd.args(["--embed", "--headless"])
        .args(&init_args)
        .args(&shada_args)
        .args(&extra_args)
        .kill_on_drop(true)
        // Inherited by default, i.e. invisible: capture it instead so a stuck
        // startup (see CONNECT_TIMEOUT below) can show the user why.
        .stderr(std::process::Stdio::piped());
    cmd.envs(extra_env.iter().map(|(k, v)| (k, v)));
    // `:OpenInNewGneovimTab file1 file2` -> one tabpage per file in this nvim.
    if !open.paths.is_empty() {
        cmd.arg("-p").args(&open.paths);
    }

    let shared = Shared {
        tx,
        forwarding: Arc::new(AtomicBool::new(true)),
        edit_sync: Arc::new(std::sync::Mutex::new(EditSync::default())),
        edit_lock: Arc::new(Mutex::new(())),
        grid_batch: Arc::new(std::sync::Mutex::new(Vec::new())),
        ui_attached: Arc::new(AtomicBool::new(false)),
    };
    let bufs: Bufs = Arc::new(Mutex::new(HashMap::new()));

    let handler = NvHandler {
        shared: shared.clone(),
    };

    let (nvim, io, mut child) = create::new_child_cmd(&mut cmd, handler)
        .await
        .map_err(|e| format!("spawn nvim ({bin}): {e}"))?;

    // The io loop future resolves when nvim's stdio closes, i.e. nvim exited.
    {
        let tx = shared.tx.clone();
        tokio::spawn(async move {
            let reason = match io.await {
                Ok(Ok(())) => "Neovim exited".to_string(),
                Ok(Err(e)) => format!("Neovim connection lost: {e}"),
                Err(e) => format!("Neovim io task failed: {e}"),
            };
            let _ = tx.send(BridgeEvent::Gone(reason));
        });
    }

    // A terminal nvim that hits a startup error (a lazy.nvim plugin missing a
    // dependency, say) prints it and sits at a "Press ENTER" prompt; a human
    // clears it and nvim finishes starting, error and all. This headless embed
    // has no terminal to show that prompt on and no one to answer it, so nvim
    // just sits there, and every request below would otherwise hang forever
    // with nothing in the log to say why. Capture stderr (inherited, so
    // invisible, by default) for CONNECT_TIMEOUT to quote back if that happens;
    // kept for the process's whole life, not just startup, in case a later
    // crash needs the same context.
    let stderr_tail: Arc<std::sync::Mutex<VecDeque<String>>> =
        Arc::new(std::sync::Mutex::new(VecDeque::new()));
    if let Some(stderr) = child.stderr.take() {
        let tail = stderr_tail.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut buf = tail.lock().unwrap();
                if buf.len() >= 40 {
                    buf.pop_front();
                }
                buf.push_back(line);
            }
        });
    }

    // Everything from here on is one or more round trips to nvim; if it never
    // answers (the stuck-prompt case above, or anything else), this would hang
    // forever with the caller none the wiser. `bridge_for` in lib.rs already
    // gives up waiting after 5s and every gui-window would sit blank with no
    // explanation. Time the whole handshake instead, and fold the captured
    // stderr into the error so "why" is visible from the very first symptom
    // instead of requiring exactly this investigation to find again.
    let handshake = async move {
        // No scene is staged here: the renderer draws whatever windows and
        // buffers the launch args (or the user) produce. Filetype detection is
        // left to the user's config.
        //
        // A bare `-u NONE` nvim ships Neovim 0.10+'s built-in colorscheme with
        // background=dark. gneovim is a light prose surface, so force the light
        // palette for that case only. With a real user config, respect whatever
        // background / colorscheme it sets.
        if crate::config::get().neovim.is_bare() {
            nvim.command("set background=light").await.ok();
        }
        // The GUI feeds mouse events via nvim_input_mouse; make sure nvim acts
        // on them even if a user config cleared 'mouse'.
        nvim.command("set mouse=a").await.ok();

        // Autocmds in one augroup, targeted at our channel.
        let api = nvim.get_api_info().await.map_err(err)?;
        let chan = api.first().and_then(Value::as_i64).ok_or("no channel id")?;

        // Wire the + and * registers to the macOS pasteboard through this
        // channel (no reliance on pbcopy/pbpaste, which a bundled app cannot
        // find on PATH).
        nvim.command(&format!(
            "let g:clipboard = {{\
               'name': 'gneovim',\
               'copy': {{\
                 '+': {{lines, rt -> rpcnotify({chan}, 'gnv_clip_set', '+', lines, rt)}},\
                 '*': {{lines, rt -> rpcnotify({chan}, 'gnv_clip_set', '*', lines, rt)}}}},\
               'paste': {{\
                 '+': {{-> rpcrequest({chan}, 'gnv_clip_get', '+')}},\
                 '*': {{-> rpcrequest({chan}, 'gnv_clip_get', '*')}}}}}}"
        ))
        .await
        .ok();
        nvim.command("augroup gnv | autocmd! | augroup END")
            .await
            .map_err(err)?;
        for spec in [
            format!(
                "autocmd gnv CursorMoved,CursorMovedI,ModeChanged,TextChanged,TextChangedI * \
                 call rpcnotify({chan}, 'gnv_cursor', win_getid(), line('.') - 1, col('.') - 1, mode(), &scrolloff)"
            ),
            format!(
                "autocmd gnv OptionSet scrolloff \
                 call rpcnotify({chan}, 'gnv_cursor', win_getid(), line('.') - 1, col('.') - 1, mode(), &scrolloff)"
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
            format!(
                "autocmd gnv OptionSet guifont,guifontwide,linespace \
                 call rpcnotify({chan}, 'gnv_guiopt', expand('<amatch>'), v:option_new)"
            ),
            // Every `nvim_ui_try_resize` (the webview's ResizeObserver on any
            // real size change: a window drag, opening/closing devtools) sends
            // grid 1 a `grid_resize` immediately followed by a `grid_clear`,
            // which blanks the tabline row client side. Neovim only refills it
            // if it considers the tabline's own text dirty; from its side nvim's
            // own text often has not changed (same tabs, same names), so no
            // fresh `grid_line` for that row ever arrives and the client is left
            // holding blanked cells with no natural repaint. `redrawtabline`
            // (not a forced `redraw!`, which reportedly clears every grid, see
            // multigrid-renderer.md) forces Neovim to recompute and resend just
            // that row regardless of whether it thinks it is dirty.
            "autocmd gnv VimResized * redrawtabline".into(),
        ] {
            nvim.command(&spec).await.map_err(err)?;
        }

        // GUI-detection global + the :MarkdownLivePreview{On,Off,Toggle}
        // commands. Injected, not a user plugin: it must match
        // `handle_notify`'s `gnv_md_preview` arm. Set before `ui_start` so
        // `g:gneovim` is present by the time a `UIEnter` autocmd in the user's
        // config runs.
        let md_default: i64 = crate::config::get().markdown.live_preview_default.into();
        if let Err(e) = nvim
            .exec_lua(
                include_str!("runtime/md_preview.lua"),
                vec![
                    chan.into(),
                    md_default.into(),
                    env!("CARGO_PKG_VERSION").into(),
                ],
            )
            .await
        {
            log::warn!("md_preview.lua injection failed: {e}");
        }

        // The markdown-island display bridge (conceal now; highlights, folds
        // and the visual range later). Its `gnv_md_decor` augroup is inert for
        // grid windows: it reads `w:gnv_md_preview` (from md_preview.lua) per
        // event.
        if let Err(e) = nvim
            .exec_lua(include_str!("runtime/md_decor.lua"), vec![chan.into()])
            .await
        {
            log::warn!("md_decor.lua injection failed: {e}");
        }

        // `:OpenInNewGneovimTab` + `_G.OpenInNewGneovimTab()`: move / open
        // buffers into a new gui-tab. Injected glue; its `gnv_open_new_tab`
        // rpcnotify must match `handle_notify`'s arm and
        // `BridgeEvent::OpenNewTab`.
        if let Err(e) = nvim
            .exec_lua(
                include_str!("runtime/open_in_new_tab.lua"),
                vec![chan.into()],
            )
            .await
        {
            log::warn!("open_in_new_tab.lua injection failed: {e}");
        }

        // A moved `[No Name]` buffer (`:OpenInNewGneovimTab` with no args, on
        // a buffer with no file): seed the initial buffer with its
        // carried-over text.
        if let Some(lines) = open.content {
            let arr = Value::Array(lines.into_iter().map(Value::from).collect());
            if let Err(e) = nvim
                .exec_lua(
                    "local l = ...\nvim.api.nvim_buf_set_lines(0, 0, -1, false, l)",
                    vec![arr],
                )
                .await
            {
                log::warn!("open_in_new_tab: seeding moved buffer failed: {e}");
            }
        }

        // No buffer is attached here. Islands attach their window's buffer on
        // demand via `island_attach`; a session with no markdown window never
        // attaches anything.

        // NOTE: the UI is *not* attached here. `nvim_ui_attach` immediately
        // emits a full redraw, and the webview has not registered its
        // `listen()` handlers yet, so that first frame (every window's
        // `grid_line`) would be lost with no way to make nvim resend it. The
        // client calls `ui_start` once its listeners are live; see
        // `Bridge::ui_start`.

        Ok::<(Bridge, Child), String>((Bridge { nvim, shared, bufs }, child))
    };

    match tokio::time::timeout(CONNECT_TIMEOUT, handshake).await {
        Ok(result) => result,
        Err(_) => {
            let tail: Vec<String> = stderr_tail.lock().unwrap().iter().cloned().collect();
            let mut msg = format!(
                "Neovim did not respond within {}s of starting; it is likely stuck at a \
                 startup prompt this embedded session cannot answer (e.g. a config error \
                 that a terminal nvim would show as \u{201c}Press ENTER to continue\u{201d}).",
                CONNECT_TIMEOUT.as_secs()
            );
            if !tail.is_empty() {
                msg.push_str("\n\nNeovim's own output:\n");
                msg.push_str(&tail.join("\n"));
            }
            Err(msg)
        }
    }
}

impl Bridge {
    pub async fn input(&self, keys: &str) -> Result<(), String> {
        self.nvim.input(keys).await.map(|_| ()).map_err(err)
    }

    /// Paste `text` at the cursor with `nvim_paste` (handles insert vs normal,
    /// linewise, and `:set paste`). Used by the Edit menu's Paste / Cmd+V.
    pub async fn paste(&self, text: &str) -> Result<(), String> {
        self.nvim
            .call("nvim_paste", vec![text.into(), true.into(), (-1_i64).into()])
            .await
            .map_err(err)?
            .map_err(|e| format!("{e:?}"))
            .map(|_| ())
    }

    /// Edit menu Copy / Cut: yank (or delete) into `+`. In a visual/select mode
    /// it acts on the selection; in normal mode on the current line.
    pub async fn clip_yank(&self, cut: bool) -> Result<(), String> {
        let op = if cut { "d" } else { "y" };
        let lua = format!(
            "local m = vim.api.nvim_get_mode().mode\n\
             if m:match('^[vV\\022sS\\019]') then\n\
               vim.api.nvim_feedkeys('\"+{op}', 'nx', false)\n\
             elseif m == 'n' then\n\
               vim.api.nvim_feedkeys('\"+{op}{op}', 'nx', false)\n\
             end"
        );
        self.nvim.exec_lua(&lua, vec![]).await.map(|_| ()).map_err(err)
    }

    /// button: left|right|middle|wheel|move  action: press|release|drag (buttons)
    /// or up|down|left|right (wheel).  `grid` 0 lets nvim hit-test global coords.
    pub async fn input_mouse(
        &self,
        button: &str,
        action: &str,
        modifier: &str,
        row: i64,
        col: i64,
    ) -> Result<(), String> {
        self.nvim
            .call(
                "nvim_input_mouse",
                vec![
                    button.into(),
                    action.into(),
                    modifier.into(),
                    0.into(),
                    row.into(),
                    col.into(),
                ],
            )
            .await
            .map_err(err)?
            .map_err(|e| format!("{e:?}"))
            .map(|_| ())
    }

    /// Focus `win` and move its cursor. Used when a click lands in an island.
    pub async fn cursor_set(&self, win: i64, row: i64, col: i64) -> Result<(), String> {
        let w = Value::from(win);
        self.nvim
            .call("nvim_set_current_win", vec![w.clone()])
            .await
            .map_err(err)?
            .map_err(|e| format!("{e:?}"))?;
        self.nvim
            .call(
                "nvim_win_set_cursor",
                vec![w, Value::Array(vec![Value::from(row + 1), Value::from(col)])],
            )
            .await
            .map_err(err)?
            .map_err(|e| format!("{e:?}"))
            .map(|_| ())
    }

    pub async fn edit(&self, buf: i64, regions: Vec<Region>) -> Result<(), String> {
        if !self.bufs.lock().await.contains_key(&buf) {
            return Ok(()); // island for this buffer is gone
        }
        let _edit_guard = self.shared.edit_lock.lock().await;
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

        lock_recover(&self.shared.edit_sync, "edit sync")
            .pending
            .insert(buf, Vec::new());
        let res = self
            .nvim
            .exec_lua(
                LUA_APPLY_EDIT,
                vec![Value::from(buf), Value::Array(lua_regions)],
            )
            .await;

        let own_ticks: HashSet<i64> = res
            .as_ref()
            .ok()
            .and_then(Value::as_array)
            .map(|ticks| ticks.iter().filter_map(Value::as_i64).collect())
            .unwrap_or_default();
        let forward = {
            let mut sync = lock_recover(&self.shared.edit_sync, "edit sync");
            let pending = sync.pending.remove(&buf).unwrap_or_default();
            let suppress = sync.suppress.entry(buf).or_default();
            suppress.extend(own_ticks);
            let forward = pending
                .into_iter()
                .filter_map(|(tick, payload)| {
                    if suppress.remove(&tick) {
                        None
                    } else {
                        Some(payload)
                    }
                })
                .collect::<Vec<_>>();
            if suppress.is_empty() {
                sync.suppress.remove(&buf);
            }
            forward
        };
        for payload in forward {
            self.shared.send(BridgeEvent::Lines(payload));
        }
        res.map(|_| ()).map_err(err)
    }

    /// Attach `win`'s buffer for buffer-sync and return a fresh snapshot. If the
    /// buffer is already attached (another island shows it) this just bumps the
    /// refcount. `win` is a raw window id.
    pub async fn island_attach(&self, win: i64) -> Result<ResetPayload, String> {
        let buf_val = self
            .nvim
            .call("nvim_win_get_buf", vec![Value::from(win)])
            .await
            .map_err(err)?
            .map_err(|e| format!("nvim_win_get_buf: {e:?}"))?;
        let id = ext_id(&buf_val).ok_or("nvim_win_get_buf returned no id")?;

        {
            let mut bufs = self.bufs.lock().await;
            if let Some(st) = bufs.get_mut(&id) {
                st.refs += 1;
            } else {
                let buf = Buffer::new(Value::from(id), self.nvim.clone());
                // send_buffer = false: no initial snapshot event; we return one
                buf.attach(false, vec![]).await.map_err(err)?;
                bufs.insert(id, BufState { buf, refs: 1 });
            }
        }
        match island_snapshot(&self.nvim, win, id).await {
            Ok(snapshot) => Ok(snapshot),
            Err(error) => {
                // Balance the refcount established above when the snapshot
                // cannot be delivered to its caller.
                if let Err(detach_error) = self.island_detach(id).await {
                    log::warn!(
                        "failed to roll back island attach for buffer {id}: {detach_error}"
                    );
                }
                Err(error)
            }
        }
    }

    /// Drop one island's hold on `buf`; detach when the last island goes.
    pub async fn island_detach(&self, buf: i64) -> Result<(), String> {
        let mut bufs = self.bufs.lock().await;
        let Some(st) = bufs.get_mut(&buf) else {
            return Ok(());
        };
        if st.refs > 1 {
            st.refs -= 1;
            return Ok(());
        }
        // Keep ownership until Neovim confirms the detach. A failed request can
        // then be retried without losing the bridge's refcount state.
        st.buf.detach().await.map_err(err)?;
        bufs.remove(&buf);
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
    /// `[(name, value), ...]` for the GUI options the client cares about, so it
    /// can pick them up on boot (there is no `ext_` event for them).
    pub async fn gui_opts(&self) -> Result<Vec<(String, String)>, String> {
        let v = self
            .nvim
            .eval(
                "[['guifont', &guifont], ['guifontwide', &guifontwide], \
                 ['linespace', string(&linespace)]]",
            )
            .await
            .map_err(err)?;
        Ok(v.as_array()
            .into_iter()
            .flatten()
            .filter_map(|row| {
                let r = row.as_array()?;
                Some((
                    r.first().and_then(Value::as_str)?.to_string(),
                    r.get(1).and_then(Value::as_str).unwrap_or("").to_string(),
                ))
            })
            .collect())
    }

    /// `[(winid, bufnr, filetype, md_preview), ...]` for every window, replayed
    /// on the client's first attach. `md_preview`: 1 preview, 0 grid, -1 unset
    /// (from `w:gnv_md_preview`, maintained by `runtime/md_preview.lua`).
    pub async fn win_fts(&self) -> Result<Vec<(i64, i64, String, i64)>, String> {
        let v = self
            .nvim
            .eval(
                "map(getwininfo(), {_,w -> \
                 [w.winid, w.bufnr, getbufvar(w.bufnr, '&filetype'), \
                 getwinvar(w.winid, 'gnv_md_preview', -1)]})",
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
                    r.get(3).and_then(Value::as_i64).unwrap_or(-1),
                ))
            })
            .collect())
    }

    /// `[(winid, number, relativenumber, numberwidth, signcolumn, foldcolumn), ...]`
    /// for every window, replayed on first attach: the `OptionSet` / `WinEnter`
    /// feed in `md_preview.lua` fires before the client is listening.
    pub async fn win_gutters(
        &self,
    ) -> Result<Vec<(i64, bool, bool, i64, String, String)>, String> {
        let v = self
            .nvim
            .eval(
                "map(getwininfo(), {_,w -> [w.winid, \
                 getwinvar(w.winid, '&number'), getwinvar(w.winid, '&relativenumber'), \
                 getwinvar(w.winid, '&numberwidth'), getwinvar(w.winid, '&signcolumn'), \
                 getwinvar(w.winid, '&foldcolumn')]})",
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
                    r.get(1).and_then(Value::as_i64).unwrap_or(0) != 0,
                    r.get(2).and_then(Value::as_i64).unwrap_or(0) != 0,
                    r.get(3).and_then(Value::as_i64).unwrap_or(4),
                    r.get(4).and_then(Value::as_str).unwrap_or("auto").to_string(),
                    r.get(5).and_then(Value::as_str).unwrap_or("0").to_string(),
                ))
            })
            .collect())
    }

    /// Nudge `md_decor.lua` to re-push every markdown island's decorations.
    /// Called on island mount and first attach, where no trigger event has
    /// fired since the client started listening.
    pub async fn md_decor_refresh(&self) -> Result<(), String> {
        self.nvim
            .exec_lua(
                "pcall(vim.api.nvim_exec_autocmds, 'CursorMoved', \
                 { group = 'gnv_md_decor', modeline = false })",
                vec![],
            )
            .await
            .map(|_| ())
            .map_err(err)
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

    /// Open each path as its own Neovim tabpage (`[window] open_files_in =
    /// "nvim-tab"`). The first path reuses the current tab when it is still a
    /// pristine `[No Name]` scratch (a just-launched window), otherwise every
    /// path gets a fresh `:tabedit`.
    pub async fn open_files_as_tabs(&self, paths: &[String]) -> Result<(), String> {
        const LUA: &str = r#"
            local paths = ...
            for i, p in ipairs(paths) do
              local buf = vim.api.nvim_get_current_buf()
              local reuse = i == 1
                and vim.api.nvim_buf_get_name(buf) == ''
                and not vim.bo[buf].modified
                and #vim.api.nvim_list_tabpages() == 1
                and #vim.api.nvim_tabpage_list_wins(0) == 1
              vim.cmd({ cmd = reuse and 'edit' or 'tabedit', args = { p } })
            end
        "#;
        let arr: Vec<Value> = paths.iter().map(|s| Value::from(s.as_str())).collect();
        self.nvim
            .exec_lua(LUA, vec![Value::Array(arr)])
            .await
            .map(|_| ())
            .map_err(err)
    }

    /// Short descriptions of every buffer that would make `:qall` fail without a
    /// bang: a modified file buffer (`E37`) or a `:terminal` with a live job
    /// (`E947`). Empty result means this nvim can quit cleanly.
    pub async fn unsaved_blockers(&self) -> Result<Vec<String>, String> {
        const LUA: &str = r#"
            local out = {}
            for _, b in ipairs(vim.api.nvim_list_bufs()) do
              if vim.api.nvim_buf_is_loaded(b) then
                local bo = vim.bo[b]
                local tail = vim.fn.fnamemodify(vim.api.nvim_buf_get_name(b), ':t')
                local label = (tail ~= '' and tail) or ('[No Name] (buffer ' .. b .. ')')
                if bo.modified and bo.modifiable and not bo.readonly
                   and (bo.buftype == '' or bo.buftype == 'acwrite') then
                  out[#out + 1] = label
                elseif bo.buftype == 'terminal' then
                  local job = vim.b[b].terminal_job_id
                  if job and vim.fn.jobwait({ job }, 0)[1] == -1 then
                    out[#out + 1] = 'terminal: ' .. label
                  end
                end
              end
            end
            return out
        "#;
        let v = self.nvim.exec_lua(LUA, vec![]).await.map_err(err)?;
        Ok(v.as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default())
    }

    /// `:qall` (`force` false) or `:qall!` (`force` true). On a clean quit nvim
    /// exits and the io task emits `BridgeEvent::Gone`, which closes the window.
    pub async fn quit_all(&self, force: bool) -> Result<(), String> {
        let cmd = if force { "qall!" } else { "qall" };
        self.nvim.command(cmd).await.map_err(err)
    }

    /// `(tabpages, windows, listed_buffers)` for this nvim, for the "you are
    /// about to close a big session" confirmation.
    pub async fn session_stats(&self) -> Result<(i64, i64, i64), String> {
        let v = self
            .nvim
            .exec_lua(
                "return { #vim.api.nvim_list_tabpages(), #vim.api.nvim_list_wins(), \
                 #vim.fn.getbufinfo({ buflisted = 1 }) }",
                vec![],
            )
            .await
            .map_err(err)?;
        let a = v.as_array().ok_or("session_stats: not an array")?;
        let n = |i: usize| a.get(i).and_then(Value::as_i64).unwrap_or(0);
        Ok((n(0), n(1), n(2)))
    }
}
