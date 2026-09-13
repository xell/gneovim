# Architecture review, September 2026

Reviewed at main commit `593f571` on 2026-09-13. All line numbers below refer to that commit; re-locate by symbol name if the files have drifted.

This document is the handoff for the next refactoring rounds. The goal of that work is a thorough quality pass with **strictly no functional changes**: no user-facing feature added, removed, or altered, and **the IPC command signatures frozen** (names, parameters, payload shapes, on both the command and event direction). Every candidate below fits inside that constraint except where explicitly flagged.

## Vocabulary

These terms are used exactly as defined here; do not substitute "component", "service", "API", "boundary", or "layer".

- **Module**: anything with an interface and an implementation (a function, a class, a file, a tier-spanning slice).
- **Interface**: everything a caller must know to use the module correctly, including invariants, ordering constraints, and error modes, not just type signatures.
- **Depth**: leverage at the interface. A module is **deep** when a lot of behaviour sits behind a small interface, **shallow** when the interface is nearly as complex as the implementation.
- **Seam**: the place where a module's interface lives; where behaviour can be altered without editing in that place.
- **Adapter**: a concrete thing satisfying an interface at a seam. One adapter means a hypothetical seam; two adapters make it real.
- **Locality**: change, bugs, and verification concentrate in one place. **Leverage**: one implementation pays back across many call sites.
- **Deletion test**: imagine deleting a module. If complexity vanishes it was a pass-through; if it reappears across N callers it was earning its keep.

## Codebase shape

Four real source modules plus injected Lua:

| Module | Lines | Role | Depth verdict |
|---|---|---|---|
| `src/main.js` | 2,973 | The entire frontend: multigrid DOM renderer, CodeMirror island manager, IME/input, transport, window model, boot | One module wearing six hats; not importable by tests (Tauri import and DOM side effects at lines 8 and 14 run at module load) |
| `src-tauri/src/lib.rs` | 1,370 | Tauri commands, event forwarding, window lifecycle, macOS chrome | Command layer is shallow (14 of 20 commands are one-expression pass-throughs) |
| `src-tauri/src/bridge.rs` | 1,331 | Neovim process + msgpack RPC bridge, deliberately Tauri free | Already deep; keep its shape |
| `src-tauri/src/config.rs` | 326 | TOML config | Fine; has unit tests |
| `src-tauri/src/runtime/md_decor.lua` | 858 | Collects conceal/highlights/folds/visual per window, pushes one JSON payload | Already deep: one notification interface |
| `src-tauri/src/runtime/md_preview.lua`, `open_in_new_tab.lua` | 187 + 125 | Preview flag + gutter feed; new-tab command | Fine |

Tests today: three Rust integration tests in `src-tauri/tests/` (`bridge.rs`, `multigrid_renderer.rs`, `redraw_probe.rs`), each spawning a real nvim, with fixed sleeps and a hard-coded `win = 1000`. Unit tests exist only in `config.rs`. There is **no JavaScript test infrastructure at all** (no test runner in `package.json`).

## The IPC inventory (the frozen surface)

Tauri commands, all in `lib.rs:840-1059`: `nvim_input`, `show_definition`, `nvim_cursor_set`, `nvim_edit`, `nvim_mouse`, `island_attach`, `island_detach`, `nvim_resize`, `nvim_redraw`, `nvim_ui_start`, `js_log`, `gnv_config`, `nvim_winfts`, `nvim_guiopts`, `nvim_wingutters`, `nvim_md_decor`, `nvim_paste_clip`, `nvim_clip_yank`, `new_window`, `new_tab`.

Tauri events, all named `gnv://<window-label>/<kind>` (per-window scoping by name because `emit_to` broadcasts; see `lib.rs:697-702`): `reset`, `lines`, `cursor`, `cmdline`, `cmdline_hide`, `grid`, `winft`, `guiopt`, `md_preview`, `win_gutter`, `md_decor`, `gone`, `focus`, `look_up`.

