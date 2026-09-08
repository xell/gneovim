pub mod bridge;
pub mod config;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use bridge::{Bridge, BridgeEvent, Region, ResetPayload};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{
    async_runtime, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tokio::process::Child;

/// One nvim + one webview per gui-window. macOS window tabbing groups the
/// windows visually; it never shares an nvim.
#[derive(Default)]
struct AppState {
    windows: Mutex<HashMap<String, WindowBridge>>,
    last_focused: Mutex<Option<String>>,
}

struct WindowBridge {
    bridge: Bridge,
    /// Held so nvim is killed (`kill_on_drop`) when the window's entry is removed.
    _child: Child,
}

static NEXT_LABEL: AtomicU64 = AtomicU64::new(1);

fn next_label() -> String {
    format!("gnv-{}", NEXT_LABEL.fetch_add(1, Ordering::SeqCst))
}

/// Make `child` a tab of `parent`'s tab group, regardless of the system
/// "prefer tabs" setting. Both windows must share a tabbing identifier.
#[cfg(target_os = "macos")]
fn add_as_tab(parent: &tauri::WebviewWindow, child: &tauri::WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let p = match parent.ns_window() {
        Ok(p) if !p.is_null() => p as *mut AnyObject,
        _ => return,
    };
    let c = match child.ns_window() {
        Ok(c) if !c.is_null() => c as *mut AnyObject,
        _ => return,
    };
    // -[NSWindow addTabbedWindow:ordered:], NSWindowAbove == 1
    unsafe {
        let _: () = msg_send![p, addTabbedWindow: c, ordered: 1isize];
    }
}

/// Set the NSWindow corner radius to match macOS 26's new design language (~26 pt).
/// Uses the long-standing private `_setCornerRadius:` selector, which remains
/// valid on macOS 26; the OS takes care of fullscreen and tab-bar junctions.
#[cfg(target_os = "macos")]
fn apply_corner_radius(win: &tauri::WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;

    let ns_win = match win.ns_window() {
        Ok(p) if !p.is_null() => p as *mut AnyObject,
        _ => return,
    };
    unsafe {
        let _: () = msg_send![ns_win, _setCornerRadius: 26.0_f64];
    }
}


/// x of the close-button frame origin, in points. AppKit's default is ~7; we
/// shift the whole cluster right a touch so it clears the 26 pt corner
/// (close-button centre then sits ~22 pt from the edge).
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_X: f64 = 15.0;

/// Shift the traffic-light buttons rightward so they sit inside the macOS 26
/// corner radius. The inter-button gap chosen by AppKit is preserved.
/// Must be called on the main thread. Re-called on every `Resized` event and
/// after tab grouping so AppKit's own layout pass cannot override our positions.
#[cfg(target_os = "macos")]
fn apply_traffic_light_inset(win: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSView, NSWindow, NSWindowButton};

    let ptr = match win.ns_window() {
        Ok(p) if !p.is_null() => p,
        _ => return,
    };
    // Safety: Tauri hands us a valid, live NSWindow pointer.
    let ns_win: &NSWindow = unsafe { &*(ptr as *const NSWindow) };

    let Some(close) = ns_win.standardWindowButton(NSWindowButton::CloseButton) else {
        return;
    };
    let Some(mini) = ns_win.standardWindowButton(NSWindowButton::MiniaturizeButton) else {
        return;
    };
    let zoom = ns_win.standardWindowButton(NSWindowButton::ZoomButton);

    // Keep the gap AppKit chose between buttons (typically ~20 pt).
    let close_rect = NSView::frame(&close);
    let mini_rect = NSView::frame(&mini);
    let gap = mini_rect.origin.x - close_rect.origin.x;

    let mut buttons = vec![close, mini];
    if let Some(z) = zoom {
        buttons.push(z);
    }

    for (i, btn) in buttons.into_iter().enumerate() {
        let mut rect = NSView::frame(&btn);
        rect.origin.x = TRAFFIC_LIGHT_X + i as f64 * gap;
        NSView::setFrameOrigin(&btn, rect.origin);
    }
}

/// Re-assert the traffic-light inset on the next runloop tick, after AppKit has
/// laid out a change it does asynchronously (tab bar appearing/disappearing).
#[cfg(target_os = "macos")]
fn apply_traffic_light_inset_deferred(win: tauri::WebviewWindow) {
    async_runtime::spawn(async move {
        for delay in [16u64, 120] {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            let w = win.clone();
            let _ = win.run_on_main_thread(move || apply_traffic_light_inset(&w));
        }
    });
}

