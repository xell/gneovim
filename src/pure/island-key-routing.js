// What happens to one keydown in a Markdown island: answer it here from the
// rendered layout, forward it to Neovim, or hold it back. Lifted out of
// main.js's keydown listener so the decision can be tested; see
// docs/island-key-routing-2026-10-05.md for why (four shipped bugs in this
// family, every one found in real use rather than by the suite).
//
// Pure apart from the two geometry reads it is given, which are CodeMirror
// questions ("where is one display line down", "where does the next prose word
// start") that only the view can answer. Every side effect -- preventDefault,
// queueing input, moving Neovim's cursor, centring the scroll -- stays with the
// caller, which also owns encoding the key and the IME textarea carve-out.
//
// `island` is an opaque identity token, compared with === only. Production
// passes the Island instance; tests pass a string.

// Hand-ported from fast-cursor-move.nvim's get_move_step
// (~/.local/share/nvim/lazy/fast-cursor-move.nvim/plugin/fast-cursor-move.lua),
// whose expr keymap resolves to `Ngj`/`Ngk` entirely inside Neovim, so the
// browser only ever sees plain `j`/`k`. Keep in sync with that plugin's
// ACCELERATION_LIMIT / ACCELERATION_TABLE_VERTICAL if it is ever retuned.
export const ACCEL_LIMIT_MS = 150;
export const ACCEL_TABLE = [7, 14, 20, 26, 31, 36, 40];