Neovim to bridge notifications (`bridge.rs handle_notify`, 285-463): `gnv_clip_set`, `nvim_buf_lines_event`, `gnv_cursor`, `gnv_cmdline`, `gnv_cmdline_hide`, `gnv_winft`, `gnv_guiopt`, `gnv_md_preview`, `gnv_win_gutter`, `gnv_md_decor`, `gnv_open_new_tab`, `redraw`; one request, `gnv_clip_get`. These string names must stay in sync with the autocmds and Lua injected in `bridge::connect` and with `main.js` listeners; nothing checks that today.

## The short version

The Rust bridge and `md_decor.lua` are already deep modules; the friction concentrates in two places.

First, `main.js` mixes six concerns in one module, and because it imports Tauri and touches the DOM at import time, none of its pure logic (the byte to UTF-16 coordinate contract, the `keyToNvim` encoder, the Markdown table parser, the minimal-edit shrink) can be imported by a test.

Second, the invoke/listen seam has no owner. Roughly thirty call sites each know command names, payload shapes, and the event naming rule, and each picks its own error policy. The scariest gaps live there: keystrokes and IME text dropped with no catch, a failed resize that can never retry, island detach failures that leak a Rust refcount, and a boot retry loop that exits successfully after total failure.

The sharpest single finding: island buffer sync correctness rests on a 3 ms sleep (`bridge.rs:1049-1054`), while the `changedtick` that would make it a real protocol already arrives in every `nvim_buf_lines_event` (args[1]) and is discarded.

## Candidate 1 · Deepen the transport seam: one NvimClient module (Strong)

**Files.** `src/main.js`, the ~30 raw `invoke`/`listen` call sites: 464, 478, 487, 494, 640, 679, 682, 1900, 1905, 2454, 2469, 2495-2552, 2564, 2577, 2597, 2607, 2612, 2854, 2895, 2920.

