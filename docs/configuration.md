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
```

## Loading your Neovim config

By default gneovim runs `nvim -u NONE`, so your `~/.config/nvim` is not read. This keeps the renderer working against a predictable nvim while it is still being built. Set `config = "user"` to load your real config.

Two caveats:

- The renderer is not finished. A full config (a colorscheme, statusline plugins, treesitter, LSP, render-markdown and similar) will exercise parts of the renderer that are still rough, so expect visual glitches.
- gneovim always adds `-i NONE` (no shada) and `-n` (no swap) for now.

Launched from `/Applications`, a macOS app gets a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), so config that shells out to `git`, `cc`, `rg`, `node` and the like may fail. Launched with `npm run tauri dev` from a terminal it inherits your full shell environment. Importing the login shell environment for the bundled app is a later change.

## How the nvim binary is chosen

In order, first hit wins:

1. the `GNV_NVIM` environment variable, if set and non-empty (used by tests and CI, and handy for a one-off override)
2. `neovim.path` from the config file, after `~/` expansion, if it points at a file
3. common absolute locations: `/opt/homebrew/bin/nvim`, `/usr/local/bin/nvim`, `~/.local/share/bob/nvim-bin/nvim`, `~/.local/bin/nvim`, `/opt/nvim/bin/nvim`, `/usr/bin/nvim`
4. `$SHELL -lc "command -v nvim"`, which sources your real `PATH`
5. bare `nvim`, relying on the process `PATH`

If `neovim.path` is set but does not resolve, gneovim logs `config: neovim.path = ... is not a file, falling back to auto-detection` and continues down the list.
