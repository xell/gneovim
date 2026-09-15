# Neovim API surface

This document specifies the complete set of user commands, autocmd events, and variables that gneovim adds to every embedded Neovim instance for use by a user's own configuration, statusline, or plugin. It is the single reference for that surface; other docs describe individual pieces in the context of a feature (`markdown-island.md`, `markdown-live-preview-plugin-integration.md`, `configuration.md`).

## Scope

Everything listed here is injected by `bridge::connect` via `exec_lua(include_str!(...))` from three files: `src-tauri/src/runtime/md_preview.lua`, `src-tauri/src/runtime/md_decor.lua`, and `src-tauri/src/runtime/open_in_new_tab.lua`. These files carry a header comment stating they are GUI protocol glue, not a user plugin, so this document draws the line explicitly: anything a user's init file, statusline, or autocmd could reasonably reference is in scope; the RPC notification channel between the embedded Neovim and the Tauri shell (`gnv_md_preview`, `gnv_cursor`, `gnv_win_gutter`, and similar `rpcnotify` payload names) is not, since it exists only between `bridge.rs` and these Lua files and is never meant to be read from Neovim configuration. `config.toml` options are enumerated below for reference, but `configuration.md` is the authoritative doc for loading and behaviour detail.

Each item below is a stable, intentional contract. Unlisted globals, augroup names, or buffer variables that happen to appear in the source are implementation detail and may change without notice.

## User commands

### `:MarkdownLivePreviewOn`, `:MarkdownLivePreviewOff`, `:MarkdownLivePreviewToggle`

Switch a markdown window between the CodeMirror island and ordinary grid rendering. Without a bang, the command affects only the current window. With a bang (`:MarkdownLivePreviewOn!`, and so on), it affects every markdown window in the current tabpage. A window is eligible only when its buffer's `filetype` is `markdown` and the window is not a floating window; running the command elsewhere reports a warning and does nothing.

### `:GrammarlyOn`, `:GrammarlyOff`, `:GrammarlyToggle`

Control whether a markdown island's web content is exposed to Grammarly Desktop's accessibility scan. The same current window and bang for every markdown window in the tabpage shape as the live preview commands applies. When off, the island carries the `data-gramm="false"` and `data-enable-grammarly="false"` attributes and is additionally hidden from the accessibility tree.

### `:MarkdownOptimalWidthOn`, `:MarkdownOptimalWidthOff`, `:MarkdownOptimalWidthToggle`

Switch a markdown island between a centred, width-capped text column and filling the window. The same current-window / bang-affects-every-markdown-window-in-the-tabpage shape as the other two command families applies. The cap is `[markdown] optimal_width` CSS pixels (default 730); below that width the island already fills the window, so toggling this has no visible effect. Purely a display preference: it only changes the width CodeMirror wraps and lays out against, not `textwidth`, `wrap`, or buffer content, and it has no effect on grid (non-island) windows.

### `:GneovimResyncIsland`

Forces a full resync of every markdown island in the current Neovim instance: reapplies `foldlevel` in each markdown window, drops the per window highlight cache and repushes it synchronously, and tells the client to reattach every island from a fresh buffer snapshot. Intended as a blunt escape hatch for a display desync (see `markdown-island-fold-desync.md`), not a scalpel; it takes no window argument and no bang.

### `:OpenInNewGneovimTab [file ...]`

With no arguments, moves the current buffer into a fresh gui tab: writes it first if it is a modified file buffer, or carries its text across if it has no name, then wipes it from the current session. With one or more file arguments, opens a fresh gui tab with each file in its own Neovim tabpage, leaving the current session untouched. Arguments accept quoted paths with spaces and complete as files.

The same operation is available to scripts as `_G.OpenInNewGneovimTab(files)`, called with a path, a list of paths, or `nil` for the move the current buffer behavior. It returns `false` only when a required write failed, in which case nothing was moved.

## Autocmd events

### `User GneovimMarkdownPreviewChanged`

Fired whenever a markdown window's live preview state actually changes, whether from a `:MarkdownLivePreview*` command or from gneovim materializing its default state on a freshly recognized markdown window. It is not fired when a command repeats the state already in effect.

```lua
vim.api.nvim_create_autocmd("User", {
  pattern = "GneovimMarkdownPreviewChanged",
  callback = function(event)
    -- event.data.win: Neovim window id
    -- event.data.buf: buffer id
    -- event.data.preview: true when the window entered the CodeMirror island, false when it returned to the grid
  end,
})
```

