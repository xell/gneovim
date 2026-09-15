import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  headingMarkerRanges,
  headingSuffixRanges,
  nonOverlappingSpans,
  quoteMarkerRanges,
  structuralLineStarts,
} from "./markdown-decoration-plan.js";

describe("Markdown decoration planning", () => {
  const doc = Text.of(["# title", "plain", "  > quote", ">> nested", "last"]);
  const visible = () => false;

  it("plans ATX heading markers with clamped levels and guard rows", () => {
    expect(
      headingMarkerRanges(
        doc,
        [
          [0, 0, 9],
          [1, 1, 2],
        ],
        -1,
        visible,
      ),
    ).toEqual([{ row: 0, from: 0, to: 2, level: 6 }]);
    expect(headingMarkerRanges(doc, [[0, 0, 1]], 0, visible)).toEqual([]);
  });

  it("plans heading trailing |suffix| runs non-greedily and excludes folds", () => {
    const suffixDoc = Text.of([
      "# a heading |@|",
      "## b |200/100/50%|",
      "no suffix here",
      "# |x|y|",
    ]);
    expect(
      headingSuffixRanges(
        suffixDoc,
        [
          [0, 0, 1],
          [1, 1, 2],
          [2, 2, 1],
          [3, 3, 1],
        ],
        visible,
      ),
    ).toEqual([
      { from: 12, to: 15 },
      { from: 21, to: 34 },
      { from: 54, to: 57 },
    ]);
    expect(
      headingSuffixRanges(suffixDoc, [[0, 0, 1]], (from) => from === 12),
    ).toEqual([]);
  });

  it("plans nested blockquote source markers", () => {
    expect(quoteMarkerRanges(doc, [[2, 3]], -1, visible)).toEqual([
      { from: 14, to: 18 },
      { from: 24, to: 27 },
    ]);
    expect(quoteMarkerRanges(doc, [[2, 3]], 2, visible)).toEqual([
      { from: 24, to: 27 },
    ]);
  });

  it("plans structural line starts while excluding folds", () => {
    expect(structuralLineStarts(doc, -2, 99, (from) => from === 14)).toEqual([
      0, 8, 24, 34,
    ]);
  });

  it("sorts spans and keeps the first non-overlapping source", () => {
    const first = { from: 2, to: 5, source: "first" };
    const overlap = { from: 3, to: 4, source: "overlap" };
    const touching = { from: 5, to: 7, source: "touching" };
    expect(nonOverlappingSpans([touching, overlap, first])).toEqual([first, touching]);
  });
});
