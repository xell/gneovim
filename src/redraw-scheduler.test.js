import { describe, expect, it, vi } from "vitest";
import { RedrawScheduler } from "./redraw-scheduler.js";

describe("RedrawScheduler", () => {
  it("coalesces batches while preserving operation order", () => {
    const callbacks = [];
    const render = vi.fn();
    const scheduler = new RedrawScheduler({
      requestFrame: (callback) => callbacks.push(callback),
      render,
    });

    scheduler.enqueue([{ op: "line", row: 1 }, { op: "cursor", row: 1 }]);
    scheduler.enqueue([{ op: "line", row: 2 }]);

    expect(callbacks).toHaveLength(1);
    callbacks.shift()();
    expect(render).toHaveBeenCalledWith([
      { op: "line", row: 1 },
      { op: "cursor", row: 1 },
      { op: "line", row: 2 },
    ]);
  });

  it("schedules a later frame for work enqueued during rendering", () => {
    const callbacks = [];
    let scheduler;
    const render = vi.fn(() => scheduler.enqueue([{ op: "cursor" }]));
    scheduler = new RedrawScheduler({
      requestFrame: (callback) => callbacks.push(callback),
      render,
    });

    scheduler.enqueue([{ op: "line" }]);
    callbacks.shift()();

    expect(callbacks).toHaveLength(1);
    expect(render).toHaveBeenCalledTimes(1);
  });
});
