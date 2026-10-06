import { describe, expect, it } from "vitest";
import {
  extendsNativePending,
  initialRoutingState,
  routeIslandKey,
} from "./island-key-routing.js";

const ISLAND = "island-1";

// Feed a key sequence through the router the way the keydown listener does,
// threading state, and report one verdict per key. `keys` entries are either a
// plain key string or an object overriding any input field, so a sequence can
// mix in a punctuation key, a different island, a mode change, or a clock.
function route(keys, options = {}) {
  let state = options.state ?? initialRoutingState();
  const verdicts = [];
  let now = options.now ?? 1000;
  for (const entry of keys) {
    const spec = typeof entry === "string" ? { key: entry } : entry;
    now += spec.gap ?? 1000; // far apart enough to never accelerate by accident
    const input = {
      key: spec.key,
      plain: spec.plain ?? true,
      island: "island" in spec ? spec.island : ISLAND,
      mode: spec.mode ?? options.mode ?? "n",
      exitsNormal: spec.exitsNormal ?? /^[iIaAoOsSCRvV]$/.test(spec.key),
      punctuation: spec.punctuation ?? null,
      now,
      event: spec.event ?? `event:${spec.key}`,
      vertical: spec.vertical ?? options.vertical ?? (() => ({ row: 5, col: 2 })),
      word: spec.word ?? options.word ?? (() => ({ row: 7, col: 0 })),
    };
    const out = routeIslandKey(input, state);
    state = out.state;
    verdicts.push({ ...out.verdict, releaseG: out.releaseG, clearVerticalGoal: out.clearVerticalGoal });
  }
  return { verdicts, state, types: verdicts.map((v) => v.type) };
}

describe("routeIslandKey, local answers", () => {
  it("answers a bare w from the document", () => {
    const { verdicts } = route(["w"]);
    expect(verdicts[0]).toMatchObject({ type: "cursor", row: 7, col: 0 });
  });

  it("answers plain j/k with the acceleration count", () => {
    const steps = [];
    route(["j", "j"], {
      vertical: (forward, count) => {
        steps.push({ forward, count });
        return { row: 1, col: 0 };
      },
    });
    expect(steps).toEqual([
      { forward: true, count: 1 },
      { forward: true, count: 1 },
    ]);
  });

  it("accelerates while the key is held, and resets on a direction change", () => {
    const counts = [];
    const vertical = (_forward, count) => {
      counts.push(count);
      return { row: 1, col: 0 };
    };
    route(Array.from({ length: 10 }, () => ({ key: "j", gap: 20 })), { vertical });
    expect(counts.at(-1)).toBeGreaterThan(1);
    const after = counts.at(-1);
    const { verdicts } = route([{ key: "k", gap: 20 }], { vertical });
    expect(verdicts[0].type).toBe("cursor");
    expect(counts.at(-1)).toBe(1); // direction change restarts the curve
    expect(after).toBeGreaterThan(1);
  });

  it("falls back to Neovim when the geometry has no answer", () => {
    expect(route(["w"], { word: () => null }).types).toEqual(["forward"]);
    expect(route(["j"], { vertical: () => null }).types).toEqual(["forward"]);
  });

  it("holds a bare g, then completes gj locally", () => {
    const { types, verdicts } = route(["g", "j"]);
    expect(types).toEqual(["holdG", "cursor"]);
    expect(verdicts[1].releaseG).toBeNull();
  });

  it("releases a held g when the next key is not j/k", () => {
    const { types, verdicts } = route(["g", "g"]);
    expect(types).toEqual(["holdG", "forward"]);
    expect(verdicts[1].releaseG).toEqual({ island: ISLAND, event: "event:g" });
  });

  it("releases the held g when gj has nowhere to go", () => {
    const { types, verdicts } = route(["g", "j"], { vertical: () => null });
    expect(types).toEqual(["holdG", "forward"]);
    expect(verdicts[1].releaseG).toEqual({ island: ISLAND, event: "event:g" });
  });

  it("centres the island on the second z of zz, and still forwards both", () => {
    const { types } = route(["z", "z"]);
    expect(types).toEqual(["forward", "centerAndForward"]);
  });
});

