//! Spike: verify the multigrid + markdown-island event flow reaches the channel.
//! cargo test --test spike -- --nocapture

use std::collections::HashSet;
use std::time::Duration;

use app_lib::bridge::{self, BridgeEvent};
use tokio::sync::mpsc;

#[tokio::test]
async fn multigrid_island_flow() {
    let (tx, mut rx) = mpsc::unbounded_channel::<BridgeEvent>();
    let (b, _child) = bridge::connect(tx).await.expect("connect");

    let mut md_winft = false;
    // the frontend gets the island's content via the nvim_resync command
    let reset_lines = b.reset().await.map(|p| p.lines.len()).unwrap_or(0);
    let mut win_pos_grids: HashSet<i64> = HashSet::new();
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
                    match o.get("op").and_then(|v| v.as_str()) {
                        Some("win_pos") => {
                            if let Some(g) = o.get("grid").and_then(|v| v.as_i64()) {
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

    println!("md_winft={md_winft} reset_lines={reset_lines} frames={frames}");
    println!(
        "win_pos_grids={win_pos_grids:?} line_ops={line_ops} viewport={viewport_seen} colors={colors_seen}"
    );

    assert!(md_winft, "a window reported filetype markdown");
    assert_eq!(reset_lines, 9, "island buffer is the 9-line welcome text");
    assert!(win_pos_grids.len() >= 2, "at least two window grids placed");
    assert!(line_ops > 20, "grid_line ops arrived for the code window");
    assert!(colors_seen, "default_colors_set arrived");
    assert!(viewport_seen, "win_viewport arrived (island scroll feed)");
}
