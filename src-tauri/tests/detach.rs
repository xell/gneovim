//! A gui-window's Neovim against real spawned nvims. `:detach` (and
//! `:connect`, which is `:detach` for a UI without the "connect" UI event)
//! closes the channel but leaves Neovim running in the background with its
//! unsaved buffers, as `:h :detach` says, so the window's `Gone` handler
//! releases the process instead of killing it, and `runtime/ui_leave.lua`
//! turns the session back into a plain Neovim. `bridge::attach` brings it
//! back into a gui-window. `:qa` still ends Neovim, and an unreleased process
//! is still killed when dropped (Cmd+W on a Neovim that did not quit in time).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use app_lib::bridge::{self, Bridge, BridgeEvent, NvimProcess};
use nvim_rs::{create::tokio as create, rpc::handler::Dummy, Value};
use tokio::sync::{mpsc, watch};

async fn settle() {
    tokio::time::sleep(Duration::from_millis(250)).await;
}

/// Running, and not a zombie waiting to be reaped.
fn running(pid: u32) -> bool {
    let out = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .expect("ps");
    let stat = String::from_utf8_lossy(&out.stdout);
    let stat = stat.trim();
    !stat.is_empty() && !stat.starts_with('Z')
}

/// Kills `pid` when the test ends, pass or fail. A detached nvim is meant to
/// outlive everything else here, so a failed assertion would leak it.
struct Reap(u32);

impl Drop for Reap {
    fn drop(&mut self) {
        if running(self.0) {
            let _ = std::process::Command::new("kill").arg(self.0.to_string()).status();
        }
    }
}