describe("routeIslandKey, Neovim is mid-command", () => {
  it("leaves w native after an operator (dw)", () => {
    expect(route(["d", "w"]).types).toEqual(["forward", "forward"]);
  });

  it("leaves w native after a count (2w)", () => {
    expect(route(["2", "w"]).types).toEqual(["forward", "forward"]);
  });

  it("leaves w native inside a text object (diw)", () => {
    expect(route(["d", "i", "w"]).types).toEqual(["forward", "forward", "forward"]);
  });

  // dgj used to defer the `g` as a fresh pending pair, so the `j` became a
  // silent cursor move and the delete was stranded in Neovim.
  it("leaves g native after an operator (dgj)", () => {
    expect(route(["d", "g", "j"]).types).toEqual(["forward", "forward", "forward"]);
  });

  // 5j used to drop the count and answer j locally, leaving Neovim waiting for
  // a motion that never came, which froze the app.
  it("leaves j native after a count (5j)", () => {
    expect(route(["5", "j"]).types).toEqual(["forward", "forward"]);
  });

  it("protects only the one keystroke after the prefix", () => {
    // `2w` is native, but the `w` after it is prose navigation again.
    expect(route(["2", "w", "w"]).types).toEqual(["forward", "forward", "cursor"]);
  });

  it("keeps a punctuation key native and raises the same protection", () => {
    const { types } = route([{ key: ";", punctuation: ";" }, "w"]);
    expect(types).toEqual(["forwardKeys", "forward"]);
  });
});

describe("routeIslandKey, mode is not confirmed yet", () => {
  // Bug 6: a k typed into freshly entered Insert mode was answered as a
  // Normal-mode motion, because isl.mode lags Neovim by one echo.
  it("forwards a key typed right after i, before Neovim has echoed", () => {
    expect(route(["i", "k"]).types).toEqual(["forward", "forward"]);
    expect(route(["o", "w"]).types).toEqual(["forward", "forward"]);
    expect(route(["a", "j"]).types).toEqual(["forward", "forward"]);
  });

  // Bug 7: the prediction used to be vetoed whenever a prefix was pending, and
  // that flag survives chains like gg0 with nothing pending in Neovim.
  it("predicts Insert even when a prefix flag is still raised", () => {
    expect(route(["g", "g", "0", "o", "w"]).types).toEqual([
      "holdG",
      "forward",
      "forward",
      "forward",
      "forward",
    ]);
    expect(route(["0", "i", "w"]).types).toEqual(["forward", "forward", "forward"]);
    expect(route(["3", "o", "j"]).types).toEqual(["forward", "forward", "forward"]);
    expect(route([{ key: "}", punctuation: "}" }, "o", "k"]).types).toEqual([
      "forwardKeys",
      "forward",
      "forward",
    ]);
  });

  it("answers locally again once Neovim confirms Insert and then Normal", () => {
    const first = route(["i"]);
    const confirmed = {
      ...first.state,
      modeUnconfirmed: null, // what applyCursor does on a non-Normal echo
    };
    expect(route(["w"], { state: confirmed }).types).toEqual(["cursor"]);
  });

  it("keeps the latch to one island, not all of them", () => {
    const { state } = route(["i"]);
    expect(route([{ key: "w", island: "island-2" }], { state }).types).toEqual(["cursor"]);
  });
});

describe("routeIslandKey, no island owns the cursor", () => {
  it("forwards everything, including punctuation, untouched", () => {
    const { types } = route(
      [
        { key: "w", island: null },
        { key: "j", island: null },
        { key: ";", island: null, punctuation: ";" },
      ],
      {},
    );
    expect(types).toEqual(["forward", "forward", "forwardKeys"]);
  });

  it("still releases a g held by an island when focus has moved away", () => {
    const { verdicts } = route(["g", { key: "j", island: null }]);
    expect(verdicts[1]).toMatchObject({
      type: "forward",
      releaseG: { island: ISLAND, event: "event:g" },
    });
  });
});

describe("routeIslandKey, the goal column", () => {
  it("survives a run of vertical keys and dies on anything else", () => {
    const { verdicts } = route(["j", "j", "h", "k"]);
    expect(verdicts.map((v) => v.clearVerticalGoal)).toEqual([false, false, true, false]);
  });
});

describe("extendsNativePending", () => {
  it("covers counts, operators, registers and text objects", () => {
    for (const key of ["1", "9", "d", "c", "y", "g", "z", '"', "'", "["])
      expect(extendsNativePending(key, false)).toBe(true);
    expect(extendsNativePending("0", false)).toBe(false); // 0 is a motion
    expect(extendsNativePending("0", true)).toBe(true); // ... unless mid-count
    expect(extendsNativePending("i", true)).toBe(true); // diw
    expect(extendsNativePending("w", true)).toBe(false);
  });
});
