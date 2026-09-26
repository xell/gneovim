# gj/gk visual-line motion in the Markdown island, and four bugs it took to get there

## The question that started it

Leo noticed that `gj`/`gk` in the live-preview island landed on the exact
same row/col as grid mode, and asked whether that was deliberate syncing or
a coincidence. It is a coincidence, and a structural one: every key,
including `gj`/`gk`, is forwarded raw to Neovim (`src/main.js`'s keydown
listener, `IslandInputQueue.input`), and Neovim computes the motion using
its own display-line wrap, based on the real grid column width of that
window. The island shares that same underlying nvim window with grid mode
(`ext_multigrid`, just rendered through CodeMirror instead of raw glyphs),
so the two modes get an identical answer from an identical computation.
Neovim's wrap point has no idea about CodeMirror's proportional markdown
font, headings, or concealed syntax, so it will generally not match what
the island actually shows as a wrapped line. `w` already had a deliberate
client-side override for exactly this kind of mismatch (`semanticWordTarget`
in `src/pure/semantic-word.js`); `gj`/`gk` never got the equivalent
treatment.

## The feature: local visual-line motion

The fix follows the same shape as the existing `w` override:
`Island.verticalMotionTarget(forward, count)` asks CodeMirror's own
`view.moveVertically()`, the primitive the default ArrowUp/ArrowDown
commands are built on, for the next line up/down in the real rendered
layout, converts the result back to a Neovim `{row, col}`, and reports it
to Neovim with the same `nvim_win_set_cursor` RPC (`queueNvimCursor`) the
`w` override already used, so the statusline stays authoritative.

A `g` press in a Markdown island's Normal mode is now held back
(`islandPendingG`) instead of forwarded immediately, since whether it means
`gj`/`gk` or some other g-command (`gg`, `gw`, `g;`, ...) is only known once
the next key arrives. `islandVerticalGoal` mirrors Vim's own curswant, the
remembered horizontal target a run of vertical presses tries to keep
hitting even through short lines.

## fast-cursor-move.nvim: the literal keys were never the real target

Leo's actual daily driver remaps plain `j`/`k` to an accelerating `Ngj`/
`Ngk` via an `expr` keymap
(`~/.local/share/nvim/lazy/fast-cursor-move.nvim/plugin/fast-cursor-move.lua`),
entirely inside Neovim. The browser never sees a `g` keydown for that: it
only ever sees `j`/`k`. So the literal-`gj`/`gk` interception above, while
correct, answered a case Leo rarely actually triggers by hand. Plain `j`/`k`
in a Markdown island's Normal mode is now intercepted directly, with the
plugin's own acceleration curve ported by hand into `accelStep()` (same
`ACCEL_LIMIT_MS`/`ACCEL_TABLE` constants, same hold-timing logic), so an
accelerated multi-line move is still computed and reported in one pass
through `verticalMotionTarget(forward, count)`.

## Bug 1: column 0 on a freshly mounted island

First live test: `gj`/`gk` on a freshly opened preview always snapped to
column 0, regardless of the actual starting column. Pulled CodeMirror's
real `moveVertically` source
(`raw.githubusercontent.com/codemirror/view/main/src/cursor.ts`) rather
than guess further:

```js
let startCoords = view.coordsAtPos(startPos, ...)
if (startCoords) {
  if (goal == null) goal = startCoords.left - rect.left   // real measured pixel column
} else {
  let line = view.viewState.lineBlockAt(startPos)
  if (goal == null) goal = Math.min(rect.right - rect.left, view.defaultCharacterWidth * (startPos - line.from))  // degraded fallback
}
```