**Problem.** The seam is real (the repo's own `docs/state-ownership-and-the-tmux-analogy.md` records a second WebSocket adapter that once sat here) but no module owns it; transport knowledge and error policy leak into every caller. There are two input paths with no shared ordering: each Island serializes through `_nvimInputQueue` (`main.js:1898-1911`), while the grid keydown path (2854, 2895), `imeFlush` (640), and the focus/blur handlers (679, 682) all bypass it.

**Solution.** One NvimClient module whose interface is the commands and event streams (`input()`, `edit()`, `attachIsland()`, `on(kind, cb)`, plus the boot replay). Every current call site routes through it. Wire names and payloads unchanged, so the IPC freeze holds.

**Error boundaries this module would absorb** (today ad hoc per call site):

| Site | Today | Consequence |
|---|---|---|
| `imeFlush` `main.js:640`; grid keydown 2854, 2895 | no `.catch` at all | dropped keystrokes/IME text are invisible (only the global `unhandledrejection` logger sees them) |
| `nvim_resize` `main.js:2453-2454` | `lastSize` updated **before** the invoke, error swallowed | a failed resize permanently desyncs the frontend's belief about nvim's grid size; the dedupe never retries |
| `island_detach` `main.js:464, 478` | `.catch(() => {})` | leaks a `BufState` refcount in `bridge.rs:251`; the buffer stays attached and keeps streaming lines events forever |
| `nvimMouse` `main.js:2926` | `.catch(() => {})` | a dropped press leaves the frontend `drag` latch (2928) and Neovim's mouse state as two diverged state machines |
| `boot()` ui_start loop `main.js:2562-2571` | 100 tries, then falls through | after total failure the window is live, listening, and permanently blank; every follow-up replay call also fails silently |
| `attachIsland` `main.js:486-497` | logs and stops | a failed attach leaves an Island in the map with `bufnr === null`: a blank, mute editor over the user's window. The unmount-during-attach early return at 489 also never releases the Rust refcount from the successful attach |
| `md_decor` listener `main.js:2547` | unguarded `JSON.parse` | one malformed payload throws inside the Tauri callback; decorations silently stop |

**Wins.** Locality: one error policy in one implementation. Leverage: one interface, ~30 call sites. A second adapter (in-memory fake) makes island and renderer logic testable without Tauri or nvim. One input queue ends the split ordering. Boot gains a terminal failure state that shows something on screen.

## Candidate 2 · Free the pure logic trapped in main.js (Strong)

**Files.** `src/main.js:20-32` (`byteLen`, `byteToCol`), `:89` (`parseGuifont`), `:1085-1172` (`tableCells`, `tableCursorCell`, `tableAlign`, `tableHighlightCells`), `:1009-1029` (`imageSource`, `imageLabel`), `:1404` (`diffInserted`), `:1959-2002` (the common prefix/suffix shrink inside `applyBufLines`), `:2423` (`screenMetrics`), `:2707-2776` (`normalModePunctuation`, `baseFromCode`, `keyToNvim`). Rust: `src-tauri/src/bridge.rs:169-242` (`ext_id`, `jcell`, `attr_map`, `grid_op`).

**Problem.** These are pure, load-bearing, and unreachable by tests. `keyToNvim` is the single densest piece of pure logic in the codebase (Option-as-Meta recovery, named keys, modifier ordering). `byteToCol`/`byteLen` carry the byte vs UTF-16 coordinate contract the whole island depends on (documented far away, in `docs/macos-cjk-ime.md`). On the Rust side, `grid_op` defines the entire redraw wire format as a pure function of `(&str, &[Value])` and nothing exercises it.

**Solution.** Mechanical extraction into side-effect-free ES modules (suggested: a text-geometry module for the byte/UTF-16 contract, a keymap module for `keyToNvim` and its tables, a markdown-table module) plus a vitest harness. The shrink logic inside `applyBufLines` needs a tiny reshaping to take `(cur, insert)` as arguments. In Rust, add unit tests for `grid_op`/`attr_map`/`ext_id`; no refactor needed there.

**Wins.** The interface is the test surface; no mocks. Zero behaviour change: imports move, bodies do not. Coordinate bugs get one home. `grid_op` tests pin the wire format down for free.

## Candidate 3 · Island buffer sync: a protocol, not a stopwatch (Strong)

**Files.** `src-tauri/src/bridge.rs:1019-1101` (`edit`, `island_attach`, `island_detach`), `:1041-1054` (the suppress window), `:296-320` (the lines handler that drops while suppressed). `src/main.js:455-497` (`reconcileIslands`, `attachIsland`), `:1848-1876` (`onUpdate`), `:1959-2014` (`applyBufLines`).

**Problem.** Echo suppression is a timing guess: `Bridge::edit` bumps a counter, applies the edit, then a spawned task sleeps 3 ms and decrements. If the echo `nvim_buf_lines_event` arrives after 4 ms, the frontend re-applies its own edit. If a genuine concurrent edit (a formatter, another window, an LSP action) lands inside the 3 ms, it is dropped at `bridge.rs:300` and nothing ever resyncs; the only recovery is `applyBufLines`'s catch (`main.js:2011-2014`), which fires only when a CodeMirror dispatch throws, so silent divergence is undetectable. The attach snapshot (`island_snapshot`, `bridge.rs:473-506`) reads lines, cursor, and mode in three separate awaits with no atomicity. The attach/detach refcount protocol leaks on three paths (see candidate 1's table).

**Solution.** One buffer-sync module, mostly inside `bridge.rs` (already Tauri free and integration-tested): gate the echo with `changedtick` (already present in the notification, currently discarded) instead of the sleep; make the snapshot one round trip (one `exec_lua`); own the refcount lifecycle so a failed detach or an abandoned attach cannot leak. Wire payloads unchanged; frontend listeners unchanged.

**Wins.** Correctness stops depending on scheduler timing. Divergence bugs concentrate in one module. Testable through the existing `src-tauri/tests` harness. Deletes the spawned sleep task.

**Caution.** Behaviour-preserving in intent but it touches sync semantics; verify against the buffer-sync checks in `docs/markdown-island.md` before and after, with a CJK/IME pass per `docs/macos-cjk-ime.md`.

## Candidate 4 · Name the owner of the window model (Worth exploring)

**Files.** `src/main.js:345-361, 595-608` (the shared maps and cursor state), `:2181-2384` (`renderGridOps`, a 204-line switch).

