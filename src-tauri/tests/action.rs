//! `gneovim://action/<name>` against a real spawned nvim: `Bridge::action`
//! fires `User GneovimAction` with the name only once the UI has attached (a
//! freshly spawned window), and a `nested = true` handler's new window reaches
//! the GUI, so a Markdown file it opens can become an island.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use app_lib::bridge::{self, BridgeEvent};
use tokio::sync::mpsc;

async fn settle() {
    tokio::time::sleep(Duration::from_millis(250)).await;
}

#[tokio::test]
async fn action_waits_for_the_ui_and_its_handler_can_open_windows() {
    std::fs::write("/tmp/gnv-action-test.md", "# hello\n").unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel::<BridgeEvent>();
    let markdown_wins: Arc<Mutex<Vec<i64>>> = Arc::new(Mutex::new(Vec::new()));
    let markdown_wins2 = markdown_wins.clone();
    tokio::spawn(async move {
        while let Some(e) = rx.recv().await {
            if let BridgeEvent::WinFt(p) = e {
                if p.ft == "markdown" {
                    markdown_wins2.lock().unwrap().push(p.win);
                }
            }
        }
    });

    let (b, _child) = bridge::connect(tx, Default::default(), false, false).await.expect("connect");
    // Stands in for a handler in the user's config (which connect() loads
    // too), under a name no real handler answers to.
    b.input(
        ":lua vim.api.nvim_create_autocmd('User', { pattern = 'GneovimAction', nested = true, \
         callback = function(ev) if ev.data.name == 'gnv-test' then \
         vim.cmd('silent noswapfile tabedit /tmp/gnv-action-test.md') end end })\r",
    )
    .await
    .unwrap();
    settle().await;

    // 1. A freshly spawned window: the bridge is ready but no UI is attached,
    //    so the handler must not run yet.
    b.action("gnv-test").await.expect("action");
    settle().await;
    assert!(
        markdown_wins.lock().unwrap().is_empty(),
        "handler ran before the UI attached: {:?}",
        markdown_wins.lock().unwrap()
    );

    // 2. Once the UI attaches it runs, and the tabpage it opened reports its
    //    window (WinNew / BufWinEnter, which only fire for a nested handler).
    b.ui_start(120, 40).await.expect("ui_start");
    settle().await;
    assert!(
        !markdown_wins.lock().unwrap().is_empty(),
        "no markdown window reported after the UI attached"
    );
}
