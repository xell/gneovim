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

# Where a file opened from outside (Open with, drag to the dock, file
# association) lands. Default "window".
#   "window"   -> a new gui-window with its own Neovim
#   "tab"      -> a new gui-tab (a macOS merged tab) with its own Neovim
#   "nvim-tab" -> a new Neovim tabpage in the last-focused gui-window,
#                 reusing its Neovim (no new window or process)
# "nvim-tab" falls back to "window" when no gui-window is ready to receive the
# file. Multiple files open as that many windows / gui-tabs, or as that many
# Neovim tabpages in the one window.
open_files_in = "window"

# Keyboard shortcut that opens, or brings to the front, the always-on-top
# window (see "Always-on-top window" below). Works even while gneovim is not
# the active app. macOS only. Modifier names joined by "+", ending in a key
# name: cmd/command, ctrl/control, alt/option, shift. An unrecognised value
# logs a warning and falls back to the default.
always_on_top_shortcut = "cmd+ctrl+space"

[markdown]
# Whether a filetype=markdown window renders as a CodeMirror live-preview
# island by default. Overridable per window at runtime (see below). Default
# true.
live_preview_default = true
# Whether a markdown island is published to macOS Accessibility, which is how
# Grammarly Desktop reads and corrects it, by default. Overridable per window
# at runtime with :GrammarlyOn / Off / Toggle. Default true.
grammarly_default = true
# Max width, in CSS pixels, of a markdown island's text column while optimal-
# width mode is on. Default 730.
optimal_width = 730
# Whether a markdown island starts in optimal-width mode (capped to
# optimal_width and centred) rather than filling the window. Overridable per
# window at runtime with :MarkdownOptimalWidthOn / Off / Toggle. Default true.
optimal_width_default = true
# Font stack for a markdown island's body text, prepended in front of the
# built-in stack (Georgia, "Iowan Old Style", Palatino, serif). An actual font
# name or any CSS-compatible font-family notation ("serif", "system-ui", ...)
# both work. Unset by default. Temporarily overridable per window (session
# only) with :MarkdownFontSerif <font>.
font_serif = "Sarasa Term SC Nerd"
# Font stack for a markdown island's headings, prepended in front of a
# built-in sans-serif system stack. Unset by default: headings inherit the
# body serif font, since gneovim gives them no font of their own otherwise.
# Temporarily overridable per window (session only) with
# :MarkdownFontSansSerif <font>.
font_sans_serif = "system-ui"
# Font stack for a markdown island's code spans, code blocks, and gutter,
# prepended in front of the built-in stack (which itself already tracks
# Neovim's own guifont). Unset by default. Temporarily overridable per window
# (session only) with :MarkdownFontMono <font>.
font_mono = "Sarasa Term SC Nerd"
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

## Grammarly in a markdown island

Grammarly Desktop reads a markdown island through macOS Accessibility and
corrects it with posted keys (see `grammarly-markdown-island.md`). Three
commands, available only in gneovim and only for markdown windows, let a window
opt out:

    :GrammarlyOn                 the island is a normal text field for Grammarly
    :GrammarlyOff                the island advertises Grammarly's opt-out
    :GrammarlyToggle
    :Grammarly...!               with a bang: every markdown window in the tabpage

Grammarly Desktop is a separate process; it can only reach the window through
the macOS Accessibility tree. The app publishes its web content there only
while Neovim's cursor is in a markdown island whose flag is on. Everywhere
else, grid windows, the `:` command line, command-line windows (`q:`, `q/`),
and islands whose flag is off, an Accessibility client sees a focused group
with no children and no text, so Grammarly has nothing to attach to and shows
no floating button. Editing, IME, and rendering are untouched; VoiceOver and
dictation only ever see an allowed island, which is the intended trade. The
state lives in `w:gnv_grammarly` (`1` on, `0` off) and `[markdown]
grammarly_default` sets the initial value.

## Optimal width for the live-preview island

