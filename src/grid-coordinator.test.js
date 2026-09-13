import { describe, expect, it, vi } from "vitest";
import { GridCoordinator } from "./grid-coordinator.js";
import { SessionModel } from "./session-model.js";

function fixture() {
  const session = new SessionModel();
  const grids = new Map();
  const gridFor = vi.fn((id) => {
    if (!grids.has(id)) {
      grids.set(id, {
        el: { hidden: false, remove: vi.fn() },
        resize: vi.fn(),
        clear: vi.fn(),
        line: vi.fn(),
        scroll: vi.fn(),
        repaint: vi.fn(),
        cursor: null,
      });
    }
    return grids.get(id);
  });
  const callbacks = {
    reconcileIslands: vi.fn(),
    onColors: vi.fn(() => grids.keys()),
    onHighlight: vi.fn(),
    onModeInfo: vi.fn(),
    onTitle: vi.fn(),
    forceRepaint: vi.fn(),
    placeGridCursor: vi.fn(),
    updateInputFocus: vi.fn(),
  };
  const coordinator = new GridCoordinator({
    session,
    grids,
    gridFor,
    islandForGrid: () => null,
    isIslandGrid: () => false,
    ...callbacks,
  });
  return { session, grids, gridFor, callbacks, coordinator };
}

describe("GridCoordinator", () => {
  it("applies ordered grid mutations then repaints dirty grids once", () => {
    const { grids, callbacks, coordinator } = fixture();
    coordinator.render([
      { op: "resize", grid: 2, w: 80, h: 20 },
      { op: "line", grid: 2, row: 1, col: 0, cells: [["x", 1]] },
      { op: "scroll", grid: 2, top: 0, bot: 20, left: 0, right: 80, rows: 1 },
    ]);

    const grid = grids.get(2);
    expect(grid.resize).toHaveBeenCalledBefore(grid.line);
    expect(grid.line).toHaveBeenCalledBefore(grid.scroll);
    expect(grid.repaint).toHaveBeenCalledTimes(1);
    expect(callbacks.placeGridCursor).toHaveBeenCalledOnce();
    expect(callbacks.updateInputFocus).toHaveBeenCalledOnce();
  });

  it("derives anchored float placement in the session model", () => {
    const { session, grids, coordinator } = fixture();
    grids.set(4, { cols: 10, rows: 3 });
    session.placeGrid(2, { srow: 5, scol: 7, w: 80, h: 20 }, 1000);

    coordinator.render([
      {
        op: "win_float",
        grid: 4,
        win: 1001,
        anchor: "SE",
        agrid: 2,
        arow: 4,
        acol: 8,
        zindex: 60,
      },
    ]);

    expect(session.positionForGrid(4)).toEqual({
      srow: 6,
      scol: 5,
      w: 10,
      h: 3,
      float: true,
      zindex: 60,
      floatAnchor: { agrid: 2, arow: 4, anchorS: true },
    });
    expect(session.windowForGrid(4)).toBe(1001);
  });

  it("updates mode state and delegates browser policies", () => {
    const { session, callbacks, coordinator } = fixture();
    coordinator.render([
      { op: "mode_info", enabled: true, modes: [{ cursor_shape: "block" }] },
      { op: "mode", name: "normal", idx: 0 },
      { op: "hl", id: 3, attr: { bold: true } },
      { op: "title", title: "notes.md" },
    ]);

    expect(session.modeName).toBe("normal");
    expect(session.currentMode).toEqual({ cursor_shape: "block" });
    expect(callbacks.onModeInfo).toHaveBeenCalledWith(true);
    expect(callbacks.onHighlight).toHaveBeenCalledWith(3, { bold: true });
    expect(callbacks.onTitle).toHaveBeenCalledWith("notes.md");
  });
});