This is gneovim's designated integration point for plugins that draw their own extmarks, conceal, or virtual text, since those can be redundant or visually incompatible with the island. Gneovim does not know, load, configure, or depend on any such plugin; it only emits this generic signal. See `markdown-live-preview-plugin-integration.md` for worked examples against `nvim-ibl` and `render-markdown.nvim`, including the buffer scope caveat: `w:gnv_md_preview` is window local, but a plugin that stores decorations as buffer extmarks with buffer scoped enablement needs the union of every visible window for that buffer, not just the one that changed.

A listener that errors is reported through `vim.notify` as a warning; the preview transition itself is not undone.

## Window variables

### `w:gnv_md_preview`

Present on a window while it is recognized as a markdown window: `1` while it renders as a CodeMirror island, `0` while it renders as an ordinary grid. Absent on a window that is not currently a markdown window. This is the single source of truth for "is this window an island" and is safe to read from a statusline or a script.

### `w:gnv_grammarly`

Present on a markdown window with the same lifecycle as `w:gnv_md_preview`: `1` while Grammarly can see the island's content, `0` while opted out, absent when the window is not a markdown window.

### `w:gnv_md_optimal_width`

Present on a markdown window with the same lifecycle as `w:gnv_md_preview`: `1` while the island's text column is capped to `[markdown] optimal_width` and centred, `0` while it fills the window, absent when the window is not a markdown window.

All three variables are gneovim's output, not input. Setting one directly does not change behavior; use the corresponding command.

## Global variables

### `g:gneovim`

`true` in every Neovim instance embedded by gneovim, and unset otherwise. The standard presence check for "is this Neovim running under gneovim", most usefully read from a `UIEnter` autocmd or later, since it is set before the GUI attaches.

### `g:gneovim_version`

Gneovim's own version string, for configuration that needs to branch on a minimum version.

## `config.toml` options

Every key is optional; see `configuration.md` for the file's location, reload policy, and behaviour detail. Listed here purely for a single at-a-glance reference of what exists and what it defaults to.

### `[neovim]`

- `path` (string, unset) — explicit path to the `nvim` binary; auto-detected if unset or not a file.
- `config` (string, `"none"`) — which init to load: `"none"` (bare `-u NONE`), `"user"` (your `~/.config/nvim`), or a path to an `init.lua`.
- `args` (string, `""`) — extra `nvim` arguments, whitespace-split.

### `[input]`

- `option_is_meta` (bool, `true`) — macOS Option reaches Neovim as `<M-...>` instead of composing an accented character.
- `block_ime_in_normal_mode` (bool, `true`) — a markdown island is non-editable outside insert/replace mode, so an IME cannot hijack a normal-mode key.
- `forward_cmd_keys` (bool, `false`) — forward Cmd+`<key>` to Neovim as `<D-...>`.

### `[window]`

- `confirm_quit` (bool, `true`) — confirm before Cmd+Q quits the app.
- `confirm_close` (bool, `true`) — confirm before Cmd+W closes a gui-window or gui-tab.
- `open_files_in` (string, `"window"`) — where an externally opened file lands: `"window"`, `"tab"`, or `"nvim-tab"`.

### `[markdown]`

- `live_preview_default` (bool, `true`) — a `filetype=markdown` window starts as a CodeMirror live-preview island; see `:MarkdownLivePreviewOn` / `Off` / `Toggle`.
- `grammarly_default` (bool, `true`) — a markdown island is exposed to Grammarly Desktop by default; see `:GrammarlyOn` / `Off` / `Toggle`.
- `optimal_width` (number, `730`) — max width, in CSS pixels, of a markdown island's text column while optimal-width mode is on.
- `optimal_width_default` (bool, `true`) — a markdown island starts in optimal-width mode (capped and centred) rather than filling the window; see `:MarkdownOptimalWidthOn` / `Off` / `Toggle`.

## Client identification

Gneovim also calls `nvim_set_client_info("gneovim", {major, minor, patch}, "ui", {}, {})` on startup, so `nvim_get_chan_info` on the UI channel reports gneovim's identity and parsed version as an alternative to reading `g:gneovim` and `g:gneovim_version` directly.

## Stability

The commands, the `User GneovimMarkdownPreviewChanged` event and its data shape, and the three window variables are the parts of this surface most directly exercised by the plugin integration examples in `markdown-live-preview-plugin-integration.md`, and are treated as a public contract: changing them is a breaking change for any configuration built against this document. The global variables and client info are additive and expected to remain stable as well. Everything named in the Scope section as internal detail (RPC payload names, augroup names) is free to change independently of this document. The `config.toml` enumeration above is a reference snapshot, not a contract: keys, defaults, and accepted values may change; `configuration.md` reflects the current behaviour.
