# Holding j/k in a long note: what was fixed, and the hitch that is left (2026-10-09)

This picks up after commit `0d214f2`. It records where the held key performance work stopped, what Leo observed at that point, and the unverified explanation for the one remaining symptom, so a later session can start from here instead of from scratch.

## Where things stand

After `0d214f2`, plus `vim.g.matchup_matchparen_deferred = 1` in Leo's own config, holding `j` through `~/Downloads/Test-Schools 2026-10-08.md` (3375 lines, tables, lists, inline code) is smooth almost all the time. Leo's description: a slight hitch only every several hundred lines, so a note of typical length never reaches it.

The commits that got here, in order:

| Commit | What | Effect |
|---|---|---|
| `1822ae7` | Adaptive debounce in `md_decor.lua` (20ms, stretching to 70ms during a burst) | Neovim CPU during a hold 62% to 30% of a core |
| `80e1e39` | Per row cache of the `:syntax` conceal scan | 30% to 8% |
| `6a97541` | No CodeMirror transaction for a cursor echo that did not move | Frames over budget 17% to 7% |
| `f1f3b02` | Table and image fields rebuild only when a change touches their own rows | Their whole document rescan was 22% of renderer CPU |
| `8d9ff7e`, `681d211` | Island decorations split by kind, only changed kinds dispatched | About 5%. The first version froze highlights because `RangeSet.eq` ignores mark decorations; `681d211` compares ranges itself |
| `c8a201a` | The WKWebView `forceRepaint` runs once after pushes settle (150ms), not after every push | Renderer busy time per hold about two thirds lower in headless WebKit |
| `0d214f2` | `md_decor.lua` queries only the treesitter trees that reach the decorated rows | Removed the stalls that grew with line number |

## The discovery behind `0d214f2`

Leo's report was "smooth for the first few hundred lines, then gradually stuttering". The Safari recording (`3-gneovim-localhost-recording.json`) showed the renderer holding about 58 frames a second for the whole hold, so the renderer was not the problem. The IPC records told the real story: `nvim_cursor_set` normally answered in about 2ms, but about once a second one took 100 to 250ms, and the cursor motion showed matching gaps, zero steps and even small backward steps.

Reproduced outside the app with a Python `pynvim` driver: a real `nvim --embed` with Leo's full config and an attached multigrid UI, gneovim's own `md_preview.lua` and `md_decor.lua` injected as the bridge does, then `nvim_win_set_cursor` at 30 moves a second with the island's acceleration ramp, timing every round trip. The stalls grew with the row. `:profile` and LuaJIT's sampling profiler (`jit.p`) named two causes:

1. `md_decor.lua` ran the highlights query on every parsed tree of the buffer on each push. Markdown parses every inline region as its own `markdown_inline` tree, and only once something has needed it, so the tree list grows with how far the window has scrolled (2235 trees after one pass through the note). Fixed in `0d214f2` by checking each tree's root rows before querying it; payloads were identical to the old code at 30 positions through the note.
2. vim-matchup's treesitter engine, which looks for matching delimiters on every cursor move and also slows down deeper into a markdown file (4.7s of 5.1s of profiled Vimscript time). This lives in Leo's config. `vim.g.matchup_matchparen_deferred = 1` measured as good as disabling the highlighting outright, while keeping it.

What remained in the profile after both was Neovim core's own treesitter highlighter and injection parsing, which neither gneovim nor the config controls.

## The remaining hitch: a guess, not verified

Leo's observation after the fixes: the hitch no longer depends on what is being rendered (earlier stutters lined up with tables and inline code heavy lists), and seems tied only to distance travelled, recurring every several hundred lines.

The best explanation is garbage collection, for these reasons:

- **The cadence follows distance.** Every line moved through produces a roughly fixed amount of temporary data (decoration payloads, treesitter query results, the JSON crossing the bridge). A collector runs once a certain amount has accumulated, so it recurs every N lines regardless of content.
- **Content does not matter.** The earlier stutters were drawing costs, which depend on what is on screen. Collection is housekeeping, and a table costs it no more than a paragraph does.
- **It shows up as a single pause.** Smooth, one hitch, smooth again, rather than a general slowdown.
- **It plausibly grows deeper into a long file.** A collection's cost grows with live memory, and Neovim keeps every treesitter tree it has parsed.

Two alternatives were considered and judged less likely. CodeMirror does render ahead in chunks, but about every few dozen lines, and that cost depends on content. Neovim parses newly reached treesitter regions on every move, a little at a time, which would not produce an occasional pause.

It could be on either side, and the remedy would differ:

- **Neovim (LuaJIT).** `md_decor.lua` builds fresh tables and a fresh JSON string on every push.
- **The webview (JavaScriptCore).** Every payload is parsed and turned into new decoration objects.

## How to confirm it, if this is ever picked up again

- **From a Safari timeline recording:** catch one hitch and check whether it lines up with a `garbage-collected` record (webview side) or with one slow `nvim_cursor_set` round trip in the network records (Neovim side). The analysis scripts read `recording.records` for both.
- **From the pynvim driver:** log `collectgarbage('count')` in the child at every step. A sawtooth whose drops line up with the slow round trips would confirm the Neovim side without involving Leo.

## Possible remedies, and why they were not pursued

- **Allocate less per push:** send only the parts of the payload that changed, reuse tables in `md_decor.lua`, avoid rebuilding decoration objects for unchanged rows.
- **Tune the collector:** for example LuaJIT's `setpause` / `setstepmul`, or an explicit `collectgarbage('step')` while idle. A collector setting would affect Leo's whole Neovim, not just gneovim's code.

Leo's decision on 2026-10-09 was to stop here. The hitch only appears while holding a key through a note far longer than usual, and each remedy is real work with risk for a modest gain.
