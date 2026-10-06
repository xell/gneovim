# Testing the island keydown decision (proposed 2026-10-05)

Status: proposed, not started. Written after Bug 7 (`b6488c0`). Revisit once the fix has had enough real world use to be trusted on its own, so that a refactor landing on top of it cannot be confused with it.

## The problem

Every decision about what happens to a keystroke inside a Markdown island lives in one `addEventListener("keydown", ...)` in `src/main.js`, roughly 200 lines of interlocking conditions. Nothing tests any of it, because the listener needs Tauri, CodeMirror and a live Neovim to run at all. The 145 tests in the suite cover the pure helpers it calls (`keyToNvim`, `normalModePunctuation`, `exitsNormalMode`, `semanticWordTarget`, `foldRanges`) but never the decision that uses them.

Four bugs in this family have now shipped, and every one of them was found by Leo in real use rather than by the suite:

- `dgj` swallowing an operator, because a flag was read after the line that resets it
- `5j` leaving Neovim holding a dangling count, which froze the app until a force quit
- Bug 6, a `k` typed into freshly entered Insert mode answered as a Normal mode motion
- Bug 7, the Bug 6 fix declining to predict Insert after any prefix chain, so `gg0` then `o` then `w` lost the `w`

Each one is a single sentence to express as a test. Bug 7 would have read:

```js
// after gg0, `o` enters Insert, so the next key must go to Neovim
expect(route(["g", "g", "0", "o", "w"]).at(4)).toBe("forward");
```

and would have failed the moment the veto was written, instead of surfacing three weeks later during real writing.

## What the decision actually depends on

Worth listing, because the size of this state is the whole argument. The handler consults, in order: `imeComposing`, the font zoom shortcut, `session.cmdlineActive`, which island (if any) owns the cursor grid, whether the event is unmodified, the cached `islandVerticalGoal`, `islandNativeWPending` together with its pre keystroke snapshot `hadNativePendingBefore`, the `islandModeUnconfirmed` latch, the held `islandPendingG` with its `gPrefixResolved` and `skipGEntry` companions, `islandPendingZ`, `normalModePunctuation`, `isl.mode`, the acceleration state (`accelPrevDirection`, `accelPrevTime`, `accelMoveCount`), the encoded key from `keyToNvim`, and finally whether the hidden IME textarea should take the key instead.

The outcomes are: answer locally with a cursor placement, forward the key to Neovim, hold the key back (the `g` prefix), hand it to the IME textarea, or run a side effect such as `centerCursor` for `zz`.

## Proposed shape

Move the decision, not the effects, into `src/pure/island-key-routing.js`:

```js
routeIslandKey(event, state) -> { verdict, keys?, count?, effects? }
```

where `state` is a plain object holding exactly the values listed above, and `verdict` is one of `answer-locally`, `forward`, `hold`, `ime`, `ignore`. The listener keeps everything that touches the world: `preventDefault`, the input queue, the CodeMirror geometry calls, the latch and flag assignments the router asks for.

The one wrinkle is that two verdicts depend on rendered geometry (`verticalMotionTarget`, `semanticWordTarget`), which cannot be pure. Either the router returns `answer-locally` and the listener falls back to forwarding when the geometry call returns null (which is what it already does today), or the geometry is injected as a function on `state`. The first is simpler and matches the current control flow.

## Discipline for doing it

1. Write the tests first, against the current behaviour, including the four bugs above and the sequences that were deliberately made to work: `diw`, `3i`, `5j`, `dgj`, `cw` then a word, `:w` then `<CR>`, `zz`, literal `gj`/`gk`, accelerated `j`/`k` counts, the punctuation path with a CJK input source, and a command line swallowing nothing.
2. Only then move code, with no behaviour change intended. Any test that has to change during the move is a bug being introduced or a behaviour nobody knew about, and should be discussed rather than edited to pass.
3. Land it on its own, with nothing else in the commit.

Estimated at about an hour. It changes no behaviour by design, which is also what makes it easy to verify: the app should feel identical.

## Related gaps found while investigating Bug 7

Not part of this work, recorded so they are not lost. None of these has been confirmed live, and none is known to have bitten Leo yet. All are predictions from reading the code, and each is cheap to check once the routing has tests.

- `extendsNativePending` models digits and the operator class `d c y > < = ! g z " ' [`, but not the prefixes that make Neovim wait for a literal character: `f F t T r m q @` and backtick. So `fw` should land on the next word instead of the next `w`, `fk` should move a line up, and `rw` should move instead of replacing, each leaving Neovim mid command. Check with `fw` on a line whose later text contains a `w`.
- `dfw` and `ctw` are the same gap with an operator already pending, which is the shape that froze the app in the `5j` case.
- hop.nvim and EasyMotion block in `getchar` while their hints are up, so `mode()` stays `n` and no echo ever fires. Leo's hop keys are `etovxqpdygfblzhckisuran`, which include `g` and `k`, and `<Leader>/` runs `hint_patterns`, which reads a pattern character by character. A `w`, `j`, `k` or `g` typed there is a candidate for being answered locally. `displayDecorations.easyMotionOverlay` already knows when such an overlay is visible, so suppressing local answers while it is up is a plausible bounded fix.
- `gi`, `gI` and `gR` enter Insert but are not predicted, since the `g` is held client side and the second key arrives with a pending prefix. The `islandPendingG` resolution is the natural place to predict it.
- Counted inserts (`3i`, `3o`) now predict correctly after Bug 7, but a mapping or `:startinsert` that lands in Insert still cannot be predicted at all. A headless probe on 2026-10-05 confirmed those produce a single `n:i` echo with no intermediate state for the client to see.

## Seen since: the latch stuck after a fast `:` command (2026-10-06)

Unlike the list above, this one was observed in real use, though only through the log, not reproduced on purpose. Leo's log showed a run of `island: mode unconfirmed 46667ms after the mode key, forwarding j instead of answering it` lines, the latch having been set about 46 seconds earlier and never cleared. The log around the moment it was set shows the island hidden from accessibility for a few seconds, which is what a command line does, and Leo had just been typing `:setlocal winbar=...` style commands from a test list.

The likely mechanism is the Bug 6 race running the other way. `:` is forwarded, and the next key (`s` of `:setlocal`) arrives before Neovim's `cmdline_show` echo has set `session.cmdlineActive`. So the handler still sees the island in Normal mode, `exitsNormalMode` matches `s`, and the latch is set. The `s` actually lands in the command line, Neovim never enters Insert, and the `n` echo after the command line closes is deliberately ignored by the latch. It then stays set until the next real Insert or Visual entry.

Cost: no lost keys, but plain `j`/`k`/`w`/`g` go to Neovim instead of being answered locally for that whole stretch, so on soft wrapped prose `j`/`k` follow Neovim's own fixed width wrap rather than the island's visual lines. Any `:` command whose second character is in `EXITS_NORMAL_MODE` (`:s`, `:set`, `:sort`, `:vsplit`, `:Obsession`) can trigger it when typed fast.

Proposed fix, not yet made: also clear the latch when a command line opens. An open command line is Neovim saying the key went somewhere other than Insert, which fits the latch's own rule of being cleared by any echo that is not plain Normal. Test sequence for the router: `:` `s` `e` `t` `<CR>` then `j` must be `answer-locally`, not `forward`.
