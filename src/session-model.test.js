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
    model.placeGrid(2, {}, 1000);
    model.placeGrid(3, {}, 1000);

    model.destroyGrid(2);
    expect(model.previewWindows.get(1000)).toBe(true);
    model.destroyGrid(3);
    expect(model.previewWindows.has(1000)).toBe(false);
  });

  it("hides positions without forgetting grid ownership", () => {
    const model = new SessionModel();
    model.placeGrid(2, { srow: 1 }, 1000);
    model.hideGrid(2);

    expect(model.positionForGrid(2)).toBeUndefined();
    expect(model.windowForGrid(2)).toBe(1000);
  });
});