When `coordsAtPos` cannot find laid-out geometry for the starting position
yet (true right after an island first mounts, before the viewport has
measured anything), `moveVertically` silently falls back to a monospace
width estimate instead of the real rendered pixel column. `verticalMotionTarget`
now calls `coordsAtPos` itself first and returns `null` (falling back to
Neovim's own native `gj`/`gk` for that one keystroke) rather than ever
trusting that degraded estimate.

## Bug 2: a wrong diagnosis, then the real one, for "toggle off/on breaks it"

Leo reported that after `:MarkdownLivePreviewOff` then `On`, `gj`/`gk` broke
again, and pressing `g` (which he'd noticed made a `which-key.nvim` popup
appear once, then not again) seemed to fix it. First fix attempt: a code
comment in `Island.applyReset` said a reset can reuse the same `Island`
object across a buffer reattach, so `islandVerticalGoal` was cleared there
whenever it belonged to the island being reset. Reasonable in principle,
and still correct for the case that comment actually describes (an `:e`
buffer switch within a persistent window), but it did not fix Leo's repro,
because it targeted the wrong lifecycle. Only after actually reading
`IslandManager.reconcile()` (`src/island-manager.js`) did it become clear
that toggling live preview off then on does not reuse the island at all: it
fully `destroy()`s the old one and `createIsland()`s a fresh one. The first
fix was a no-op for this specific scenario, not wrong, just answering a
question that was not the one being asked.

Rather than guess a third time, temporary `jlog()` calls were added at
every gate in the keydown handler and inside `verticalMotionTarget`, and
the real log (`~/Library/Logs/com.xell.gneovim/gneovim.log`) showed the
actual mechanism directly: `islandNativeWPending` was stuck `true` on every
single `j`/`k` press after the toggle, so the acceleration block's
`!islandNativeWPending` guard failed every time and every press fell
through to raw `nvim_input`, i.e. Neovim's own native remap, i.e. exactly
"the old way."

`islandNativeWPending` exists to protect a completion key (`w`, now also
`j`/`k`) from being hijacked when it follows an operator/register/digit
prefix. It was only ever reset by a literal `w` or `Escape` keypress. Colon
(`:`, Shift+Semicolon) goes through `normalModePunctuation`, which sets
this flag unconditionally before Neovim's command line even opens (to
protect a possible following `"aw`-style combo), and running the toggle
command with `<CR>` never touches `w` or `Escape`, so the flag simply never
came back down for the rest of the session, silently disabling both this
feature and the pre-existing `w` override until a stray `w`/`Escape`
eventually happened to clear it. This was a real, previously undiscovered
bug in the older `w` feature too, just never obvious there because a single
misfired word jump is easy to miss.

Fix: `extendsNativePending(key, wasPending)` is now the single predicate
used both to set the flag and to decide whether to keep it set, so it
decays after the very next keystroke that is not itself a prefix character,
instead of lingering until an unrelated future `w`/`Escape`.

## Bug 3: the cursor "getting stuck" at one column

Next live report: after some navigation, `gj`/`gk` would land on the same
column over and over, and nothing (including `h`/`l`/`0`/`$` or a click)
could change it. This was the general case of a gap already flagged as a
risk while designing `islandVerticalGoal` in the first place, and not
closed: it was only ever reset in `applyReset` and one narrow `gj`/`gk`
fallback branch, never on the general case Vim's own curswant handles by
design, resetting on literally any key that is not itself a continuing
vertical motion. Fixed with one check at the very top of the keydown
handler: any key other than `j`, `k`, or `g` (in a Normal-mode island)
clears `islandVerticalGoal` before anything else runs.

## Bug 4: `5j` freezing the whole app

The same class of mistake as bug 2's real fix recurred, and caused a worse
failure this time. Fixing bug 2 added a general reset line for
`islandNativeWPending` that runs partway through the handler; the plain
`j`/`k` acceleration block, added earlier, sits after that reset and was
still reading the live (already-reset) `islandNativeWPending` instead of a
pre-reset snapshot. Since `j`/`k` are not prefix-continuation characters,
the reset always fired for them before the acceleration block's own guard
ran, so a digit-prefixed motion like `5j` never actually fell back to
Neovim: `5` reached Neovim raw (leaving it holding a dangling `count=5`,
waiting indefinitely for a motion that would complete it), and `j` was
handled entirely locally, silently dropping the count and never sending
Neovim the key it was waiting on.

This is the identical ordering mistake already caught and fixed once for
the `g`-entry block (`dgj`/`cgj` swallowing an operator, a few commits
earlier in this same session): a flag that is both read and reset within
one keydown tick needs a pre-tick snapshot (`hadNativePendingBefore`) for
any consumer positioned after the reset, not the live value. Fixed by
switching the acceleration block to `hadNativePendingBefore` too, and this
time auditing every remaining read of `islandNativeWPending` in the file
(there were three: the `w` check, which runs before the reset line and so
was never affected; and the two now-fixed spots) rather than assuming one
fix was the only one needed.

Confirmed live: not fully certain a dangling Neovim count alone explains
needing a force quit rather than just a misbehaving next keystroke. If this
recurs, check whether the `nvim` child process itself is pegged at high CPU
at the moment of the freeze (a second, Neovim-side issue, e.g. a hit-enter
prompt per the "nvim headless/embed quirks" memory) versus the UI simply
being unresponsive while `nvim` sits idle.

## Bug 6: a `k` typed in Insert mode moving the cursor up

(Bug 5, `gk` stepping over several real lines at once instead of into them,
was fixed in `c320e20` and lives only in that commit message.)

Leo: "sometimes, in Live Preview mode, in insert mode, typing `k` will move
the cursor up *in the insert mode* rather than typing the actual character",
with no reliable repro, "it occurs from time to time".

