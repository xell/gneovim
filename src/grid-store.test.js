import { describe, expect, it } from "vitest";
import { GridStore } from "./grid-store.js";

describe("GridStore", () => {
  it("preserves overlapping cells across resize", () => {
    const grid = new GridStore();
    grid.resize(2, 2);
    grid.line(0, 0, [["a", 3], ["b", null]]);
    grid.resize(3, 3);

    expect(grid.cells[0]).toEqual([["a", 3], ["b", 3], [" ", 0]]);
    expect(grid.cells[2]).toEqual([[" ", 0], [" ", 0], [" ", 0]]);
  });

  it("applies repeat counts and inherited highlights", () => {
    const grid = new GridStore();
    grid.resize(5, 1);

    expect(grid.line(0, 1, [["x", 4, 2], ["y", null, 2]])).toBe(true);
    expect(grid.cells[0]).toEqual([
      [" ", 0],
      ["x", 4],
      ["x", 4],
      ["y", 4],
      ["y", 4],
    ]);
    expect(grid.line(2, 0, [["z", 1]])).toBe(false);
  });

  it("moves only the requested scroll region", () => {
    const grid = new GridStore();
    grid.resize(2, 3);
    grid.line(0, 0, [["a", 1, 2]]);
    grid.line(1, 0, [["b", 2, 2]]);
    grid.line(2, 0, [["c", 3, 2]]);

    expect(grid.scroll({ top: 0, bot: 3, left: 0, right: 2, rows: 1 })).toBe(true);
    expect(grid.cells[0]).toEqual([["b", 2], ["b", 2]]);
    expect(grid.cells[1]).toEqual([["c", 3], ["c", 3]]);
  });
});
