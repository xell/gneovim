import { describe, expect, it } from "vitest";
import { SessionModel } from "./session-model.js";

describe("SessionModel", () => {
  it("derives desired islands from filetype, preview state, and grid placement", () => {
    const model = new SessionModel();
    model.setWindowInfo(1000, 7, "markdown");
    model.setWindowInfo(1001, 8, "rust");
    model.placeGrid(2, { srow: 0, scol: 0, w: 40, h: 20 }, 1000);
    model.placeGrid(3, { srow: 0, scol: 40, w: 40, h: 20 }, 1001);

    expect([...model.desiredIslands(true)]).toEqual([[1000, 2]]);
    model.setPreview(1000, 0);
    expect([...model.desiredIslands(true)]).toEqual([]);
    model.setPreview(1000, 1);
    expect([...model.desiredIslands(false)]).toEqual([[1000, 2]]);
  });

  it("keeps a shared window alive until its final grid is destroyed", () => {
    const model = new SessionModel();
    model.setPreview(1000, 1);
    model.setGrammarly(1000, 0);
    model.placeGrid(2, {}, 1000);
    model.placeGrid(3, {}, 1000);

    model.destroyGrid(2);
    expect(model.previewWindows.get(1000)).toBe(true);
    expect(model.grammarlyForWindow(1000)).toBe(false);
    model.destroyGrid(3);
    expect(model.previewWindows.has(1000)).toBe(false);
    expect(model.grammarlyForWindow(1000)).toBe(true);
  });

  it("treats an unknown or cleared Grammarly flag as allowed", () => {
    const model = new SessionModel();
    expect(model.grammarlyForWindow(1000)).toBe(true);
    model.setGrammarly(1000, 0);
    expect(model.grammarlyForWindow(1000)).toBe(false);
    model.setGrammarly(1000, -1);
    expect(model.grammarlyForWindow(1000)).toBe(true);
  });

  it("hides positions without forgetting grid ownership", () => {
    const model = new SessionModel();
    model.placeGrid(2, { srow: 1 }, 1000);
    model.hideGrid(2);

    expect(model.positionForGrid(2)).toBeUndefined();
    expect(model.windowForGrid(2)).toBe(1000);
  });

  it("reconciles cursor, mode, and command-line streams in one owner", () => {
    const model = new SessionModel();
    model.setModeInfo([{ cursor_shape: "block" }, { cursor_shape: "vertical" }]);
    model.setMode("insert", 1);
    model.setCursor({ win: 1000, row: 4, col: 2, mode: "n" });

    expect(model.moveGridCursor(3)).toBe(1);
    expect(model.cursorGrid).toBe(3);
    expect(model.currentMode).toEqual({ cursor_shape: "vertical" });
    expect(model.normalModeActive()).toBe(true);
    expect(model.normalModeActive("i", true)).toBe(false);

    model.setCmdlineActive(true);
    expect(model.normalModeActive("n", true)).toBe(false);
  });
});
