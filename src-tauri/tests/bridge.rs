//! Exercises the Tauri-free bridge core against a real spawned nvim.
//! Mirrors the old `_wsprobe.mjs` checks: incremental diffs, reverse edit with
//! echo suppression, active-buffer following.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use app_lib::bridge::{self, BridgeEvent, Region};
use tokio::sync::mpsc;

fn tag(e: &BridgeEvent) -> String {
    match e {
        BridgeEvent::Reset(p) => format!(
            "reset name={:?} l0={:?} n={}",
            p.name,
            p.lines.first(),
            p.lines.len()
        ),
        BridgeEvent::Lines(p) => {
            format!("lines f={} l={} {:?}", p.firstline, p.lastline, p.linedata)
        }
        BridgeEvent::Cursor(p) => format!("cursor {},{} {}", p.row, p.col, p.mode),
        BridgeEvent::Cmdline(p) => {
            format!("cmdline {:?} {:?} {}", p.ctype, p.content, p.pos)
        }
        BridgeEvent::CmdlineHide => "cmdline_hide".into(),
    }
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(250)).await;
}

#[tokio::test]
async fn bridge_round_trip() {
    std::fs::write(
        "/tmp/gnv-test.md",
        "alpha line one\nbeta line two\ngamma line three\n",
    )
    .unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel::<BridgeEvent>();
    let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let log2 = log.clone();
    tokio::spawn(async move {
        while let Some(e) = rx.recv().await {
            log2.lock().unwrap().push(tag(&e));
        }
    });

    let (b, _child) = bridge::connect(tx).await.expect("connect to nvim");
    settle().await;

    // 1. initial snapshot
    let r0 = b.reset().await.expect("reset");
    assert_eq!(r0.lines.len(), 9, "welcome buffer seeded");
    assert!(r0.name.is_empty());
    assert_eq!(r0.lines[0], "# hello from neovim");

    // 2. incremental insert: o<text><esc>
    b.input("Goinserted from rust\u{1b}").await.unwrap();
    settle().await;
    {
        let l = log.lock().unwrap();
        assert!(
            l.iter().any(|s| s.contains("inserted from rust")),
            "insert produced a lines event: {l:?}"
        );
    }

    // 3. reverse edit, single region: replace "#" with "%" on line 0
    let before = log.lock().unwrap().iter().filter(|s| s.starts_with("lines ")).count();
    b.edit(vec![Region {
        start_row: 0,
        start_col: 0,
        end_row: 0,
        end_col: 1,
        replacement: vec!["%".into()],
    }])
    .await
    .unwrap();
    settle().await;
    let after = log.lock().unwrap().iter().filter(|s| s.starts_with("lines ")).count();
    assert_eq!(after, before, "echo of our own edit is suppressed");
    let r1 = b.reset().await.unwrap();
    assert!(r1.lines[0].starts_with("% hello"), "edit landed in nvim: {:?}", r1.lines[0]);

    // 4. active-buffer following: :e a real file
    b.input(":e /tmp/gnv-test.md\r").await.unwrap();
    settle().await;
    settle().await;
    {
        let l = log.lock().unwrap();
        assert!(
            l.iter().any(|s| s.contains("gnv-test.md") && s.starts_with("reset ")),
            "buffer switch pushed a fresh reset: {l:?}"
        );
    }
    let r2 = b.reset().await.unwrap();
    assert!(r2.name.ends_with("gnv-test.md"));
    assert_eq!(r2.lines[0], "alpha line one");
}
