import { describe, expect, it, vi } from "vitest";
import { IslandInputQueue } from "./island-input-queue.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

describe("IslandInputQueue", () => {
  it("orders cursor placement before subsequent input", async () => {
    const cursorRequest = deferred();
    const client = {
      cursorSet: vi.fn(() => cursorRequest.promise),
      input: vi.fn(() => Promise.resolve()),
    };
    const queue = new IslandInputQueue({
      client,
      winId: 12,
      log: vi.fn(),
    });

    queue.cursor(3, 7);
    queue.input("x");
    await Promise.resolve();
    expect(client.cursorSet).toHaveBeenCalledWith(12, 3, 7);
    expect(client.input).not.toHaveBeenCalled();

    cursorRequest.resolve();
    await queue.pending;
    expect(client.input).toHaveBeenCalledWith("x");
  });

  it("logs a failed request and continues the queue", async () => {
    const inputRequest = deferred();
    const log = vi.fn();
    const client = {
      cursorSet: vi.fn(() => Promise.resolve()),
      input: vi.fn(() => inputRequest.promise),
    };
    const queue = new IslandInputQueue({ client, winId: 4, log });

    queue.input("a");
    queue.cursor(1, 2);
    await Promise.resolve();
    inputRequest.reject(new Error("disconnected"));
    await queue.pending;

    expect(log).toHaveBeenCalledWith(
      "island input failed: Error: disconnected",
    );
    expect(client.cursorSet).toHaveBeenCalledWith(4, 1, 2);
  });
});