/// Create a gui-window with its own nvim. `as_tab` adds it to the focused
/// window's tab group (macOS); otherwise it is a standalone window.
fn spawn_window(app: &AppHandle, as_tab: bool) -> Option<String> {
    let _ = as_tab;
    #[cfg(target_os = "macos")]
    let parent: Option<tauri::WebviewWindow> = if as_tab {
        let last = app.state::<AppState>().last_focused.lock().unwrap().clone();
        last.and_then(|l| app.get_webview_window(&l))
            .or_else(|| {
                app.webview_windows()
                    .into_values()
                    .find(|w| w.is_focused().unwrap_or(false))
            })
            .or_else(|| app.webview_windows().into_values().next())
    } else {
        None
    };

    let label = next_label();
    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("gneovim")
        .inner_size(1100.0, 750.0)
        .min_inner_size(480.0, 360.0);
    #[cfg(target_os = "macos")]
    let builder = builder.tabbing_identifier("gneovim").visible(!as_tab);

    let win = match builder.build() {
        Ok(w) => w,
        Err(e) => {
            log::error!("new window: {e}");
            return None;
        }
    };

    #[cfg(target_os = "macos")]
    apply_corner_radius(&win);
    #[cfg(target_os = "macos")]
    apply_traffic_light_inset(&win);

    #[cfg(target_os = "macos")]
    if as_tab {
        match &parent {
            Some(p) => {
                log::info!("new tab: grouping with {}", p.label());
                add_as_tab(p, &win);
                let _ = win.show();
                // The tab bar now appears on both windows; AppKit re-lays out
                // the traffic lights asynchronously, so re-assert the inset.
                apply_traffic_light_inset_deferred(win.clone());
                apply_traffic_light_inset_deferred(p.clone());
            }
            None => {
                log::warn!("new tab: no parent window, opening standalone");
                let _ = win.show();
            }
        }
    }

    spawn_bridge(app.clone(), label.clone());
    Some(label)
}

/// Connect a fresh nvim for `label` and stream its events to that window alone.
fn spawn_bridge(app: AppHandle, label: String) {
    async_runtime::spawn(async move {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<BridgeEvent>();

        let emit_app = app.clone();
        let emit_label = label.clone();
        async_runtime::spawn(async move {
            // Per-window event names: emit_to() has proven to broadcast to every
            // webview in this setup, so window A's nvim stream rendered in every
            // window. A plain global emit with a label-qualified name is scoped
            // by the name alone.
            let ev = |kind: &str| format!("gnv://{emit_label}/{kind}");
            while let Some(bev) = rx.recv().await {
                let r = match bev {
                    BridgeEvent::Reset(p) => emit_app.emit(&ev("reset"), p),
                    BridgeEvent::Lines(p) => emit_app.emit(&ev("lines"), p),
                    BridgeEvent::Cursor(p) => emit_app.emit(&ev("cursor"), p),
                    BridgeEvent::Cmdline(p) => emit_app.emit(&ev("cmdline"), p),
                    BridgeEvent::CmdlineHide => emit_app.emit(&ev("cmdline_hide"), ()),
                    BridgeEvent::Grid(ops) => emit_app.emit(&ev("grid"), ops),
                    BridgeEvent::WinFt { win, buf, ft } => emit_app.emit(
                        &ev("winft"),
                        serde_json::json!({"win":win,"buf":buf,"ft":ft}),
                    ),
                };
                if let Err(e) = r {
                    log::warn!("emit for {emit_label}: {e}");
                }
            }
        });

        match bridge::connect(tx).await {
            Ok((bridge, child)) => {
                app.state::<AppState>().windows.lock().unwrap().insert(
                    label.clone(),
                    WindowBridge {
                        bridge,
                        _child: child,
                    },
                );
                log::info!("bridge ready for window {label}");
            }
            Err(e) => log::error!("bridge failed for window {label}: {e}"),
        }
    });
}

