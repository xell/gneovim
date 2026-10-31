# The `gneovim://` URL scheme and the `gneovim` command

Two ways to open a file in gneovim from outside it, both feeding the same code path (`open_request` in `src-tauri/src/lib.rs`):

1. `gneovim://file/...` URLs, for links in other apps, error pages, scripts and Shortcuts.
2. A `gneovim` shell command with Neovim style arguments. It is a small script that turns its arguments into `gneovim://` URLs and hands them to the app with `open`, so the shell returns at once.

Both can also run a named action instead (`gneovim://action/<name>`, `gneovim --action <name>`): a handler in your own Neovim config, for things like a global "add to inbox" shortcut. See [Actions](#actions).

Files opened from Finder (double-click with gneovim as the default app, Open With, drag to the Dock, `open -a gneovim file`) take the same path, as if they were `gneovim://file/<path>?cwd=<the file's folder>`: no overrides, so they follow `[window] open_files_in` (see `configuration.md`), jump to a gneovim window that already has the file (`swap=reveal`), and work in the file's own folder.

Three rules apply to every open, whatever its source:

- Which window receives it. Only a gui-window on the macOS Space you are looking at: the last focused one if it is on this Space, else any other normal gui-window here. With none on this Space, a new window opens (and appears on this Space). A window on another Space is never used, even the last focused one, so an outside open never drags you to another Space. The always-on-top window never receives an open, although it is on every Space. This decides where `nvim-tab` opens a tabpage, which window a `tab` joins, and which window an untouched-window takeover (below) considers. The one exception is `swap=reveal` (the default): it focuses the gneovim window that already has the file, on whatever Space that is, since jumping there is the point.
- Where the working directory goes. A newly spawned Neovim starts in `cwd`. A file that lands in an existing Neovim gets `:tcd cwd` on its own tabpage only, so that Neovim's other tabpages and its global directory are left alone.
- No empty window left behind. When a file would get a new window or gui-tab but the receiving gui-window is untouched (one tabpage, one window, an unnamed unmodified buffer), the file takes over that window instead. This is what stops a cold launch by a double-click from leaving the app's initial window empty next to the file's own.

## URL format

```
gneovim://file/<absolute path>[:<line>[:<col>]][?<parameters>]
gneovim://action/<name>
```

The `action` form is described under [Actions](#actions); the rest of this section is about `file`.

The path part is the same shape VS Code uses (`vscode://file/...:line:col`), so any tool with an editor link template (Phoenix `PLUG_EDITOR`, Rails better_errors, Laravel Ignition, iTerm2) works by writing `gneovim://file/__FILE__:__LINE__` in place of the `vscode://` one. Path characters must be percent-encoded as usual; a `:` that is part of the file name must be sent as `%3A`, otherwise a trailing `:digits` is read as the line. `gneovim://file//abs/path` (a doubled slash from a template) is accepted too. Line is 1-based; column is a 1-based byte column, as Vim's `cursor()`.

Parameters, all optional:

| Parameter | Values | Meaning |
| --- | --- | --- |
| `target` | `window`, `tab`, `nvim-tab` | Where the file lands; overrides `[window] open_files_in` for this call. |
| `cwd` | absolute directory | Working directory: a newly spawned Neovim starts there; in an existing Neovim only the file's tabpage is `:tcd`'d. |
| `readonly` | `1` | Neovim's `-R`: the file opens with `'readonly'` set, occupied or not. |
| `swap` | `reveal`, `readonly`, `takeover`, `ask` | What to do when the file is already open in another Neovim; see below. |

Unknown parameters are ignored. An unknown host (anything but `file` or `action`) or a bad value for `target` or `swap` rejects the URL with a line in the log. Any web page or app can fire a URL, so the scheme deliberately has no way to run an Ex command or Lua. The most it can do besides opening a file is trigger a handler you registered yourself, by name, with no arguments: a page can make your "inbox" action run, but it can never pass data into it.

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

## Actions

```
gneovim://action/<name>
```

`<name>` is a single path segment of letters, digits, `_` and `-`. Anything else (an empty name, a second segment, an encoded space or slash, a `.`) rejects the URL with a line in the log. Query parameters are ignored: an action has no arguments, by design (see above).

gneovim does nothing with the name itself. It picks the gui-window that would receive a file (the first rule above: a normal window on this Space, or a new one), waits for its Neovim to be ready, fires `User GneovimAction` there with `data = { name = <name> }`, and focuses the window. What the action does, which buffer it opens and whether in place or in a new tabpage, is entirely up to your handler; the untouched-window takeover does not apply. On a cold launch, or when a new window had to be spawned, the event fires once Neovim has finished starting and the window is on screen, so your config's handler exists and anything it shows is visible.

```lua
vim.api.nvim_create_autocmd("User", {
  pattern = "GneovimAction",
  nested = true,
  callback = function(ev)
    if ev.data.name == "inbox" then require("inbox").add() end
  end,
})
```

With no `User GneovimAction` handler at all, the action shows a "no handler" warning in that Neovim and nothing else happens. A handler that does not recognise the name should ignore it. Register it at startup (`init.lua` or `plugin/`), not from a lazily loaded plugin, and keep `nested = true`; see `neovim-api-surface.md`.

From a shell, `gneovim --action inbox`; from anywhere else (a BetterTouchTool or Shortcuts action, say), `open "gneovim://action/inbox"`.

## The `gneovim` command

The script ships inside the app bundle. Install it once with:

```sh
ln -s /Applications/gneovim.app/Contents/Resources/bin/gneovim /usr/local/bin/gneovim
```

```
gneovim [options] [+N | "+call cursor(N,M)"] [file ...]
gneovim --action NAME

  -p                 open the files as Neovim tabpages in the gui-window on
                     the current Space (target nvim-tab)
  -R                 readonly: every file opens with 'readonly' set
  --target=T         window, tab or nvim-tab
  --swap=P           reveal, readonly, takeover or ask (default reveal,
                     readonly with -R)
  +N                 cursor on line N of the first file
  +call cursor(N,M)  line N, byte column M of the first file
  --action NAME      send gneovim://action/NAME (also --action=NAME); takes
                     no files or other options
  -h, --help
  -v, --version
```

The syntax follows Neovim's own command line (`nvim +42 file`, `-p`, `-R`), not VS Code's `-g file:line`. Relative paths resolve against the shell's current directory, which also becomes the working directory of the file (see the rules above). Each file becomes one URL, so several files open as several windows, gui-tabs or tabpages, just like files opened from Finder. With no files the app is just brought to the front.

Because everything travels through the public URL scheme, only `+N` and `+call cursor(N,M)` are accepted; any other `+cmd`, `-c` or Neovim flag is rejected with a message rather than silently ignored. General `+cmd` / `-c` and `--wait` (for `$EDITOR` and `git commit`) need a private channel to the app and are planned for later.

## Debugging the URL registration

macOS learns about the `gneovim` scheme from the app bundle's `Info.plist` (`CFBundleURLTypes`), so:

- It only exists for a real bundle (`npm run release`), never under `tauri dev`.
- Every `gneovim.app` LaunchServices has seen can claim it, including stale build bundles under `src-tauri/target/*/bundle/macos/`. If a URL opens the wrong copy, or opens nothing, check who owns it with `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -dump | grep -i -B3 -A3 'gneovim:'`, and remove or `lsregister -u` the stale copy.
- The `gneovim` command passes `-a <its own bundle>` to `open`, so it always reaches the app it lives in, whatever owns the scheme.
- A rejected URL is logged with a `gneovim://:` prefix.
- Every outside open or action logs `outside request goes to ...`, with each gui-window's label and whether it is the always-on-top window and on the current Space, which is what to read when one lands in an unexpected window.

## Environment variables

Two variables read at launch, mostly for development: `GNV_NVIM` sets the `nvim` binary to run (ahead of `[neovim] path` and the auto-detection), and `GNV_NO_SHELL_ENV`, when set, skips importing the login shell's environment into Neovim.
