//! Buffer-sync round trip for the markdown island, against a real spawned nvim:
//! attach a window's buffer, see incremental diffs, forward a reverse edit with
//! echo suppression.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use app_lib::bridge::{self, BridgeEvent, Region};
use tokio::sync::mpsc;

async fn settle() {
    tokio::time::sleep(Duration::from_millis(250)).await;
}

#[tokio::test]
async fn island_round_trip() {
    std::fs::write(
        "/tmp/gnv-island-test.md",
        "alpha line one\nbeta line two\ngamma line three\n",
    )
    .unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel::<BridgeEvent>();
    let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let lines2 = lines.clone();
    tokio::spawn(async move {
        while let Some(e) = rx.recv().await {
            if let BridgeEvent::Lines(p) = e {
                lines2
                    .lock()
                    .unwrap()
                    .push(format!("buf={} f={} l={} {:?}", p.buf, p.firstline, p.lastline, p.linedata));
            }
        }
    });

    let (b, _child) = bridge::connect(tx, Default::default()).await.expect("connect");
    b.ui_start(120, 40).await.expect("ui_start");
    b.input(":edit /tmp/gnv-island-test.md\r").await.unwrap();
    settle().await;

    // 1. attach the current window's buffer -> snapshot
    let win = 1000; // first window id in a fresh nvim
    let snap = b.island_attach(win).await.expect("island_attach");
    assert!(snap.buf > 0);
    assert_eq!(snap.lines.len(), 3);
    assert_eq!(snap.lines[0], "alpha line one");
    assert!(snap.name.ends_with("gnv-island-test.md"));

    // 2. an nvim-side edit streams back as a Lines event for that buffer
    b.input("Goinserted from rust\u{1b}").await.unwrap();
    settle().await;
    {
        let l = lines.lock().unwrap();
        assert!(
            l.iter().any(|s| s.contains("inserted from rust") && s.contains(&format!("buf={}", snap.buf))),
            "insert produced a Lines event for the attached buffer: {l:?}"
        );
    }

    // 3. a reverse edit: our own change is echo-suppressed
    let before = lines.lock().unwrap().len();
    b.edit(
        snap.buf,
        vec![Region {
            start_row: 0,
            start_col: 0,
            end_row: 0,
            end_col: 5,
            replacement: vec!["ALPHA".into()],
        }],
    )
    .await
    .unwrap();
    settle().await;
    let after = lines.lock().unwrap().len();
    assert_eq!(after, before, "echo of our own edit is suppressed: {:?}", lines.lock().unwrap());

    let snap2 = b.island_attach(win).await.unwrap();
    assert!(snap2.lines[0].starts_with("ALPHA"), "edit landed: {:?}", snap2.lines[0]);

    // 4. detach: refcount from the two attach calls must both be released
    b.island_detach(snap.buf).await.unwrap();
    b.island_detach(snap.buf).await.unwrap();
}