// Whether `key` continues a prefix that should keep protecting the next
// completion key (see `nativePending`) rather than let it decay: a run of
// digits (with a leading-zero carve-out, so "10w" keeps counting once already
// mid-count), an operator/register/bracket letter, or a text object prefix
// after an operator.
export function extendsNativePending(key, wasPending) {
  return (
    /^[1-9]$/.test(key) ||
    (wasPending && (key === "0" || /^[ai]$/.test(key))) ||
    /^[dcy><=!gz"'\[]$/.test(key)
  );
}

export function initialRoutingState() {
  return {
    // A Neovim multi-key command may be mid-parse, so the next key must stay
    // native. Decays after exactly the keystroke it protects.
    nativePending: false,
    // The island awaiting the second key of a Normal-mode `g`, with the
    // keydown itself held back until `gj`/`gk` or something else resolves it.
    // `event` is opaque here: the caller needs the original event to re-send
    // the `g` with its own selection-sync context.
    pendingG: null, // { island, event }
    // The island awaiting the second `z` of `zz`.
    pendingZ: null, // island
    // The island whose mode Neovim has not confirmed since a key that leaves
    // Normal mode. See Bug 6 and Bug 7 in
    // docs/markdown-island-visual-line-motion.md.
    modeUnconfirmed: null, // { island, at }
    accel: { direction: null, time: 0, count: 0 },
  };
}

// fast-cursor-move's hold-to-accelerate curve, as a pure step over `accel`.
function accelStep(accel, direction, now) {
  let { time, count } = accel;
  if (direction !== accel.direction) {
    time = 0;
    count = 0;
  } else {
    // `time === 0` is the plugin's own "just switched direction" sentinel;
    // treat it as infinitely stale rather than subtracting from zero, since
    // performance.now() starts near zero on page load and `now - 0` could read
    // as recent early in a session.
    const elapsed = time ? now - time : Infinity;
    count = elapsed > ACCEL_LIMIT_MS ? 0 : count + 1;
    time = now;
  }
  let step = ACCEL_TABLE.length;
  for (let i = 0; i < ACCEL_TABLE.length; i++) {
    if (count < ACCEL_TABLE[i]) {
      step = i + 1;
      break;
    }
  }
  return { accel: { direction, time, count }, step };
}

// True when this island is in a Normal mode solid enough to answer a motion key
// locally instead of forwarding it.
function localNormal(island, mode, state) {
  return (
    Boolean(island) && mode === "n" && state.modeUnconfirmed?.island !== island
  );
}

/**
 * @param input.key          event.key
 * @param input.plain        no meta/ctrl/alt/shift
 * @param input.island       island identity owning the cursor grid, or null
 *                           (also null while Neovim owns a command line)
 * @param input.mode         that island's last known Neovim mode
 * @param input.exitsNormal  does this key leave Normal mode on its own
 * @param input.punctuation  normalModePunctuation's answer, or null when it
 *                           does not apply (not Normal mode, not punctuation)
 * @param input.now          performance.now()
 * @param input.vertical     (forward, count) => {row, col} | null
 * @param input.word         () => {row, col} | null
 * @returns { state, verdict, releaseG }
 *   verdict.type is one of:
 *     cursor          answer locally, move Neovim's cursor to row/col
 *     forward         send this key to Neovim (caller encodes it)
 *     forwardKeys     send exactly these keys (the punctuation carve-out)
 *     holdG           keep this `g` back until the next key resolves it
 *     centerAndForward  `zz`: centre the island's scroll, Neovim still gets it
 *   releaseG is `{ island, event }` for a held `g` that must be sent first,
 *   carrying its own island because focus may have moved on since.
 *   clearVerticalGoal asks the caller to drop its cached gj/gk goal column,
 *   which lives with the geometry code because it is a pixel measurement.
 */
export function routeIslandKey(input, state) {
  const { key, plain, island, mode, exitsNormal, punctuation, now } = input;
  const next = { ...state, accel: { ...state.accel } };
  let releaseG = null;
  let clearVerticalGoal = false;

  // Vim's curswant rule: any key that is not itself part of a vertical run
  // invalidates the goal column, or the next gj/gk aims at a column that has
  // nothing to do with where the cursor now is. `g` is left alone because
  // whether it starts a gj/gk is only known once the next key arrives, and
  // every non-gj/gk resolution below clears the goal itself.
  if (!(localNormal(island, mode, next) && plain && /^[gjk]$/.test(key)))
    clearVerticalGoal = true;

  // Snapshot before the setter below can raise the flag for this very key (`g`
  // is itself one of the characters that raises it). Consumers positioned after
  // the decay line must read this, not the live flag: getting that wrong cost
  // us `dgj` swallowing an operator and `5j` freezing the app.
  const hadNativePendingBefore = next.nativePending;

  // A key that hands Normal mode to Insert/Replace/Select/Visual: distrust this
  // island's "n" until Neovim confirms, so keys typed inside that round trip
  // are not mistaken for Normal-mode motions. Deliberately not conditioned on a
  // pending prefix: that veto is what let Bug 7 in, since the flag survives
  // chains like `gg0` with nothing actually pending in Neovim.
  if (island && mode === "n" && exitsNormal)
    next.modeUnconfirmed = { island, at: now };

  // Second key of a held `g`: either it completes a local gj/gk, or the `g`
  // goes to Neovim and this key falls through to its own handling (gg, gU, g;,
  // ...). Runs before the punctuation path so a held `g` followed by `;` or
  // backtick still releases instead of being stranded.
  let skipGEntry = false;
  let gPrefixResolved = false;
  if (next.pendingG) {
    gPrefixResolved = true;
    const { island: pendingIsland, event: heldEvent } = next.pendingG;
    next.pendingG = null;
    if (pendingIsland === island && plain && (key === "j" || key === "k")) {
      const target = input.vertical(key === "j", 1);
      if (target) {
        next.pendingZ = null;
        return result(next, { type: "cursor", ...target }, releaseG, clearVerticalGoal);
      }
      // Already at the first/last display line: let Neovim's own gj/gk answer
      // this edge case.
      releaseG = { island: pendingIsland, event: heldEvent };
      clearVerticalGoal = true;
    } else {
      releaseG = { island: pendingIsland, event: heldEvent };
      clearVerticalGoal = true;
      skipGEntry = key === "g";
    }
  }

  // Normal-mode punctuation by physical key, even when a CJK input source
  // reports Process / keyCode 229 / a full-width character. Treated as a
  // possible mapping or operator prefix, so a following `w` stays native.
  if (punctuation != null) {
    if (island) next.nativePending = true;
    return result(
      next,
      { type: "forwardKeys", keys: punctuation === "<" ? "<lt>" : punctuation },
      releaseG,
      clearVerticalGoal,
    );
  }

  if (island && mode === "n" && plain && extendsNativePending(key, next.nativePending))
    next.nativePending = true;

  // `w` as prose navigation: Neovim's own `w` walks bytes, which is wrong for
  // CJK and for rendered markdown, so answer it from the document instead --
  // unless a prefix is pending, in which case Neovim is mid-command and must
  // see the key itself (`dw`, `2w`, `"aw`).
  if (localNormal(island, mode, next) && key === "w" && plain && !next.nativePending) {
    const target = input.word();
    if (target)
      return result(next, { type: "cursor", ...target }, releaseG, clearVerticalGoal);
  }

  // Decay after exactly the keystroke the flag exists to protect. It used to
  // only reset on `w`/Escape, so a `:` command left it raised for the rest of
  // the session and silently disabled both this and gj/gk.
  if (!extendsNativePending(key, next.nativePending)) next.nativePending = false;

  // First key of a possible `gj`/`gk`: hold it rather than forward it, since
  // which g-command this is only becomes clear with the next key. A `g` that
  // follows an operator or count (`dgj`, `"gj`) stays native.
  if (
    localNormal(island, mode, next) &&
    plain &&
    key === "g" &&
    !skipGEntry &&
    !hadNativePendingBefore
  ) {
    next.pendingZ = null;
    next.pendingG = { island, event: input.event };
    return result(next, { type: "holdG" }, releaseG, clearVerticalGoal);
  }

  // Plain j/k: what actually reaches the browser for fast-cursor-move.nvim's
  // remap, since its expr mapping resolves to `Ngj`/`Ngk` inside Neovim and
  // never produces a `g` keydown. `gPrefixResolved` keeps a literal typed
  // `gj`/`gk` out of the acceleration curve; `hadNativePendingBefore` is the
  // pre-decay snapshot, because `j`/`k` do not extend a pending run and the
  // decay above has already cleared the flag for this keystroke (this is the
  // `5j` freeze).
  if (
    localNormal(island, mode, next) &&
    plain &&
    !gPrefixResolved &&
    !hadNativePendingBefore &&
    (key === "j" || key === "k")
  ) {
    const stepped = accelStep(next.accel, key, now);
    next.accel = stepped.accel;
    next.pendingZ = null;
    const target = input.vertical(key === "j", stepped.step);
    // No target means the first/last display line: Neovim's own remapped j/k
    // answers that edge case.
    return result(
      next,
      target ? { type: "cursor", ...target } : { type: "forward" },
      releaseG,
      clearVerticalGoal,
    );
  }

  // `zz`: Neovim still gets both keys like any other command; the island also
  // centres its own pixel scroll on the second one, since Neovim's topline
  // change is invisible to it.
  if (island && mode === "n" && plain && key === "z") {
    if (next.pendingZ === island) {
      next.pendingZ = null;
      return result(next, { type: "centerAndForward" }, releaseG, clearVerticalGoal);
    }
    next.pendingZ = island;
  } else {
    next.pendingZ = null;
  }

  return result(next, { type: "forward" }, releaseG, clearVerticalGoal);
}

function result(state, verdict, releaseG, clearVerticalGoal) {
  return { state, verdict, releaseG, clearVerticalGoal };
}