Exclusively for the CodeMirror live-preview island: while optimal-width mode
is on, the island's text column is capped to `[markdown] optimal_width` CSS
pixels (default 730) and centred, so a wide window does not force a long
reading line. Below that width the island already fills the window, so the
mode has no visible effect. `[markdown] optimal_width_default` sets whether a
window starts in this mode, and three commands override it per window:

    :MarkdownOptimalWidthOn      capped and centred for the current window
    :MarkdownOptimalWidthOff     current window fills the window, as before
    :MarkdownOptimalWidthToggle
    :MarkdownOptimalWidth...!    with a bang: every markdown window in the tabpage

The state lives in `w:gnv_md_optimal_width` (`1` capped, `0` full width).
Purely a display preference: it does not touch `textwidth`, `wrap`, or buffer
content, and grid (non-island) windows are unaffected.

## Fonts in the live-preview island

`[markdown] font_serif`, `font_sans_serif`, and `font_mono` set the island's
body text, heading, and monospace (code, gutter) fonts respectively. A value
can be an actual font name (`"Sarasa Term SC Nerd"`) or any CSS-compatible
font-family notation (`"serif"`, `"system-ui"`). Each is unset by default:

- `font_serif` unset keeps gneovim's own serif stack (`Georgia, "Iowan Old
  Style", Palatino, serif`).
- `font_sans_serif` unset leaves headings inheriting the body serif font;
  gneovim does not otherwise give headings a font of their own.
- `font_mono` unset keeps the built-in monospace stack, which itself already
  tracks Neovim's own `guifont` when one is set.

A configured value is prepended in front of the built-in stack for its role,
never replacing it, so a misspelled or uninstalled font name is harmless: CSS
simply skips it and falls through to the built-in stack, the same way any
font-family list degrades.

Three commands, each requiring one font-value argument, override a font for
the current window only, for that window's lifetime -- never written back to
`config.toml`, and forgotten once the window closes or the buffer in it
changes:

    :MarkdownFontSerif <font>
    :MarkdownFontSansSerif <font>
    :MarkdownFontMono <font>

Each works only when the current window's `filetype` is `markdown` and
`w:gnv_md_preview` is `1` (an active live-preview island); otherwise it warns
and does nothing. There is no bang form and no per-window state to read back,
unlike the live-preview, Grammarly, and optimal-width flags above.

## Always-on-top window

**File > New Always On Top Window**, or the `[window] always_on_top_shortcut`
keyboard shortcut (default `cmd+ctrl+space`), opens a gui-window like any
other (its own Neovim, `Cmd+N`'s equal) except it is pinned above every other
window, via Tauri's own always-on-top window support. Always-on-top is
independent of visibility: `Cmd+H` still hides it along with the rest of the
app.

Only one such window exists at a time:

- While it is open, the menu item is greyed out and the shortcut does not
  create a second one. Instead, the shortcut brings the existing window to
  the front, unhiding the app first if `Cmd+H` had hidden it.
- Closing it re-enables the menu item and frees the shortcut to create a new
  one.
- Its size and position are remembered (macOS's own window-frame autosave) and
  restored the next time it opens, including across an app restart.

Its embedded Neovim carries `g:gneovim_aot_window = true` (unset in every
other gneovim window), so an `init.lua` or script can branch on running inside
it; see `neovim-api-surface.md`. Being pinned above other windows also takes
it out of `Cmd+\``'s window cycling, which macOS limits to normal-level
windows; the same as any other floating-level window in any Mac app.

The shortcut is a global (Carbon) hot key, registered once at startup and
never released, so it fires even while gneovim is not the active app. The
format is modifier names joined by `+`, ending in one key name:
`cmd`/`command`, `ctrl`/`control`, `alt`/`option`, `shift`, e.g. `cmd+ctrl+space`
or `cmd+alt+shift+a`. macOS only; an unrecognised value logs a warning and
falls back to the default.

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