That is the signature of this feature's one unsynchronized assumption. Every
gate here asks `isl.mode === "n"`, and `isl.mode` is only ever written by the
`gnv_cursor` echo (`Island.applyCursor`), one full round trip behind the
keystroke that caused the mode change: `nvim_input` through the Tauri
command, Neovim processing it, `ModeChanged`, `rpcnotify`, `bridge.rs`, a
Tauri event, the listener. Nothing anywhere holds keystrokes back while that
is in flight, so an `i`/`a`/`o` followed quickly enough by a `k` finds
`isl.mode` still reading `"n"`: the acceleration block answers it locally,
`preventDefault()`s it, and reports a cursor one display line up. Insert mode
never sees the key. The same window makes a `w` a word jump and a `g` a
swallowed prefix.

The handler already knew this, in two places, for a narrower case: both the
`g`-entry and plain-`j`/`k` comments say `isl.mode` "lags Neovim's real mode
by one async echo, so a fast `d` then `g` can still see mode `n`", and guard
against it with `hadNativePendingBefore`. Operator pending was covered
because the client tracks it locally (`islandNativeWPending`); the other
direction out of Normal mode, into Insert, was not tracked at all.

Fix: predict it the same way. `exitsNormalMode(event)`
(`src/pure/keymap.js`) names the keys that leave Normal mode on their own
(`i I a A o O s S C R v V`, no modifiers, operator prefixes deliberately
excluded since `islandNativeWPending` already owns those), and
`islandModeUnconfirmed` holds the island whose mode Neovim has not confirmed
since one of them was forwarded. `islandLocalNormal(isl)` replaces the raw
`isl && isl.mode === "n"` test at every local-answer gate: the
`islandVerticalGoal` reset, the `w` jump, the `g` entry, and the `j`/`k`
acceleration.

The clearing rule is the part worth remembering: the latch is released only
by an echo reporting a mode that is *not* `"n"`, never by an `"n"` echo. An
echo emitted before the keystroke was processed (the cursor set from the
`j`/`k` that preceded the `i`, say) also reports `"n"` and can arrive at any
point inside the window, so clearing on it would reopen exactly the gap being
closed. A wrong prediction therefore leaves the latch set until the next real
mode change, which costs nothing but local answers: `j`/`k`/`w`/`g` fall back
to Neovim's own handling for those keystrokes, the same fallback the feature
already takes at a first/last display line or on a freshly mounted island.
Failing towards "Neovim decides" is always safe here; failing towards
"the client decides" is what produced this bug.

Still open by design, same root cause, different keys: entering Insert mode
some way the client cannot see (`:startinsert`, a mapping that ends in Insert
mode, `3i`) is not predicted, and the `normalModePunctuation` path keeps
using the lagging mode on purpose, since suppressing it would send Neovim a
full-width CJK character instead of the physical key, i.e. a lost keystroke
rather than a safe fallback.

### Confirmed live, both directions, 2026-09-26

Leo asked the right question about the first fix: if he cannot reproduce the
bug, does it not recurring prove anything? It does not, since he could not
reproduce it before the fix either. So the race was made deterministic in the
real app instead, behind two temporary constants, and A/B'd.

Getting the harness right took three tries, and the failures are the
interesting part:

1. Delay every `gnv_cursor` echo by 300ms. Correct in principle, unusable in
   practice: "it's very very stutter and laggy while typing", because the
   caret and scrolling ride the same feed.
2. Delay only the *mode transition* echo by 300ms, which restored normal
   typing. Leo typed `ikill` and it came out clean, seemingly falsifying the
   whole diagnosis. The log said otherwise: zero latch events, because he had
   been typing in `/Applications/gneovim.app`, a release build with none of
   this code in it. Worth checking which binary a live test is actually
   running before believing its result.
3. Delay widened to 1500ms in the dev window. Still no latch events: the log
   showed 2 to 3 seconds between his `i` and the next letter every time. A
   timer cannot bracket a window whose closing depends on how fast somebody
   types.
4. Hold the mode transition echo until exactly one further keydown has been
   handled. That is the real race, one keystroke wide, and it is independent
   of typing speed. Released from a `setTimeout(..., 0)` at the top of the
   keydown handler so the key under test is the one that sees the stale mode.

With that harness, the same keystrokes in the same state produced opposite
outcomes decided by one constant, which is the part that makes this a proof
rather than an absence of complaints:

```
fix off: key=k win=1000 mode=n latch=set -> ANSWERING k -> answering k locally, target=3:0
fix on : key=k win=1000 mode=n latch=set -> forwarding k   (no local answer follows)
```

Same for `w` (553ms), `g` (1050ms), and `j` (434ms). The `k` case was also
caught once at a real 219ms, with a 300ms simulated echo, before the harness
was speed-independent.