async fn exits_within(pid: u32, ms: u64) -> bool {
    for _ in 0..ms / 50 {
        if !running(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    !running(pid)
}

/// What a gui-window's event loop would see: the `Gone` reason, the address
/// from `:GneovimFocusSession` (the only way a test can read
/// `v:servername`), and how many cursor reports arrived.
struct Events {
    gone: watch::Receiver<Option<String>>,
    addr: watch::Receiver<Option<String>>,
    cursors: Arc<AtomicUsize>,
}

fn events() -> (mpsc::UnboundedSender<BridgeEvent>, Events) {
    let (tx, mut rx) = mpsc::unbounded_channel::<BridgeEvent>();
    let (gone_tx, gone) = watch::channel(None);
    let (addr_tx, addr) = watch::channel(None);
    let cursors = Arc::new(AtomicUsize::new(0));
    let cursors2 = cursors.clone();
    tokio::spawn(async move {
        while let Some(e) = rx.recv().await {
            match e {
                BridgeEvent::Gone(reason) => {
                    let _ = gone_tx.send(Some(reason));
                }
                BridgeEvent::FocusSession(a) => {
                    let _ = addr_tx.send(Some(a));
                }
                BridgeEvent::Cursor(_) => {
                    cursors2.fetch_add(1, Ordering::SeqCst);
                }
                _ => {}
            }
        }
    });
    (tx, Events { gone, addr, cursors })
}

impl Events {
    async fn wait_gone(&mut self) -> String {
        tokio::time::timeout(Duration::from_secs(5), self.gone.wait_for(Option::is_some))
            .await
            .expect("no Gone within 5s")
            .expect("event task ended")
            .clone()
            .unwrap()
    }

    /// This nvim's own address, via `:GneovimFocusSession` in `b`.
    async fn addr_of(&self, b: &Bridge) -> String {
        b.input(":exe 'GneovimFocusSession' v:servername\r").await.unwrap();
        settle().await;
        self.addr.borrow().clone().expect("no FocusSession event")
    }
}

/// A connected, UI-attached nvim.
async fn session() -> (Bridge, NvimProcess, Events) {
    let (tx, ev) = events();
    let (bridge, process) = bridge::connect(tx, Default::default(), false, false)
        .await
        .expect("connect");
    bridge.ui_start(80, 24).await.expect("ui_start");
    (bridge, process, ev)
}

/// An nvim detached from its gui-window, with an unsaved edit: what
/// `:detach` (or `:connect`) leaves behind. Returns its pid and address.
async fn detached_session() -> (Reap, u32, String) {
    let (b, mut process, mut ev) = session().await;
    let pid = process.id().expect("pid");
    let reap = Reap(pid);
    b.input(":enew | call setline(1, 'unsaved text')\r").await.unwrap();
    let addr = ev.addr_of(&b).await;
    b.input(":detach\r").await.unwrap();
    ev.wait_gone().await;
    // What the window's Gone handler does, then the window's removal.
    process.release();
    drop(process);
    drop(b);
    settle().await;
    (reap, pid, addr)
}

/// A plain RPC connection to the nvim at `addr`, as another Neovim would make.
async fn probe(
    addr: &str,
) -> nvim_rs::Neovim<nvim_rs::compat::tokio::Compat<tokio::io::WriteHalf<tokio::net::UnixStream>>>
{
    create::new_path(addr, Dummy::new()).await.expect("probe connect").0
}

#[tokio::test]
async fn detach_leaves_a_plain_nvim_running_once_released() {
    let (_reap, pid, addr) = detached_session().await;
    assert!(running(pid), "nvim {pid} did not survive :detach");

    // Still the same session, unsaved edit and all, at the same address, and
    // none of gneovim's glue is left to misbehave with no gneovim attached.
    let p = probe(&addr).await;
    let state = p
        .eval(
            "[getline(1, '$'), &modified, exists('#gnv'), exists('g:gneovim'), \
             maparg('ZZ', 'n'), exists('g:clipboard')]",
        )
        .await
        .expect("eval");
    assert_eq!(
        state,
        Value::Array(vec![
            Value::Array(vec!["unsaved text".into()]),
            1.into(),
            0.into(),
            0.into(),
            "".into(),
            0.into(),
        ]),
        "[lines, modified, #gnv, g:gneovim, ZZ map, g:clipboard] after :detach"
    );
    // The old `gnv` autocmds would raise E475 here (their channel is gone).
    p.command("doautocmd CursorMoved").await.expect("CursorMoved after :detach");

    let _ = p.command("qall!").await;
    assert!(exits_within(pid, 2000).await, "nvim {pid} did not quit on :qall!");
}

#[tokio::test]
async fn attach_brings_a_detached_session_back() {
    let (_reap, pid, addr) = detached_session().await;
    assert_eq!(bridge::has_ui(&addr).await, Some(false), "a detached session has no UI");

    let (tx, mut ev) = events();
    let (b, process) = bridge::attach(tx, &addr, false).await.expect("attach");
    assert_eq!(process.id(), None, "an attached nvim is not gneovim's to kill");
    b.ui_start(80, 24).await.expect("ui_start");
    settle().await;
    assert_eq!(bridge::has_ui(&addr).await, Some(true), "attached UI not seen");

    // gneovim's glue is back, on the new channel, and not doubled.
    assert_eq!(ev.addr_of(&b).await, addr, "GneovimFocusSession on the new channel");
    b.input("k").await.unwrap();
    settle().await;
    assert!(ev.cursors.load(Ordering::SeqCst) > 0, "no cursor reports after attach");
    let p = probe(&addr).await;
    let state = p
        .eval(
            "[getline(1, '$'), &modified, exists('g:gneovim'), \
             len(nvim_get_autocmds({'group': 'gnv', 'event': 'CursorMoved'})), \
             nvim_get_chan_info(nvim_list_uis()[0].chan).client.name]",
        )
        .await
        .expect("eval");
    assert_eq!(
        state,
        Value::Array(vec![
            Value::Array(vec!["unsaved text".into()]),
            1.into(),
            1.into(),
            1.into(),
            "gneovim".into(),
        ]),
        "[lines, modified, g:gneovim, gnv CursorMoved autocmds, UI client] after attach"
    );

    // Detaching again leaves it running again; nothing of gneovim's kills it.
    b.input(":detach\r").await.unwrap();
    ev.wait_gone().await;
    drop(process);
    drop(b);
    settle().await;
    assert!(running(pid), "nvim {pid} did not survive a second :detach");

    let _ = p.command("qall!").await;
    assert!(exits_within(pid, 2000).await, "nvim {pid} did not quit on :qall!");
}

#[tokio::test]
async fn qall_still_ends_nvim() {
    let (b, process, mut ev) = session().await;
    let pid = process.id().expect("pid");
    b.input(":qall!\r").await.unwrap();
    ev.wait_gone().await;
    assert!(exits_within(pid, 2000).await, "nvim {pid} still running after :qall!");
}

#[tokio::test]
async fn dropping_an_unreleased_process_kills_nvim() {
    let (b, process, _ev) = session().await;
    let pid = process.id().expect("pid");
    // The bridge (and so nvim's stdin) stays open: only the kill can end it.
    drop(process);
    assert!(exits_within(pid, 2000).await, "nvim {pid} survived its dropped process");
    drop(b);
}
