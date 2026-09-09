//! Throwaway: dump the redraw event stream for a 2-window vsplit with multigrid.
//! Run with:  cargo test --test redraw_probe -- --nocapture

use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use nvim_rs::{
    compat::tokio::Compat, create::tokio as create, Handler, Neovim, UiAttachOptions, Value,
};
use tokio::process::ChildStdin;

type W = Compat<ChildStdin>;

#[derive(Clone)]
struct H {
    log: Arc<Mutex<Vec<String>>>,
}

fn short(v: &Value) -> String {
    let s = format!("{v:?}");
    if s.len() > 240 {
        format!("{}…", &s[..240])
    } else {
        s
    }
}

#[async_trait]
impl Handler for H {
    type Writer = W;
    async fn handle_notify(&self, name: String, args: Vec<Value>, _nv: Neovim<W>) {
        if name != "redraw" {
            self.log.lock().unwrap().push(format!("NOTIFY {name}"));
            return;
        }
        // args is a Vec of batches; each batch = [event_name, call1, call2, ...]
        for batch in args {
            let Some(arr) = batch.as_array() else { continue };
            let Some(ev) = arr.first().and_then(Value::as_str) else {
                continue;
            };
            // one representative call per event kind
            let sample = arr.get(1).map(short).unwrap_or_default();
            let count = arr.len().saturating_sub(1);
            self.log
                .lock()
                .unwrap()
                .push(format!("{ev}  x{count}  {sample}"));
        }
    }
}

#[tokio::test]
async fn dump_redraw() {
    std::fs::write("/tmp/gnv-probe.rs", "fn main() {\n    let x = 1;\n    println!(\"{x}\");\n}\n").unwrap();
    std::fs::write(
        "/tmp/gnv-probe.md",
        "# Heading\n\nSome *emphasis* and a [link](http://example.com).\n\n- one\n- two\n",
    )
    .unwrap();

    let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let handler = H { log: log.clone() };

    let mut cmd = tokio::process::Command::new(
        std::env::var("GNV_NVIM").unwrap_or_else(|_| "nvim".into()),
    );
    cmd.args(["--embed", "--headless", "-n", "-u", "NONE", "-i", "NONE"]);
    let (nvim, _io, _child) = create::new_child_cmd(&mut cmd, handler).await.unwrap();

    let mut opts = UiAttachOptions::new();
    opts.set_linegrid_external(true).set_multigrid_external(true);
    nvim.ui_attach(120, 40, &opts).await.unwrap();

    tokio::time::sleep(Duration::from_millis(200)).await;
    log.lock().unwrap().push("=== after ui_attach ===".into());

    nvim.command("edit /tmp/gnv-probe.rs").await.unwrap();
    nvim.command("vsplit /tmp/gnv-probe.md").await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    log.lock().unwrap().push("=== after vsplit ===".into());

    // move around and scroll the right (md) window
    nvim.input("30oline<Esc>").await.unwrap();
    nvim.input("gg").await.unwrap();
    nvim.input("<C-w>h").await.unwrap();
    nvim.input("<C-w>=").await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    log.lock().unwrap().push("=== after edits/motions ===".into());

    // full detail for a few key events, second pass
    let want = ["grid_resize", "win_pos", "win_viewport", "win_float_pos", "grid_scroll", "default_colors_set", "hl_attr_define", "mode_info_set", "grid_line", "grid_destroy", "win_hide", "win_close", "tabline_update"];
    let mut detail: Vec<String> = Vec::new();
    // re-run a redraw by forcing one
    nvim.command("mode").await.ok();
    tokio::time::sleep(Duration::from_millis(150)).await;

    let lines = log.lock().unwrap().clone();
    let mut seen = std::collections::HashSet::new();
    for l in &lines {
        for w in &want {
            if l.starts_with(w) && seen.insert(*w) {
                detail.push(l.clone());
            }
        }
    }

    println!("\n----- event log (kind  xcalls  sample) -----");
    for l in &lines {
        println!("{l}");
    }
    println!("\n----- first sample of each key event -----");
    for l in &detail {
        println!("{l}");
    }

    // also dump the win layout via winlayout for reference
    let layout = nvim.eval("winlayout()").await.unwrap();
    println!("\nwinlayout(): {layout:?}");
    let wins = nvim.eval("map(getwininfo(), {_,w -> [w.winid, w.winnr, w.bufnr, w.textoff, w.width, w.height, getbufvar(w.bufnr, \"&filetype\")]})").await.unwrap();
    println!("getwininfo: {wins:?}");
}
