# Should gneovim be written in GPUI?

Written 2026-10-17. A decision note, not a plan. Nothing here is implemented.

## The question, framed honestly

This would not be a port. A GPUI gneovim drops the WKWebView, the DOM, CodeMirror 6, CSS, Vite and the whole Tauri IPC boundary. In practice it is a new app that keeps Neovim, the injected Lua, and parts of the Rust tier. So "writing from scratch" is the right word, and the question is whether the new foundation is worth giving up what the current one gives us for free.

What gneovim is today, for scale (counted from `git ls-files` on 489cdde):

| Area | Lines | Fate under GPUI |
| --- | --- | --- |
| `src/*.js` (frontend, about 3.9k of it tests) | 11,022 | Thrown away. The pure modules and their tests survive as specs. |
| `styles.css` | 744 | Thrown away. Every rule becomes hand-written layout or paint code. |
| `src-tauri/src/*.rs` (shell, bridge, config, URL scheme, AppKit glue) | 5,382 | Partly kept. `bridge.rs`, `config.rs`, `open_url.rs` and the objc2 bits carry over; the Tauri command and event plumbing goes. |
| `src-tauri/src/runtime/*.lua` (`md_decor.lua`, `md_preview.lua`, open request glue) | 2,071 | Kept almost as is. This is the most portable asset we have. |
| History | 246 commits since 2026-09-06 | Most commits are edge cases. Some vanish with WebKit, some come back in a new form. |

## Why gneovim is DOM based in the first place

This is the whole decision, so it goes first. The founding reason for a DOM GUI was not looks or convenience. It was that a macOS writing tool needs things a canvas or GPU renderer does not give you:

1. Grammarly Desktop, which reaches us only through macOS Accessibility (an `AXTextArea` with `AXValue`, a settable `AXSelectedTextRange`, `AXBoundsForRange` for placing underlines) plus posted keys. See `docs/grammarly-markdown-island.md`.
2. VoiceOver and the rest of the Accessibility tree.
3. macOS text services: Look Up, Services, Translate, Writing Tools.
4. IME, predictive text and autocorrect, which WebKit wires to `NSTextInputClient` for us.

GPUI is a GPU renderer. Any of these we want, we have to build ourselves on top of whatever GPUI exposes. So the real question is not "is GPUI nicer than Tauri" (it probably is, in many ways). It is "can GPUI meet the founding requirement, and at what cost".

## Where GPUI actually is, October 2026

Facts, with sources at the end. Treat everything from third parties as needing a recheck before acting on it.