/// The bridge for `label`, waiting out the async connect if the webview raced it.
async fn bridge_for(app: &AppHandle, label: &str) -> Result<Bridge, String> {
    for _ in 0..100 {
        let b = app
            .state::<AppState>()
            .windows
            .lock()
            .unwrap()
            .get(label)
            .map(|w| w.bridge.clone());
        if let Some(b) = b {
            return Ok(b);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err(format!("no bridge for window {label}"))
}

#[tauri::command]
async fn nvim_input(app: AppHandle, window: tauri::Window, keys: String) -> Result<(), String> {
    bridge_for(&app, window.label()).await?.input(&keys).await
}

#[tauri::command]
async fn nvim_cursor_set(
    app: AppHandle,
    window: tauri::Window,
    win: i64,
    row: i64,
    col: i64,
) -> Result<(), String> {
    bridge_for(&app, window.label())
        .await?
        .cursor_set(win, row, col)
        .await
}

#[tauri::command]
async fn nvim_edit(
    app: AppHandle,
    window: tauri::Window,
    buf: i64,
    regions: Vec<Region>,
) -> Result<(), String> {
    bridge_for(&app, window.label()).await?.edit(buf, regions).await
}

#[tauri::command]
async fn nvim_mouse(
    app: AppHandle,
    window: tauri::Window,
    button: String,
    action: String,
    modifier: String,
    row: i64,
    col: i64,
) -> Result<(), String> {
    bridge_for(&app, window.label())
        .await?
        .input_mouse(&button, &action, &modifier, row, col)
        .await
}

#[tauri::command]
async fn island_attach(
    app: AppHandle,
    window: tauri::Window,
    win: i64,
) -> Result<ResetPayload, String> {
    bridge_for(&app, window.label()).await?.island_attach(win).await
}

#[tauri::command]
async fn island_detach(
    app: AppHandle,
    window: tauri::Window,
    buf: i64,
) -> Result<(), String> {
    bridge_for(&app, window.label()).await?.island_detach(buf).await
}

#[tauri::command]
async fn nvim_resize(
    app: AppHandle,
    window: tauri::Window,
    cols: i64,
    rows: i64,
) -> Result<(), String> {
    bridge_for(&app, window.label()).await?.resize(cols, rows).await
}

#[tauri::command]
async fn nvim_redraw(app: AppHandle, window: tauri::Window) -> Result<(), String> {
    bridge_for(&app, window.label()).await?.redraw().await
}

#[tauri::command]
async fn nvim_ui_start(
    app: AppHandle,
    window: tauri::Window,
    cols: i64,
    rows: i64,
) -> Result<(), String> {
    bridge_for(&app, window.label())
        .await?
        .ui_start(cols, rows)
        .await
}

/// Bridge the webview console into the app log (spike debugging aid).
#[tauri::command]
fn js_log(msg: String) {
    log::info!("[webview] {msg}");
}

/// The parsed user config, for the frontend (key handling, fonts, ...).
#[tauri::command]
fn gnv_config() -> &'static config::Config {
    config::get()
}

#[tauri::command]
async fn nvim_winfts(
    app: AppHandle,
    window: tauri::Window,
) -> Result<Vec<(i64, i64, String)>, String> {
    bridge_for(&app, window.label()).await?.win_fts().await
}

#[tauri::command]
async fn new_window(app: AppHandle) -> Result<(), String> {
    spawn_window(&app, false);
    Ok(())
}

#[tauri::command]
async fn new_tab(app: AppHandle) -> Result<(), String> {
    spawn_window(&app, true);
    Ok(())
}

/// `Menu::default` plus New Window / New Tab in the File submenu.
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let new_window = MenuItem::with_id(
        app,
        "gnv:new_window",
        "New Window",
        true,
        Some("CmdOrCtrl+N"),
    )?;
    let new_tab = MenuItem::with_id(app, "gnv:new_tab", "New Tab", true, Some("CmdOrCtrl+T"))?;
    let sep = PredefinedMenuItem::separator(app)?;
    for kind in menu.items()? {
        if let Some(sub) = kind.as_submenu() {
            if sub.text().is_ok_and(|t| t == "File") {
                sub.insert_items(&[&new_window, &new_tab, &sep], 0)?;
            }
        }
    }
    Ok(menu)
}

async fn open_paths(app: AppHandle, paths: Vec<String>) {
    for path in paths {
        let Some(label) = spawn_window(&app, false) else {
            continue;
        };
        if let Ok(b) = bridge_for(&app, &label).await {
            let _ = b.open_file(&path).await;
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .level_for("nvim_rs", log::LevelFilter::Warn)
                .build(),
        )
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            nvim_input,
            nvim_cursor_set,
            nvim_edit,
            nvim_mouse,
            island_attach,
            island_detach,
            nvim_resize,
            nvim_redraw,
            nvim_ui_start,
            js_log,
            gnv_config,
            nvim_winfts,
            new_window,
            new_tab
        ])
        .menu(|handle| build_menu(handle))
        .on_menu_event(|app, event| match event.id().as_ref() {
            "gnv:new_window" => {
                spawn_window(app, false);
            }
            "gnv:new_tab" => {
                spawn_window(app, true);
            }
            _ => {}
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Destroyed => {
                if let Some(state) = window.try_state::<AppState>() {
                    state.windows.lock().unwrap().remove(window.label());
                    log::info!("window {} closed", window.label());
                }
                // Closing a tab can collapse a group's tab bar; AppKit then
                // re-lays out the other windows' traffic lights.
                #[cfg(target_os = "macos")]
                for w in window.app_handle().webview_windows().into_values() {
                    apply_traffic_light_inset_deferred(w);
                }
            }
            WindowEvent::Focused(true) => {
                if let Some(state) = window.try_state::<AppState>() {
                    *state.last_focused.lock().unwrap() = Some(window.label().to_string());
                }
                // Poke the webview over the same IPC path that gnv://.../grid
                // uses (which is why V+move repaints a revealed tab).
                let _ = window
                    .app_handle()
                    .emit(&format!("gnv://{}/focus", window.label()), ());
                #[cfg(target_os = "macos")]
                if let Some(win) = window.app_handle().get_webview_window(window.label()) {
                    apply_traffic_light_inset(&win);
                    apply_traffic_light_inset_deferred(win);
                }
            }
            #[cfg(target_os = "macos")]
            WindowEvent::Resized(_) => {
                if let Some(win) = window.app_handle().get_webview_window(window.label()) {
                    apply_traffic_light_inset(&win);
                }
            }
            _ => {}
        })
        .setup(|app| {
            spawn_bridge(app.handle().clone(), "main".to_string());
            #[cfg(target_os = "macos")]
            if let Some(win) = app.get_webview_window("main") {
                apply_corner_radius(&win);
                apply_traffic_light_inset(&win);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = &_event {
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                if !paths.is_empty() {
                    async_runtime::spawn(open_paths(_app.clone(), paths));
                }
            }
        });
}
