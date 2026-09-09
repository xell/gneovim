# Configuration

gneovim reads an optional TOML file at:

```
${XDG_CONFIG_HOME:-~/.config}/gneovim/config.toml
```

The file is loaded once at startup. Changing it needs an app restart. A missing file is fine (defaults apply). A malformed file, or a value that does not resolve, logs a warning and falls through to the default behaviour; it never stops the app from launching.

## Schema

Every key is optional.

```toml
[neovim]
# Path to the nvim binary to run. A leading ~/ is expanded to $HOME.
# If unset or not a file, gneovim auto-detects (see below).
path = "~/.local/share/bob/nvim-bin/nvim"

# Which init to load. Default is "none".
#   "none"              -> nvim runs with -u NONE (a bare nvim, no plugins)
#   "user"              -> no -u flag; nvim loads ~/.config/nvim as normal
#   "~/path/to/init.lua" -> nvim runs with -u <that path>
config = "user"

# Extra arguments passed verbatim to nvim at startup, split on whitespace.
# For flags not covered by path / config. Default "".
args = ""

[input]
# Treat macOS Option as Meta: Option+<key> reaches Neovim as <M-...> instead of
# composing accented characters (é, •, …). Default true.
option_is_meta = true

# Make a markdown island non-editable outside insert/replace mode, so an input
# method cannot hijack normal-mode keys (a CJK IME turning `j` into a syllable).
# Neovim's own edits still render. Default true.
block_ime_in_normal_mode = true

# Forward Cmd+<key> to Neovim as <D-...>. Default false: on macOS Cmd is the
# app/menu modifier, and forwarding it collides with menu shortcuts (Cmd+N, ...).
# Enable if you have <D-...> mappings.
forward_cmd_keys = false

[window]
# Confirm before Cmd+Q quits the app, even with nothing unsaved. Quitting
# destroys every gui-window's Neovim (all its tabs and splits). Default true.
confirm_quit = true

# Confirm before Cmd+W closes a gui-window or gui-tab, even with nothing
# unsaved. Default true.
confirm_close = true

[markdown]
# Whether a filetype=markdown window renders as a CodeMirror live-preview
# island by default. Overridable per window at runtime (see below). Default
# true.
live_preview_default = true
```

## Markdown live preview

A `filetype=markdown` window renders as a CodeMirror island; every other window
renders from Neovim's grid. `[markdown] live_preview_default` sets the default,
and three user commands (created automatically in any nvim gneovim spawns)
override it per window:

    :MarkdownLivePreviewOn       island for the current window
    :MarkdownLivePreviewOff      current window back to grid rendering
    :MarkdownLivePreviewToggle
    :MarkdownLivePreview...!     with a bang: every markdown window in the tabpage

The state lives in `w:gnv_md_preview` (`1` preview, `0` grid), so two splits of
the *same* markdown file can differ, and you can read the flag from a statusline
or a script. gneovim also sets `g:gneovim` and registers itself via
`nvim_set_client_info`; check `vim.g.gneovim` from a `UIEnter` autocmd (it is
not set yet when `init.lua` first runs).

## Closing and quitting

Cmd+W (close a gui-window or gui-tab) and Cmd+Q (quit) are intercepted so a
window with unsaved changes is never silently killed:

- If any buffer is modified or a `:terminal` job is still running, a warning
  dialog lists them. Cmd+Q's dialog also has a **Review** button that focuses
  the first affected window.
- Otherwise, `[window] confirm_quit` / `confirm_close` decide whether a plain
  "are you sure" dialog appears first (it shows the session's tab / window /
  buffer counts). Set them to `false` for the fast path.

A confirmed or unblocked close runs `:qall` so ShaDa and `VimLeave` autocommands
run; only a leftover hang is force-killed (after 3s).

## Loading your Neovim config

By default gneovim runs `nvim -u NONE`, so your `~/.config/nvim` is not read. This keeps the renderer working against a predictable nvim while it is still being built. Set `config = "user"` to load your real config.

`config` also decides how much of the session gneovim owns:

- `config = "none"` (the default): a throwaway session. gneovim adds `-i NONE` (no ShaDa) and forces `set background=light`.
- `config = "user"` or a path: your session. Default ShaDa is used, so command-line history (`q:`), search history, marks, registers, and `:oldfiles` work like terminal nvim. `background`, colorscheme, and filetype detection are left to your config.

The full launch line is `nvim --embed --headless` then the `config` args, then the ShaDa args, then `args`. gneovim also forces `mouse=a` at startup (the GUI feeds mouse events through `nvim_input_mouse`); everything else, including swap files and filetype detection, is up to your config or `args`.

Caveat: the renderer is not finished. A full config (a colorscheme, statusline plugins, treesitter, LSP, render-markdown and similar) will exercise parts of the renderer that are still rough, so expect visual glitches.

## Shell environment

Launched from Finder, Dock, or Spotlight, a macOS app inherits a minimal `launchd` environment: `PATH` is roughly `/usr/bin:/bin:/usr/sbin:/sbin` and none of your shell startup files have run. Neovim would then fail to find LSP servers, formatters, `rg` / `fd`, `node`, and anything else installed by Homebrew or a version manager, and `:echo $PATH` would look nothing like a terminal.

gneovim fixes this: on first launch it runs your login shell once (`$SHELL -ilc`), captures the resulting environment, and applies it to the spawned nvim. The result is cached for the life of the app. It is skipped automatically when `PATH` already looks like an interactive one (contains your home directory or a Homebrew prefix), which is the case under `npm run tauri dev`. Set `GNV_NO_SHELL_ENV` to disable it entirely.

The nested-nvim markers (`NVIM`, `NVIM_LISTEN_ADDRESS`, `VIM`, `VIMRUNTIME`, `MYVIMRC`, `VIMINIT`) are dropped from the imported set so launching gneovim from inside a `:terminal` does not confuse the child.

## How the nvim binary is chosen

In order, first hit wins:

1. the `GNV_NVIM` environment variable, if set and non-empty (used by tests and CI, and handy for a one-off override)
2. `neovim.path` from the config file, after `~/` expansion, if it points at a file
3. common absolute locations: `/opt/homebrew/bin/nvim`, `/usr/local/bin/nvim`, `~/.local/share/bob/nvim-bin/nvim`, `~/.local/bin/nvim`, `/opt/nvim/bin/nvim`, `/usr/bin/nvim`
4. `$SHELL -lc "command -v nvim"`, which sources your real `PATH`
5. bare `nvim`, relying on the process `PATH` (which by then carries the imported login-shell environment, see above)

If `neovim.path` is set but does not resolve, gneovim logs `config: neovim.path = ... is not a file, falling back to auto-detection` and continues down the list.
