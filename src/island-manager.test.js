import { describe, expect, it, vi } from "vitest";
import { IslandManager } from "./island-manager.js";
import { SessionModel } from "./session-model.js";

function island(winId) {
  return {
    winId,
    bufnr: null,
    destroy: vi.fn(),
    applyReset: vi.fn(),
    setGutter: vi.fn(),
  };
}

function fixture() {
  const session = new SessionModel();
  const nvim = {
    attachIsland: vi.fn(async () => ({
      buf: 7,
      lines: ["text"],
      row: 0,
      col: 0,
      mode: "n",
      scrolloff: 0,
      name: "/tmp/a.md",
    })),
    detachIsland: vi.fn(async () => {}),
    refreshMarkdownDecorations: vi.fn(async () => {}),
  };
  const layout = vi.fn();
  const reportError = vi.fn();
  const manager = new IslandManager({
    session,
    nvim,
    createIsland: island,
    layout,
    reportError,
    livePreviewDefault: () => true,
  });
  return { session, nvim, layout, reportError, manager };
}

describe("IslandManager", () => {
  it("mounts, resets, gutters, and unmounts a desired island", async () => {
    const { session, nvim, manager } = fixture();
    session.setWindowInfo(1000, 7, "markdown");
    session.setGutter({ win: 1000, number: true });
    session.placeGrid(2, {}, 1000);

    manager.reconcile();
    await Promise.resolve();
    await Promise.resolve();
    const mounted = manager.get(1000);
    expect(mounted.bufnr).toBe(7);
    expect(mounted.applyReset).toHaveBeenCalledOnce();
    expect(mounted.setGutter).toHaveBeenCalledWith({ win: 1000, number: true });
    expect(manager.gridIds).toEqual(new Set([2]));

    session.setPreview(1000, 0);
    manager.reconcile();
    await Promise.resolve();
    expect(mounted.destroy).toHaveBeenCalledOnce();
    expect(nvim.detachIsland).toHaveBeenCalledWith(7);
    expect(manager.get(1000)).toBeUndefined();
  });

  it("balances an attach completed after its island was abandoned", async () => {
    const { nvim, manager } = fixture();
    const abandoned = island(1000);
    manager.islands.set(1000, abandoned);

    const attaching = manager.attach(abandoned);
    manager.islands.delete(1000);
    await attaching;

    expect(nvim.detachIsland).toHaveBeenCalledWith(7);
    expect(abandoned.applyReset).not.toHaveBeenCalled();
  });
});
