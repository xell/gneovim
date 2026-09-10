//! Grid-renderer smoke test: connect, attach the UI, stage a small scene
//! (a file in a vsplit, one window switched to filetype=markdown), and check
//! the multigrid event stream reaches the channel. The bridge stages nothing
//! itself, so the test drives the scene.
//! cargo test --test multigrid_renderer -- --nocapture

use std::collections::HashSet;
use std::time::Duration;

use app_lib::bridge::{self, BridgeEvent};
use tokio::sync::mpsc;

#[tokio::test]
async fn multigrid_renderer_flow() {
    let file = std::env::temp_dir().join("gnv-grid-test.txt");
    std::fs::write(
        &file,
        (1..=120)
            .map(|n| format!("line {n}: the quick brown fox"))
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel::<BridgeEvent>();
    let (b, _child) = bridge::connect(tx, Default::default()).await.expect("connect");
    b.ui_start(160, 48).await.expect("ui_start");
    b.input(&format!(":edit {}\r", file.display())).await.unwrap();
    b.input(":vsplit\r").await.unwrap();
    b.input(":set filetype=markdown\r").await.unwrap();

    let mut md_winft = false;
    let mut win_pos_grids: HashSet<i64> = HashSet::new();
    let mut resize_grids: HashSet<i64> = HashSet::new();
    let mut line_ops = 0usize;
    let mut viewport_seen = false;
    let mut colors_seen = false;
    let mut frames = 0usize;

    let deadline = tokio::time::Instant::now() + Duration::from_millis(2500);
    while tokio::time::Instant::now() < deadline {
        let Ok(Some(ev)) =
            tokio::time::timeout(Duration::from_millis(300), rx.recv()).await
        else {
            continue;
        };
        match ev {
            BridgeEvent::WinFt { ft, .. } => {
                if ft.contains("markdown") {
                    md_winft = true;
                }
            }
            BridgeEvent::Grid(ops) => {
                frames += 1;
                for o in &ops {
                    let grid = o.get("grid").and_then(|v| v.as_i64());
                    match o.get("op").and_then(|v| v.as_str()) {
                        Some("resize") => {
                            if let Some(g) = grid {
                                resize_grids.insert(g);
                            }
                        }
                        Some("win_pos") => {
                            if let Some(g) = grid {
                                win_pos_grids.insert(g);
                            }
                        }
                        Some("line") => line_ops += 1,
                        Some("viewport") => viewport_seen = true,
                        Some("colors") => colors_seen = true,
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    println!("md_winft={md_winft} frames={frames}");
    println!(
        "resize_grids={resize_grids:?} win_pos_grids={win_pos_grids:?} line_ops={line_ops} viewport={viewport_seen} colors={colors_seen}"
    );

    assert!(frames > 0, "grid frames arrived after ui_start");
    assert!(md_winft, "a window reported filetype markdown");
    assert!(resize_grids.len() >= 2, "outer grid plus at least one window grid");
    assert!(win_pos_grids.len() >= 2, "at least two window grids placed by the vsplit");
    assert!(line_ops > 20, "grid_line ops arrived for the file content");
    assert!(colors_seen, "default_colors_set arrived");
    assert!(viewport_seen, "win_viewport arrived");
}