The `jlog` that reports a rescued keystroke and how late the echo was is
deliberately kept. It fires only inside the window the latch covers, so a
whole prose session can pass without one, and it is the only way to watch this
race rather than infer it: read
`~/Library/Logs/com.xell.gneovim/gneovim.log`.

One harness artefact worth recognising if it is ever reintroduced: while the
echo is held, the caret stays a block until the next keystroke, since the
caret shape is drawn from the same mode feed. Leo spotted that immediately.

## Scope: Normal mode only, deliberately

Every gate added for this feature (`islandVerticalGoal`'s reset,
`extendsNativePending`'s set/reset, the `g`-entry block, the plain-`j`/`k`
block) explicitly requires `isl.mode === "n"`. Visual, Visual-line, and
Visual-block all fail every one of these checks and fall straight through
to raw forwarding, so `j`/`k` in Visual mode reach Neovim exactly as
before, unmodified by any of this. That mirrors the existing `w` and `zz`
features, both also Normal-mode only, and was a deliberate choice: Visual
mode still has fast-cursor-move.nvim's acceleration applying to Neovim's
own grid-column-based `gj`/`gk` (the plugin maps `{"n","v"}` both), so the
original "visual jumping" complaint still applies there. Confirmed with
Leo this is the wanted scope for now; extending to Visual/Visual-block
would need to move the Visual selection's head instead of a bare cursor,
with its own care around block-wise column semantics, and was deliberately
left as a separate follow-up rather than folded into this change.

## Known, unfixed: macro recording

`queueNvimCursor` reports the computed position to Neovim via a direct
`nvim_win_set_cursor` RPC (`nvim_cursor_set` in `bridge.rs`), not via
`nvim_input`. Neovim's macro recording (`qa` ... `q`) only captures the
`nvim_input` stream, so a macro recorded while using `gj`/`gk` (literal or
accelerated) inside an island will not capture those vertical moves at all.
Flagged to Leo, not yet fixed. Macro playback itself is unaffected, since
it replays entirely inside Neovim and never generates real DOM keydown
events for the browser to intercept in the first place.

## Lessons

**A flag set and reset within the same keydown tick needs a pre-tick
snapshot for any consumer that runs after the reset, not the live value.**
Got this wrong twice in the same session (`dgj`, then `5j`) before finally
auditing every remaining read of the flag instead of only fixing the one
instance in front of me. When adding a *third* consumer of a flag like this
in the future, check where it sits relative to the reset line first, before
writing the guard.

**Don't trust a code comment's claim about object lifecycle for a
scenario it wasn't written about.** `applyReset`'s comment about reused
`Island` objects was true, just not for the toggle-off/on path being
debugged. The fix built on it was harmless but useless for that specific
bug, and cost a full round trip to discover. Should have read
`IslandManager.reconcile()` directly before trusting the comment's implied
scope.

**When a client-side feature replaces a whole class of Neovim motion, it
has to replicate the motion's full semantics, not just its happy path.**
`islandVerticalGoal` needed Vim's curswant reset rule (any non-vertical key
invalidates it) from the very first version. It was only ever added
narrowly, for the specific paths visible at the time, which is exactly why
it needed a second pass once real use surfaced the gap.

**Diagnostic logging found the real bug in one round trip, after two
rounds of guessing wrong found nothing.** Reasoning about async timing and
object identity from the code alone produced two plausible-sounding wrong
theories in a row. Adding temporary `jlog()` calls at the actual decision
points and reading the real log should have been the first move, not the
third.

**To prove a fix for an intermittent race, make the race deterministic in
the real app and A/B it with one constant.** Not reproducing it afterwards is
worthless evidence when it was never reproducible on demand to begin with. And
build the harness around the event, not around a timer: the window here closes
when an echo arrives, so holding the echo for one keystroke reproduces it every
time, while 300ms and 1500ms delays both missed depending on typing speed.
Check which binary the live test is running before trusting a negative result.

**An intermittent "the wrong thing happened instead of my keystroke" is a
mode-lag bug until proven otherwise.** The client's idea of Neovim's mode is
always one round trip old, and no part of this feature waits for it. When a
predicted-state latch fixes that, decide deliberately which echo is allowed
to clear it: an echo that predates the keystroke reports the old state and is
indistinguishable from a correction.

**A client-side interception that silently swallows a Normal-mode key
must be sure Neovim isn't still mid-parsing a multi-key command it is
waiting to complete.** `5j` is the clearest case: Neovim received the `5`
and was left waiting for a motion that never arrived, because the `j` that
would have completed it was consumed entirely on the client side instead.
Any future interception of a bare motion key needs to ask not just "should
I handle this myself" but "does Neovim still expect this exact key to
complete something I already let it see."
