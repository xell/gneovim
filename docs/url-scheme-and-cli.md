# The `gneovim://` URL scheme and the `gneovim` command

Two ways to open a file in gneovim from outside it, both feeding the same code path (`open_request` in `src-tauri/src/lib.rs`):

1. `gneovim://file/...` URLs, for links in other apps, error pages, scripts and Shortcuts.
2. A `gneovim` shell command with Neovim style arguments. It is a small script that turns its arguments into `gneovim://` URLs and hands them to the app with `open`, so the shell returns at once.

Files opened from Finder, the Dock or `open -a gneovim file` keep working as before and follow only `[window] open_files_in` (see `configuration.md`).

## URL format

```
gneovim://file/<absolute path>[:<line>[:<col>]][?<parameters>]
```

The path part is the same shape VS Code uses (`vscode://file/...:line:col`), so any tool with an editor link template (Phoenix `PLUG_EDITOR`, Rails better_errors, Laravel Ignition, iTerm2) works by writing `gneovim://file/__FILE__:__LINE__` in place of the `vscode://` one. Path characters must be percent-encoded as usual; a `:` that is part of the file name must be sent as `%3A`, otherwise a trailing `:digits` is read as the line. `gneovim://file//abs/path` (a doubled slash from a template) is accepted too. Line is 1-based; column is a 1-based byte column, as Vim's `cursor()`.

Parameters, all optional:

| Parameter | Values | Meaning |
| --- | --- | --- |
| `target` | `window`, `tab`, `nvim-tab` | Where the file lands; overrides `[window] open_files_in` for this call. |
| `cwd` | absolute directory | Working directory of a newly spawned Neovim. Ignored when the file goes into an existing Neovim, which is never `:cd`'d. |
| `readonly` | `1` | Neovim's `-R`: the file opens with `'readonly'` set, occupied or not. |
| `swap` | `reveal`, `readonly`, `takeover`, `ask` | What to do when the file is already open in another Neovim; see below. |

Unknown parameters are ignored. An unknown action (anything but `file`) or a bad value for `target` or `swap` rejects the URL with a line in the log. The scheme deliberately has no way to run an Ex command or Lua: any web page or app can fire a URL.

## Occupied files: `swap=`

A file is only "occupied" when the Neovim receiving it is not the one that already has it. With `target=nvim-tab` into the very window that holds the file there is no conflict: gneovim just jumps to it. Otherwise:

| Policy | Holder is another gneovim window | Holder is a Neovim outside gneovim |
| --- | --- | --- |
| `reveal` (default) | Focus that window and jump to the file and line there; nothing new opens. | Nothing to focus, so it behaves like `ask`. |
| `readonly` (default with `readonly=1`) | Open it here readonly; the holder is untouched. | Same: the swap question is answered "Open Read-Only". |
| `takeover` | The holder writes the buffer if modified, puts an explanatory scratch buffer in its windows and unloads it (removing its swap file); then the file opens here normally. If any step fails, it opens readonly with a message. | gneovim has no channel to it, so it opens readonly with a message. |
| `ask` | Today's behaviour: your own `SwapExists` handler, or Neovim's, decides. | Same. |

A stale swap file (its owner is no longer running) is a recovery question, not a conflict, and is never answered by a URL: with `readonly` or `takeover` Neovim's own swap file prompt appears, with `reveal` or `ask` your `SwapExists` handler (if any) runs as usual.

How it works: gneovim asks each of its Neovims over RPC whether it has the file loaded, which settles the gneovim holder cases before anything opens. An outside holder is only visible through its swap file, so the `:edit` runs with `g:gneovim_swap_policy` set and gneovim's own `SwapExists` handler answers from it (see `neovim-api-surface.md`). If your config has a `SwapExists` handler that prompts, make it return early while that variable is set.

## The `gneovim` command

The script ships inside the app bundle. Install it once with:

```sh
ln -s /Applications/gneovim.app/Contents/Resources/bin/gneovim /usr/local/bin/gneovim
```

```
gneovim [options] [+N | "+call cursor(N,M)"] [file ...]

  -p                 open the files as Neovim tabpages in the last focused
                     gui-window (target nvim-tab)
  -R                 readonly: every file opens with 'readonly' set
  --target=T         window, tab or nvim-tab
  --swap=P           reveal, readonly, takeover or ask (default reveal,
                     readonly with -R)
  +N                 cursor on line N of the first file
  +call cursor(N,M)  line N, byte column M of the first file
  -h, --help
  -v, --version
```

The syntax follows Neovim's own command line (`nvim +42 file`, `-p`, `-R`), not VS Code's `-g file:line`. Relative paths resolve against the shell's current directory, which also becomes the working directory of a newly spawned Neovim. Each file becomes one URL, so several files open as several windows, gui-tabs or tabpages, just like files opened from Finder. With no files the app is just brought to the front.

Because everything travels through the public URL scheme, only `+N` and `+call cursor(N,M)` are accepted; any other `+cmd`, `-c` or Neovim flag is rejected with a message rather than silently ignored. General `+cmd` / `-c` and `--wait` (for `$EDITOR` and `git commit`) need a private channel to the app and are planned for later.

## Debugging the URL registration

macOS learns about the `gneovim` scheme from the app bundle's `Info.plist` (`CFBundleURLTypes`), so:

- It only exists for a real bundle (`npm run release`), never under `tauri dev`.
- Every `gneovim.app` LaunchServices has seen can claim it, including stale build bundles under `src-tauri/target/*/bundle/macos/`. If a URL opens the wrong copy, or opens nothing, check who owns it with `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -dump | grep -i -B3 -A3 'gneovim:'`, and remove or `lsregister -u` the stale copy.
- The `gneovim` command passes `-a <its own bundle>` to `open`, so it always reaches the app it lives in, whatever owns the scheme.
- A rejected URL is logged with a `gneovim://:` prefix.

## Environment variables

Two variables read at launch, mostly for development: `GNV_NVIM` sets the `nvim` binary to run (ahead of `[neovim] path` and the auto-detection), and `GNV_NO_SHELL_ENV`, when set, skips importing the login shell's environment into Neovim.
