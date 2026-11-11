//! `:GneovimFocusSession` against real spawned nvims: the command hands its
//! address to the shell (`BridgeEvent::FocusSession`), `Bridge::serves`
//! matches the nvim at that address and no other, and the UI channel names
//! itself "gneovim", so a config's session picker can tell gneovim from the
//! TUI before choosing between `:connect` and `:GneovimFocusSession`.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use app_lib::bridge::{self, BridgeEvent};
use nvim_rs::{create::tokio as create, rpc::handler::Dummy, Value};
use tokio::sync::mpsc;

async fn settle() {
    tokio::time::sleep(Duration::from_millis(250)).await;
}

fn get<'a>(map: &'a Value, key: &str) -> Option<&'a Value> {
    map.as_map()?
        .iter()
        .find(|(k, _)| k.as_str() == Some(key))
        .map(|(_, v)| v)
}

#[tokio::test]
async fn focus_session_reports_the_address_and_only_its_nvim_serves_it() {
    let (tx, mut rx) = mpsc::unbounded_channel::<BridgeEvent>();
    let asked: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let asked2 = asked.clone();
    tokio::spawn(async move {
        while let Some(e) = rx.recv().await {
            if let BridgeEvent::FocusSession(addr) = e {
                asked2.lock().unwrap().push(addr);
            }
        }
    });

    let (a, _child_a) = bridge::connect(tx, Default::default(), false, false)
        .await
        .expect("connect a");
    let (tx_b, _rx_b) = mpsc::unbounded_channel::<BridgeEvent>();
    let (b, _child_b) = bridge::connect(tx_b, Default::default(), false, false)
        .await
        .expect("connect b");
    a.ui_start(120, 40).await.expect("ui_start");

    // 1. The command reaches the shell with the address it was given (here
    //    a's own, which is what the session picker lists for this window).
    a.input(":exe 'GneovimFocusSession' v:servername\r").await.unwrap();
    settle().await;
    let addr = asked.lock().unwrap().first().cloned().expect("no FocusSession event");
    assert!(!addr.is_empty(), "empty address");

    // 2. Only the nvim listening there claims it.
    assert!(a.serves(&addr).await.unwrap(), "a does not serve its own {addr}");
    assert!(!b.serves(&addr).await.unwrap(), "b claims a's {addr}");
    assert!(!a.serves("/tmp/gnv-no-such-socket").await.unwrap());

    // 3. From outside, as a picker in another session sees it: a's one UI
    //    is on a channel named "gneovim".
    let (probe, _io) = create::new_path(&addr, Dummy::new()).await.expect("probe connect");
    let uis = probe.list_uis().await.expect("nvim_list_uis");
    assert_eq!(uis.len(), 1, "UIs: {uis:?}");
    let chan = get(&uis[0], "chan").and_then(Value::as_i64).expect("UI has no chan");
    let info = Value::Map(probe.get_chan_info(chan).await.expect("nvim_get_chan_info"));
    let name = get(&info, "client").and_then(|c| get(c, "name")).and_then(Value::as_str);
    assert_eq!(name, Some("gneovim"), "chan info: {info:?}");
}
