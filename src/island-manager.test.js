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
    setOptimalWidth: vi.fn(),
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
    expect(mounted.setOptimalWidth).toHaveBeenCalledWith(true);
    expect(manager.gridIds).toEqual(new Set([2]));

    session.setPreview(1000, 0);
    manager.reconcile();
    await Promise.resolve();
    expect(mounted.destroy).toHaveBeenCalledOnce();
    expect(nvim.detachIsland).toHaveBeenCalledWith(7);
    expect(manager.get(1000)).toBeUndefined();
  });

  it("resyncs one window's island without touching any other", async () => {
    // The scoped path an autoread/:checktime/:edit! reload uses (see
    // docs/markdown-island-fold-desync.md): unlike reconcile(true), this
    // must not disturb a window the user might be actively typing in.
    const { nvim, manager } = fixture();
    const target = island(1000);
    target.bufnr = 7;
    const other = island(2000);
    other.bufnr = 9;
    manager.islands.set(1000, target);
    manager.islands.set(2000, other);

    manager.resyncWindow(1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(nvim.detachIsland).toHaveBeenCalledExactlyOnceWith(7);
    expect(nvim.attachIsland).toHaveBeenCalledExactlyOnceWith(1000);
    expect(target.applyReset).toHaveBeenCalledOnce();
    expect(other.applyReset).not.toHaveBeenCalled();
    expect(other.destroy).not.toHaveBeenCalled();
  });

  it("ignores a resync request for a window with no island", () => {
    const { nvim, manager } = fixture();
    expect(() => manager.resyncWindow(1000)).not.toThrow();
    expect(nvim.detachIsland).not.toHaveBeenCalled();
    expect(nvim.attachIsland).not.toHaveBeenCalled();
  });

  it("does not stack a second attach while the first is in flight", async () => {
    // One `:e` fires FileType, BufWinEnter and WinEnter, so reconcile runs
    // three times before the first snapshot returns. Every extra attach was a
    // bridge-side ref no island ever released, which is what let a dead
    // attach outlive `:bdelete` (docs/markdown-island-fold-desync.md).
    const { session, nvim, manager } = fixture();
    session.placeGrid(2, {}, 1000);
    session.setWindowInfo(1000, 7, "markdown");
    manager.reconcile();
    session.setWindowInfo(1000, 7, "markdown");
    manager.reconcile();
    session.setWindowInfo(1000, 7, "markdown");
    manager.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(nvim.attachIsland).toHaveBeenCalledExactlyOnceWith(1000);
    expect(manager.get(1000).bufnr).toBe(7);
    expect(manager.get(1000).attaching).toBeNull();

    session.placeGrid(2, {}, 1001);
    manager.reconcile();
    await Promise.resolve();
    expect(nvim.detachIsland).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("re-checks the wanted buffer once an in-flight attach settles", async () => {
    // The window switched buffers while the first attach was pending: the
    // deferred reconcile must swap the island to the new buffer, balanced.
    const { session, nvim, manager } = fixture();
    let buf = 7;
    nvim.attachIsland.mockImplementation(async () => ({
      buf,
      lines: ["text"],
      row: 0,
      col: 0,
      mode: "n",
      scrolloff: 0,
      name: "/tmp/a.md",
    }));
    session.placeGrid(2, {}, 1000);
    session.setWindowInfo(1000, 7, "markdown");
    manager.reconcile();
    buf = 8;
    session.setWindowInfo(1000, 8, "markdown");
    manager.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(nvim.attachIsland).toHaveBeenCalledTimes(2);
    expect(nvim.detachIsland).toHaveBeenCalledExactlyOnceWith(7);
    expect(manager.get(1000).bufnr).toBe(8);
  });

  it("defers a resync requested while an attach is in flight", async () => {
    const { session, nvim, manager } = fixture();
    session.placeGrid(2, {}, 1000);
    session.setWindowInfo(1000, 7, "markdown");
    manager.reconcile();
    manager.resyncWindow(1000);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // first attach, then the deferred resync's detach + fresh attach
    expect(nvim.attachIsland).toHaveBeenCalledTimes(2);
    expect(nvim.detachIsland).toHaveBeenCalledExactlyOnceWith(7);
    expect(manager.get(1000).applyReset).toHaveBeenCalledTimes(2);
    expect(manager.get(1000).bufnr).toBe(7);
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
