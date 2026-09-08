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
```

## How the nvim binary is chosen

In order, first hit wins:

1. the `GNV_NVIM` environment variable, if set and non-empty (used by tests and CI, and handy for a one-off override)
2. `neovim.path` from the config file, after `~/` expansion, if it points at a file
3. common absolute locations: `/opt/homebrew/bin/nvim`, `/usr/local/bin/nvim`, `~/.local/share/bob/nvim-bin/nvim`, `~/.local/bin/nvim`, `/opt/nvim/bin/nvim`, `/usr/bin/nvim`
4. `$SHELL -lc "command -v nvim"`, which sources your real `PATH`
5. bare `nvim`, relying on the process `PATH`

If `neovim.path` is set but does not resolve, gneovim logs `config: neovim.path = ... is not a file, falling back to auto-detection` and continues down the list.
