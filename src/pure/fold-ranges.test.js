import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { foldRanges, overlapsRanges } from "./fold-ranges.js";

describe("foldRanges", () => {
  const doc = Text.of(["heading", "body one", "body two", "after"]);

  it("keeps the first line visible and hides through the final line content", () => {
    expect(foldRanges(doc, [[0, 2]])).toEqual({
      firstLines: [{ from: 0, to: 7 }],
      spans: [{ from: 7, to: 25 }],
    });
  });

  it("clamps the final row and skips invalid starts", () => {
    expect(foldRanges(doc, [[2, 99], [-1, 1], [8, 9]])).toEqual({
      firstLines: [{ from: 17, to: 25 }],
      spans: [{ from: 25, to: 31 }],
    });
  });

  it("detects only actual range overlap", () => {
    const ranges = [{ from: 7, to: 25 }];
    expect(overlapsRanges(ranges, 6, 8)).toBe(true);
    expect(overlapsRanges(ranges, 24, 26)).toBe(true);
    expect(overlapsRanges(ranges, 0, 7)).toBe(false);
    expect(overlapsRanges(ranges, 25, 30)).toBe(false);
  });
});