**Problem.** The frontend's mirror of Neovim's screen and window state is 31 module-level mutable bindings (`grids`, `winPos`, `gridToWin`, `winFt`, `winBuf`, `islands`, `islandGridIds`, `previewWins`, `winGutter`, `cursorGrid`, `lastCursorPayload`, `modeName_`, `modeInfo`, `curMode`, `cmdlineActive`, `hlAttrs`, `defColors`, `hlDefs`, cell metrics, input latches, and more), written and read from arbitrary depth. `cursorGrid` alone is written by the renderer (2229) and read from eight other sites across five concerns (499, 536, 654, 665, 2326, 2779, 2821, 2840). The renderer, island manager, and IME manager are one undifferentiated call graph: a grid op can transitively trigger a CodeMirror measurement (`floatTopPx`), an `island_attach` IPC round trip, and a DOM focus change. Two independent cursor streams (`gnv_cursor` vs `grid_cursor_goto`) are reconciled by a cached replay (`lastCursorPayload`, comment at 596-604) rather than by an owner.

**Solution.** A session-model module that consumes redraw ops and per-window events and exposes queries (`cursorOwner()`, `islandFor(grid)`, `mode()`). Renderer, islands, and input become callers of its interface instead of co-owners of its variables. The event-order workarounds move inside, next to the state they guard.

**Wins.** Locality: ordering workarounds live where the state lives. The deletion test passes: deleting the module re-scatters 31 bindings. Combined with candidates 1 and 2, redraw handling becomes testable data-in/data-out.

**Sequencing.** Larger and riskier than 1-3; attempt after the transport seam exists so the model can be driven by a fake adapter under test.

## Candidate 5 · Collapse the shallow plumbing in lib.rs (Worth exploring)

**Files.** `src-tauri/src/lib.rs:703-781` (the `BridgeEvent` to `emit` match), `:840-1059` (commands), `src-tauri/src/bridge.rs:88-129` (`BridgeEvent`), `src/main.js:2148-2158, 1908-1912`.

**Problem.** The wire shape of five events (`WinFt`, `GuiOpt`, `MdPreview`, `WinGutter`, `MdDecor`) is defined twice: hand-parsed out of msgpack in `handle_notify`, then hand-rebuilt as `serde_json::json!` literals at the emit site. The other four events (`Reset`, `Lines`, `Cursor`, `Cmdline`) already use `#[derive(Serialize)]` payload structs; the module is inconsistent with itself. `MdDecor` additionally ships JSON-in-a-string, re-parsed unguarded at `main.js:2547`. Deletion-test failures ride along: `Island.scrollTo` (`main.js:2148`) computes a dedupe key and does nothing (nothing reads `_lastViewport`); `queueSemanticWord` (`main.js:1908`) is byte-identical to `queueNvimCursor` except the log string; `Bridge::redraw` (`bridge.rs:1132`) plus the `nvim_redraw` command have no frontend caller, and `docs/multigrid-renderer.md` argues against the very technique they implement.

**Solution.** Give the five hand-built arms typed Serialize payload structs (wire bytes identical, so inside the freeze); shrink the emit match to name lookup plus one emit call. Delete `Island.scrollTo` and merge `queueSemanticWord` into `queueNvimCursor`. Guard the one `JSON.parse`.

**Flagged.** Deleting `Bridge::redraw` and the unused `nvim_redraw` command would remove an IPC command, which the freeze forbids even though nothing calls it. Record it and do it when the freeze lifts. Same for the deeper option of emitting `MdDecor` as parsed JSON instead of a string (it changes an event payload shape).

**Wins.** Wire shapes get one definition, in `bridge.rs`. About 80 lines of pass-through deleted. Complexity concentrates rather than relocating.

## Candidate 6 · Rust-side error boundaries on the hot path (Worth exploring)

**Files.** `src-tauri/src/bridge.rs:441` (the `grid_batch` lock), the twelve `let _ = tx.send(...)` sites (314, 327, 342, 349, 355, 364, 369, 395, 411, 435, 455, 735), `src-tauri/src/lib.rs:782-784` (emit failures), `:823-838` (`bridge_for`).

