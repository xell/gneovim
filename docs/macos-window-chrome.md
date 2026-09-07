# macOS window chrome: corner radius and traffic-light inset

Describes the two adjustments made to match macOS 26's (Tahoe) new window
design language, and why each step is necessary. All code lives in
`src-tauri/src/lib.rs`.

---

## 1. Corner radius — `apply_corner_radius`

### Problem

macOS 26 ships with a larger window corner radius (~26 pt) across all native
apps (Finder, Safari, Terminal, …). A plain Tauri window gets the system
default, which on earlier releases was around 9 pt. Without intervention the
window looks visually mismatched on macOS 26.

### Approach

Call the long-standing private `NSWindow` selector `_setCornerRadius:` via
`objc2::msg_send!`:

```
ns_window._setCornerRadius(26.0)
```

This selector has been stable since at least macOS 10.10. On macOS 26 it is
the direct implementation of the newly public `NSWindow.cornerRadius` property,
so it continues to work there with no changes needed.

The call is made right after `WebviewWindowBuilder::build()` for every new
window and tab, and once more in `setup` for the initial `"main"` window that
is created from `tauri.conf.json` before `setup` runs.

### Why nothing extra is needed for fullscreen and tabs

AppKit drops the corner radius to 0 automatically when a window enters
fullscreen (because the window fills the screen). When it returns to windowed
mode, the system restores the radius. Because we set the radius on the
`NSWindow` object itself and not on a layer mask, AppKit's own state machine
takes care of those transitions — the same way it does for Finder and Safari.
For tabbed windows the radius is applied to each individual `NSWindow`; the tab
bar junction is drawn by the system's tab container above the frame, and it is
unaffected.

---

## 2. Traffic-light inset — `apply_traffic_light_inset`

### Problem

With a 26 pt corner radius the standard traffic-light button positions (close
button centre at ~15 pt from the left edge on macOS 15) sit uncomfortably close
to the curved corner. On macOS 26 native apps the buttons are shifted rightward
so their centres sit at approximately **20 pt, 40 pt, 60 pt** from the left
edge. A Tauri window does not get this shift automatically because AppKit only
applies it to windows whose frame view participates in the new layout system;
WKWebView-hosted windows need an explicit nudge.

### Approach

Uses fully typed `objc2-app-kit` bindings (the same crate WRY uses internally).
The algorithm, which mirrors WRY's own `inset_traffic_lights`, is:

1. **Get the three standard buttons** from the `NSWindow`:
   ```
   NSWindow::standardWindowButton(CloseButton)
   NSWindow::standardWindowButton(MiniaturizeButton)
   NSWindow::standardWindowButton(ZoomButton)     // may be None
   ```

2. **Read the live inter-button gap** from AppKit's own layout, rather than
   hardcoding it. The gap (close-button origin → miniaturize-button origin) is
   typically ~20 pt but could differ in future macOS versions:
   ```
   gap = frame(miniaturize).origin.x − frame(close).origin.x
   ```

3. **Set new x origins**, keeping y (the vertical position inside the title bar
   container) exactly as AppKit placed it:
   ```
   for i, button in [close, miniaturize, zoom]:
       rect        = NSView::frame(button)
       rect.origin.x = 13.0 + i × gap
       NSView::setFrameOrigin(button, rect.origin)
   ```
   `x = 13 pt` puts the close button's centre at 20 pt from the left edge.
   Miniaturize and zoom follow at 40 pt and 60 pt respectively.

The title text is centred by AppKit within whatever horizontal space remains
after the traffic lights, so it moves naturally without any extra code.

### Why re-apply on every resize

`NSThemeFrame` (the private AppKit class that contains the traffic lights) runs
its own layout pass on every window resize, which resets button origins back to
the system default. To survive this, `apply_traffic_light_inset` is also called
from `on_window_event(WindowEvent::Resized)`. That event fires on the main
thread after AppKit has finished its layout pass, so the override happens before
the next screen refresh — no visual flicker.

### Dependency

`objc2-app-kit = "0.3"` is declared as a `[target.'cfg(target_os = "macos")'.dependencies]`
entry with the minimal feature set needed:

```toml
objc2-app-kit = { version = "0.3", default-features = false, features = [
    "std",
    "objc2-core-foundation",   # CGPoint / CGRect / CGFloat for frame methods
    "NSButton",                # return type of standardWindowButton
    "NSControl",               # NSButton's parent; Deref chain
    "NSResponder",             # NSControl's parent; Deref chain
    "NSView",                  # frame() and setFrameOrigin()
    "NSWindow",                # NSWindow class + NSWindowButton enum
] }
```

The crate was already compiled as a transitive dependency of `tauri-runtime-wry`
before it was added here, so it imposes no extra build cost.

---

## Call sites

| Location | Reason |
|---|---|
| `spawn_window`, after `build()` | Every new standalone window or tab |
| `setup`, for label `"main"` | Initial window from `tauri.conf.json` |
| `on_window_event(Resized)` | Re-assert after each AppKit layout pass |

Both functions are gated `#[cfg(target_os = "macos")]` and are no-ops on other
platforms.