* **What it is.** Zed's UI framework: hybrid immediate and retained mode, Rust, flexbox and grid layout via `taffy`, text shaped by CoreText on macOS, drawn by an in-house Metal renderer on macOS (wgpu on Linux since Feb 2026, Direct3D 11 on Windows). Its own windowing per platform, not winit. The gpui.rs site now says "from the creators of Zed & Delta".
* **Release cadence is the weak point.** The last official crates.io release is `gpui 0.2.2`, from 2025-10-22. Main has since moved a long way (wgpu renderer, AccessKit, a crate split, newer taffy and cosmic-text) without a release. Using current GPUI means a git dependency on the Zed monorepo. The README says plainly: "There will often be breaking changes between versions." There is no changelog for gpui itself.
* **Fragmentation followed.** Because of the stall, there are snapshot and fork crates: `gpui-pre-*` (snapshots of Zed commits, published by Longbridge's GPUI Kit), `gpui-ce` (a community fork), various `*-gpui-standalone` mirrors. Picking one is a bet on its maintainer.
* **Accessibility is new and not trusted yet.** AccessKit landed on GPUI main on 2026-05-27 (zed PR #56065), deliberately minimal: plumbing only, with "once this lands, we can start adding aria attributes to Zed's components". A follow up added `Application::inaccessible()`, and Zed itself currently opts out with it because the adapter caused nightly panics. None of this is in a crates.io release. Before May, GPUI had no accessibility tree at all; one prior art note calls that "2.5 years and counting of accessibility debt".
* **AccessKit's macOS adapter does implement the text attributes Grammarly reads.** I checked `adapters/macos/src/node.rs` in the AccessKit repo: it implements `accessibilityValue`, `accessibilitySelectedTextRange`, `accessibilitySelectedText`, `accessibilityFrameForRange:`, `accessibilityStringForRange:`, `accessibilityAttributedStringForRange:`, `accessibilityRangeForLine:`, `accessibilityLineForIndex:`, `accessibilityRangeForPosition:` and `accessibilityNumberOfCharacters`. AccessKit models editable text as a `TextInput` or `MultilineTextInput` node with `TextRun` children carrying per character offsets and widths. So the path exists in principle; we would have to feed it those runs ourselves.
* **IME is real.** GPUI's macOS window implements `NSTextInputClient`, but only for elements that implement `EntityInputHandler` (marked text ranges and so on). The bundled `input.rs` example that does this is 746 lines.
* **No first party text field or editor widget.** Zed's editor is its own large crate, not a reusable widget. The third party `gpui-component` (Longbridge, now "GPUI Kit") has 75+ components, an Input, a code editor, Markdown and HTML rendering, AccessKit roles, and headless UI tests. It is used in production in Longbridge Pro. It tracks the `gpui-pre` snapshots, not official releases.
* **Docs are thin.** gpui.rs itself says the best way to learn is to read Zed's source or ask on Discord. There is a community GPUI Book, two in tree concept docs (contexts, key dispatch), and examples.
* **A Neovim GUI on GPUI does exist:** `nvim-gpui` (github.com/imkerberos/nvim-gpui, local checkout at `~/Developer/vim/guis/nvim-gpui`). My web search missed it. It gets its own section below, because it is the best evidence we have.

## A real world example: nvim-gpui

### What it is

A grid only Neovim GUI written in GPUI by one main author (163 of 168 commits), MIT licensed. First commit 2026-09-02, v0.8.1 by 2026-10-17, so it is almost exactly as old as gneovim. About 31.5k lines of Rust and 267 unit tests. It ships DMGs, deb, rpm, Arch and Windows installers, and a Homebrew cask. Its pitch is "native, cross platform"; it is a GPUI Neovide, not a prose tool. Facts below come from its `README.md`, `doc/DEVELOP.md`, `Cargo.toml` and source, read on 2026-10-17.

### What it proves

1. **The grid half works on GPUI, quickly.** Linegrid and multigrid, floats with `compindex`/`zindex` ordering, `winblend`, `win_viewport`, mode and cursor shapes, smooth cursor and scroll animations, Kitty graphics images for plugins like snacks.nvim, and CJK and wide cells. All in six weeks by one person, with packaging for three platforms on top. That is strong evidence that our grid renderer would port without drama.
2. **The rendering shape to copy.** One custom `GridElement` per grid, one logical cell per position, row level copy on write for redraw updates, neighbouring cells coalesced into shaped lines, a shaped line cache keyed by text, font runs and attributes. No GPUI element per cell. `ProtocolState` reduces redraw events and `flush` commits an immutable `PresentationSnapshot` that both paint and hit testing read. That is the same "commit at flush" rule our multigrid notes arrive at.
3. **macOS IME through `EntityInputHandler` works, and the lessons are written down.** Preedit lives in a transient `SystemImeState` and is painted over the grid, never inserted into Neovim; only `replace_text_in_range` sends committed text, once. Printable keys go to the platform input handler, not also to Neovim, or the character is committed twice. GPUI speaks UTF-16 ranges to the platform, so they convert at the boundary. IME coordinates come from the grid that owns the handler and are invalidated on scroll, resize and mode change. This is the same set of problems as `docs/macos-cjk-ime.md`, with less machinery, because there is no DOM in the way.
4. **Font fallback chains for `guifont` and `guifontwide` are workable.** Per style fallback, glyph coverage caching, a bundled Nerd Font path.

### What it does not prove, and what it warns about

1. **Zero accessibility.** No AccessKit, no NSAccessibility, nothing. Its `text_for_range` returns only the IME preedit buffer, not the document, so Look Up, Services, Translate, VoiceOver and Grammarly have nothing to read. This is normal for a grid GUI and fine for its goals; it is exactly the part gneovim cannot do without.
2. **It pins `gpui = "0.2.2"` from crates.io**, the October 2025 release, with the `runtime_shaders` feature (which sidesteps the multi gigabyte Metal toolchain download). That is the sane choice for stability, and it is the evidence that the only stable GPUI is a year old. It also means nvim-gpui cannot get AccessKit without moving to a git dependency on Zed main. Whatever we built on it would face the same fork in the road on day one.
3. **No proportional text, no rich layout.** Every line is a cell row. Nothing in it speaks to paragraphs, wrapping, tables, images in flow or a height map, which is most of our island.
4. **The missing widget library is real.** Its Settings window has a hand written `TextInputState` text field (763 lines in `src/widgets/text_input.rs`) built from raw `KeyDownEvent`s, with no input handler, so no IME in that field. A small sign of how much basic UI you write yourself.
5. **Framework gaps get patched in app code.** On Linux GPUI does not forward `Font.fallbacks` to cosmic-text, so nvim-gpui splits mixed cells into explicit font runs itself. Expect more of this, not less, for anything Zed does not need.
6. **It even ships its own Rime input method engine** (librime, about 1,850 lines across `src/rime.rs` and `src/editor/rime.rs`) with an app drawn candidate window. That is a product choice for Chinese users rather than a GPUI failure, but it shows how far a GPU GUI ends up going to own text input.

## Requirement by requirement

| Requirement | Today (WKWebView) | GPUI |
| --- | --- | --- |
| Grammarly Desktop | Works, confirmed live (`0f22b49`). WebKit gives us the `AXTextArea` for free; our work was making selection and posted keys land correctly. | Unproven. Needs AccessKit enabled (which Zed itself does not do yet), a `MultilineTextInput` node with `TextRun`s we compute from our own layout, settable selection wired back to Neovim, and posted keys routed through our input handler. Whether Grammarly even attaches to a non AppKit, non WebKit text area is unknown. This is the gating unknown. |
| VoiceOver | Works through WebKit's tree. | Same AccessKit path, same unknowns, plus Zed opts out. |
| Look Up, Services, Translate, Writing Tools | Mostly free from WebKit. | Hand built AppKit work on GPUI's `NSView` (`NSServicesMenuRequestor`, Writing Tools support). Look Up may partly ride on `NSTextInputClient`. All of it is our code. |
| CJK IME | Works, but `docs/macos-cjk-ime.md` is 299 lines of fighting contenteditable (preedit caret wiping lines, composition crashing the tile layer, input source lost on mode switch). | Better, and nvim-gpui shows it working for the grid: marked text through `EntityInputHandler`, preedit painted, committed text sent once. For proportional prose we would also have to measure caret and candidate positions in our own layout. A genuine gain. |
| Predictive text, autocorrect, spell check | Partly free from WebKit; see `docs/macos-predictive-text-and-autocorrect.md` for why it is still subtle. | Unknown. Inline predictions in custom `NSTextInputClient` views are possible on recent macOS but not something GPUI does for us. Spell check would be `NSSpellChecker` by hand. |
| Proportional prose fonts, font fallback | CSS. `:MarkdownFont*` is pure CSS fallback. | CoreText shaping and font fallback are there; we lay out the paragraphs. |
| Markdown presentation (tables, images, quotes, hanging indents, dividers, due date capsule, `==highlight==`) | CSS and CodeMirror decorations. About 2,600 lines (`markdown-presentation.js`, `island-display-decorations.js`, `styles.css`). | Everything by hand on top of `taffy` and GPUI text. `overflow-wrap: anywhere`, generated content, margins the height map ignores, all become our own layout code. `gpui-component`'s Markdown renderer is read only, so it is a reference, not a drop in. |
| The `ext_multigrid` grid | DOM rows and spans, with seams and baseline work (`ef06231`, `f4dd3e1`). | Excellent fit, now demonstrated by nvim-gpui: multigrid, floats, blend, images and CJK on one custom `GridElement` per grid. |
| Native window chrome, tabs, always on top | Tauri plus objc2 swizzles, with capability gotchas. | GPUI owns the `NSWindow`; Zed has native tabbing. Still some AppKit glue, but no webview between us and it. |
| Iteration speed | Vite reloads frontend changes instantly; CSS tweaks are seconds. | `cargo` rebuilds. One July 2026 test measured a 55 s clean release build of a small GPUI app; incremental debug builds are faster but never Vite fast. Leo's loop of "change CSS, look, adjust" gets slower. |
| Verification | Scripted headless DOM and CSS measurement, Playwright WebKit recipes, vitest. | GPUI has test app contexts and `gpui-component` has headless UI tests, but every measurement recipe we have is DOM shaped and would be rebuilt. |

## The real pros

1. **One editor instead of two.** This is the strongest argument and it is architectural, not about GPUI as such. Today an island is a second editor (CodeMirror) mirroring Neovim's buffer, and a large share of our bug history comes from keeping the two in agreement: buffer sync and echo suppression, caret sync, the key router and mode latch, gj/gk visual lines, hidden widget cursors, table exit, scroll flip flops, IME tile crashes. In GPUI there is no CodeMirror to agree with. The prose view could be a custom element that lays out Neovim's buffer lines with proportional fonts and the `md_decor.lua` payload, and Neovim stays the only thing that edits. Whole classes of desync simply cannot exist.
2. **One language, one process, no IPC boundary.** Redraw events go from `nvim-rs` straight into app state and onto the GPU. No JSON over Tauri events, no frozen IPC contract, no webview reload semantics.
3. **Performance headroom.** The held j/k stutter investigation (`docs/island-held-key-stutter-2026-10-09.md`) was stopped, not solved. WebKit relayout cost is a large part of that picture. A Metal renderer with our own layout has far more headroom, and the grid side would be fast with little effort.
4. **IME and input without a DOM in the middle.** Owning `NSTextInputClient` directly removes the contenteditable layer that most CJK and predictive text pain came from.
5. **Native control of the window.** Traffic lights, tab bar insets, title, zen mode, always on top: all closer to AppKit without Tauri's capability system in between.
6. **The Lua side carries over.** `md_decor.lua` and friends were written to be renderer agnostic ("it does not reimplement anything"), and Neovim does not care who draws.
7. **Momentum and fun.** GPUI is clearly where a lot of Rust desktop energy is, there is a serious component library, and it is a good thing to learn. That is a legitimate reason for a personal project, as long as it is named as such.

## The real cons

1. **It puts the founding requirement at risk.** Grammarly, VoiceOver and text services work today. Under GPUI they all depend on an accessibility layer that landed five months ago, is not released, and that Zed itself switches off. If Grammarly will not attach, a GPUI gneovim is a fast, pretty Neovide for Markdown, which is not what gneovim is for.
2. **No release, breaking changes, and a forked ecosystem.** We would pin a git commit of the Zed monorepo, or bet on a snapshot crate. Upgrades become archaeology through Zed's history, with no changelog. nvim-gpui shows the other option, pinning the year old 0.2.2, and that option has no AccessKit at all, so it is closed to us.
3. **GPUI serves Zed first.** Its priorities follow Zed's product, and outside users are not its main customer. Accessibility is the clearest example: the plumbing arrived, Zed's own use did not.
4. **We would write a rich text layout engine.** CodeMirror and CSS give us wrapping, bidi, selection geometry, hanging indents, tables, images and scrolling. In GPUI we build paragraph layout, a height map, virtualised scrolling for long documents (the thesis scale buffers), table layout, image placement and hit testing. GPUI's own caret and selection geometry is known to break inside reordered RTL runs on macOS; any similar edge case is ours to fix.
5. **The accessibility tree becomes ours.** To feed AccessKit we must produce per character positions for everything on screen and keep them right through every edit, scroll and fold. WebKit does this for us today, and it is exactly where Grammarly's underline placement comes from.
6. **Slower visual iteration.** Most of the recent work was visual and needed Leo's eye before committing. Rebuild cycles make that loop noticeably slower.
7. **Loss of tooling and recipes.** The DOM measurement harnesses, Playwright WebKit recipe, vitest suites around DOM behaviour: all rebuilt or dropped.
8. **Months, not weeks, before it matches today, and almost all of that is the prose half.** nvim-gpui reached a polished, packaged grid GUI in about six weeks, so the grid half is a weeks sized job, not a months sized one. What it does not contain is the expensive part for us: a prose layout engine, an input handler over proportional text, an accessibility tree with per character geometry, and the AppKit text services. Our six weeks so far had WebKit, CodeMirror and CSS doing that heavy lifting; in GPUI each is ours, before we even reach the edge cases we already fixed.

## What carries over, concretely

* All injected Lua (`md_decor.lua`, `md_preview.lua`, `open_in_new_tab.lua`, `open_request.lua`), unchanged or close to it.
* `bridge.rs` connection, attach refcounting and process model; `config.rs`; `open_url.rs` and the CLI and URL scheme; the AppKit pieces written with objc2.
* The pure frontend modules (`src/pure/island-key-routing.js`, `markdown-decoration-plan.js`, and others) as specifications, and their tests as acceptance lists. Some of them, notably the key router, may not be needed at all once there is only one editor.
* Every note in `docs/`, especially the Grammarly, IME, multigrid and window model notes, which describe Neovim and macOS behaviour rather than DOM behaviour.

## Middle paths worth naming

1. **Keep the stack, take the lesson.** The biggest pro (one editor, not two) is about dropping CodeMirror, not about dropping the DOM. A DOM prose view rendered from Neovim's buffer, with our own small contenteditable surface for Grammarly and IME, would remove much of the sync complexity while keeping WebKit's accessibility. This is a big change too, but it keeps the founding requirement safe.
2. **Speed up the grid only.** If performance is the itch, a canvas or WebGPU grid inside the current webview addresses the grid side without touching islands.
3. **GPUI for grids and a webview for islands** sounds attractive but GPUI has no good story for embedding native views like `WKWebView` in its tree. Not recommended.
4. **If GPUI ever wins, start the grid from nvim-gpui rather than from zero.** It is MIT licensed and already solves multigrid, fonts, images and grid IME. Two caveats: it is on gpui 0.2.2, so it would first need porting to Zed main to get AccessKit, and its architecture is grid only, so the prose view is a new element beside its `GridElement`, not an extension of it. Reading its `doc/DEVELOP.md` IME section is worthwhile even if we stay on Tauri.

## How to decide: a time boxed spike

Do not decide on enthusiasm or on this note. Answer the gating question with a two or three day spike in a scratch repo outside gneovim:

1. Build a minimal GPUI app from a pinned Zed main commit (or the latest `gpui-pre` snapshot), with AccessKit left on (do not call `Application::inaccessible()`). Do not base the spike on nvim-gpui: it is on 0.2.2, which has no AccessKit, and the spike is about the prose half it does not have. Its `src/editor/input.rs` and `src/input.rs` are still good references for the `EntityInputHandler` part.
2. Make one custom element that lays out a few paragraphs of proportional text and implements `EntityInputHandler`.
3. Expose it to AccessKit as a `MultilineTextInput` with `TextRun` children, filling character offsets and widths from the real layout, and handle the set selection action.
4. Check with Accessibility Inspector that it reports `AXTextArea`, a correct `AXValue`, a settable `AXSelectedTextRange`, and sensible `AXBoundsForRange`.
5. Turn on Grammarly Desktop. Type a sentence with known errors, like "I willnot do it on today.", and see whether underlines appear in the right place and whether Fix lands correctly.
6. Then try VoiceOver, Look Up (Ctrl Cmd D), a CJK IME, and inline predictions.

Decision rule:

* If Grammarly underlines appear at the right place and Fix lands, GPUI is viable. Next step would be a second spike rendering one `ext_multigrid` grid, then a real plan in `plans/`.
* If Grammarly does not attach or places underlines wrong and it is not obviously our bug, stop. GPUI fails the founding requirement, and the useful takeaway is middle path 1.
* If the spike is blocked by AccessKit panics or build breakage on main, stop and revisit when a GPUI release ships with AccessKit and Zed turns it on for itself. That is the external signal worth watching.

## My recommendation

Not now. GPUI is genuinely tempting and a much better fit for the grid half of gneovim; nvim-gpui turns that from a guess into a demonstrated fact. But gneovim exists for the prose half, nvim-gpui has nothing to say about it, and the prose half depends on the exact layer GPUI is weakest at. Run the spike if the itch stays; it is cheap and settles the question with evidence instead of vibes. Independently of GPUI, the "one editor instead of two" idea is the most valuable thing this exercise surfaced, and it is worth its own note.

## Sources

* [gpui.rs](https://gpui.rs/), official site and docs index.
* [GPUI README](https://github.com/zed-industries/zed/blob/main/crates/gpui/README.md), stability statement.
* [gpui deep dive, July 2026](https://github.com/GoldStrikeArch/rust-gui-desktop-ecosystem-state/blob/main/report/03-gpui.md) (third party): release history, AccessKit PR #56065 and `Application::inaccessible()`, IME via `EntityInputHandler`, build times, RTL caret issue.
* [Buiy prior art notes on GPUI, May 2026](https://github.com/intendednull/buiy/blob/main/docs/prior-art/gpui/README.md) (third party): renderer backends, pre AccessKit accessibility state.
* [GPUI Kit / gpui-component](https://github.com/longbridge/gpui-component): component list, AccessKit, `gpui-pre` snapshots.
* [AccessKit macOS adapter](https://github.com/AccessKit/accesskit/tree/main/adapters/macos): text attribute selectors, checked in `src/node.rs` on 2026-10-17.
* [nvim-gpui](https://github.com/imkerberos/nvim-gpui), local checkout at `~/Developer/vim/guis/nvim-gpui`, read at v0.8.1 (`56baf61`): `README.md`, `doc/DEVELOP.md` (Architecture, System IME, Font fallback), `Cargo.toml`, `src/editor/input.rs`, `src/input.rs`, `src/widgets/text_input.rs`.
* Search results for `gpui-ce`, `gpui-pre-*`, and the docs.rs feed of standalone mirror crates, for the fragmentation picture.