**Problem.** Connect-time failure is handled beautifully (stderr capture, `CONNECT_TIMEOUT`, the `failed` map, the reused `gone` overlay), but steady-state failure is shrugged off. `grid_batch.lock().unwrap()` sits on the hottest path in the system; one poison panics the notification handler on every later redraw. All channel sends ignore a dead receiver, so if the forwarding task dies, `handle_notify` keeps doing full work for nobody, forever. A failed `emit` of a grid frame is warn-and-continue, but a lost frame is unrecoverable by design (per `docs/multigrid-renderer.md`). `bridge_for` poll-sleeps up to 5 s per command with no queue, so keystrokes issued during a slow startup can reach nvim in nondeterministic order.

**Solution.** Local hardening inside the existing modules, no interface change: a non-poisoning or recover-and-clear lock on `grid_batch`; first failed send tears down the handler's interest; a failed grid emit escalates to the existing repaint/`gone` machinery; readiness becomes one awaited signal shared by `bridge_for` and the frontend's ui_start retry (pairs with candidate 1's boot fix).

## Other coupling on the record (no card, keep in mind while refactoring)

- The frontend embeds Neovim implementation knowledge: the raw mode-string regex `/^[iRsS\x13]/` (`main.js:2042`); a partial Vim operator-pending state machine in the keydown handler (`/^[dcy><=!gz"'\[]$/`, count prefixes, the `islandNativeWPending` latch, 2833-2896); two different mode vocabularies juggled at 2717-2719; the `zindex: 1_000_000` cmdline-grid rule (2313); the `/^EasyMotion(?:Target|Shade)/` plugin-specific match (1607).
- The Rust side embeds rendering knowledge: the `VimResized * redrawtabline` autocmd installed into the user's nvim to paper over a DOM repaint artifact (`bridge.rs:824-843`); `BridgeEvent` variants named for frontend rendering concepts; `set background=light` in the spawn path for bare configs.
- The redraw op vocabulary (`"resize"`, `"line"`, `"win_pos"`, ...) is defined twice, in `grid_op` (Rust) and `renderGridOps` (JS), linked only by string literals and tested nowhere. Candidate 2's `grid_op` tests are the cheap mitigation.
- Frontend re-batches Neovim's frames across requestAnimationFrame (`main.js:2168-2179`) and discards intermediate `flush` ops, so one paint can merge several Neovim frames; `reconcileIslands` runs once at the end, making island attach/detach IPC one frame late and unordered relative to the redraw stream.
- `hlCss` (grid renderer) and `rebuildHlStyle` (islands) duplicate the attr-to-CSS translation, including the fg==bg camouflage rule.
- `docs/state-ownership-and-the-tmux-analogy.md` is stale: the Vite WebSocket bridge it describes no longer exists (nvim is spawned by the Tauri shell), and the "browser keeps zero durable state" claim is contradicted by the 31-binding shadow model in `main.js`. Update or annotate it before the next round trusts it.

## Top recommendation and sequencing

**Candidate 1 (the NvimClient seam), entered via candidate 2's extraction.** It changes what every other refactor costs: it concentrates the scattered error policy (where the review's sharpest user-facing risks live), gives the frontend its first real seam, and its second adapter, an in-memory fake, is what makes candidates 3 and 4 verifiable without a live Neovim and a webview.

Suggested order for the next rounds:

1. Candidate 2 first (mechanical, zero risk) to stand up vitest and the `grid_op` tests.
2. Candidate 1, routing call sites through NvimClient incrementally; behaviour identical, error policy explicit.
3. Candidate 3 in `bridge.rs`, verified through the existing integration tests plus the doc checklists.
4. Candidate 5's within-freeze items and candidate 6's hardening, opportunistically.
5. Candidate 4 last, driven by the fake adapter.

## Verification rules for every round

- No IPC command or event name/payload changes; diff the inventory section above against the code after each round.
- No user-visible behaviour change. High-risk manual passes: CJK IME in islands and grid windows (`docs/macos-cjk-ime.md`), Grammarly external edits (`docs/grammarly-markdown-island.md`), buffer-sync checks (`docs/markdown-island.md`), tabline repaint on live window resize, EasyMotion/hop overlays, closed folds surviving edits.
- `cargo test` (needs a real `nvim` on PATH or `GNV_NVIM`) must stay green; new vitest suites must run without Tauri or nvim.
- Respect the decoration safety rules in `docs/markdown-island.md` (the never-mapped fold field) when touching island code.
