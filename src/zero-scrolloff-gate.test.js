import { describe, expect, it, vi } from "vitest";
import { ZeroScrolloffGate } from "./zero-scrolloff-gate.js";

function fixture({ easyMotion = false } = {}) {
  const timers = new Map();
  let next = 1;
  const state = { easyMotion };
  const applyZero = vi.fn();
  const gate = new ZeroScrolloffGate({
    setTimer: (callback) => {
      const id = next++;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    isEasyMotion: () => state.easyMotion,
    applyZero,
  });
  const fire = () => {
    const [id, callback] = [...timers.entries()][0];
    timers.delete(id);
    callback();
  };
  return { applyZero, fire, gate, state, timers };
}

describe("ZeroScrolloffGate", () => {
  it("keeps the current scrolloff while a drop to zero waits, then applies it once", () => {
    const { applyZero, fire, gate, timers } = fixture();
    expect(gate.next(10, 0)).toBe(10);
    expect(timers.size).toBe(1);
    fire();
    expect(applyZero).toHaveBeenCalledOnce();
    // The bug: the delayed step re-entered the gate and re-armed itself
    // forever, re-applying a stale cursor and mode every 80ms.
    expect(timers.size).toBe(0);
  });

  it("applies any other change at once, and lets it supersede a pending zero", () => {
    const { applyZero, gate, timers } = fixture();
    expect(gate.next(10, 4)).toBe(4);
    expect(gate.next(10, 0)).toBe(10);
    expect(gate.next(10, 10)).toBe(10); // restored before the wait was over
    expect(timers.size).toBe(0);
    expect(applyZero).not.toHaveBeenCalled();
  });

  it("drops the zero when EasyMotion turns out to own it", () => {
    const { applyZero, fire, gate, state, timers } = fixture();
    gate.next(10, 0);
    state.easyMotion = true;
    fire();
    expect(applyZero).not.toHaveBeenCalled();

    gate.next(10, 0);
    gate.cancel(); // what the display bridge does once it sees the matches
    expect(timers.size).toBe(0);
  });

  it("applies a zero at once while EasyMotion is already known, as before", () => {
    const { gate, timers } = fixture({ easyMotion: true });
    expect(gate.next(10, 0)).toBe(0);
    expect(timers.size).toBe(0);
  });
});
