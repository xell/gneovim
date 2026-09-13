import { describe, expect, it } from "vitest";
import { screenMetrics } from "./layout.js";

describe("screenMetrics", () => {
  it("fits integer cells and centers the horizontal remainder", () => {
    expect(screenMetrics(1000, 600, 10, 20)).toEqual({ cols: 99, rows: 30, padX: 5 });
  });

  it("preserves minimum grid and padding constraints", () => {
    expect(screenMetrics(100, 30, 10, 20)).toEqual({ cols: 20, rows: 4, padX: 4 });
  });
});
