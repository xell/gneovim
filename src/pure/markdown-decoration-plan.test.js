import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  headingMarkerRanges,
  headingSuffixRanges,
  listMarkerRanges,
  listMarkerRows,
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

  it("plans list markers, hiding whitespace-only for ordered items", () => {
    const listDoc = Text.of([
      "- item one",
      "  - nested a",
      "1. ordered one",
      "   10) nested ordered",
    ]);
    const lists = [
      [0, 0],
      [1, 1],
      [2, 0],
      [3, 1],
    ];
    expect(listMarkerRanges(listDoc, lists, -1, visible)).toEqual([
      { row: 0, from: 0, to: 2, depth: 0, ordered: false },
      { row: 1, from: 11, to: 15, depth: 1, ordered: false },
      { row: 3, from: 39, to: 42, depth: 1, ordered: true },
    ]);
    // Row 2's ordered marker sits flush left (no whitespace to hide), so it
    // produces no span at all -- a zero-width replace decoration would be a
    // no-op CodeMirror rejects outright.
    expect(listMarkerRanges(listDoc, lists, 0, visible)).toEqual([
      { row: 1, from: 11, to: 15, depth: 1, ordered: false },
      { row: 3, from: 39, to: 42, depth: 1, ordered: true },
    ]);
    expect(
      listMarkerRanges(listDoc, [[1, 1]], -1, (from) => from === 11),
    ).toEqual([]);
  });

  it("flags marker rows (and whether they're ordered) regardless of guard row", () => {
    // A hard-wrapped item's later physical lines carry no marker of their
    // own, but md_decor.lua still reports them at the item's depth so they
    // share its padding-left; only the true marker row needs anything more.
    const wrappedDoc = Text.of([
      "- Anagram Games: you're given a set of",
      "  letters and have to rearrange them",
      "1. ordered, flush left",
    ]);
    const lists = [
      [0, 0],
      [1, 0],
      [2, 0],
    ];
    expect(listMarkerRows(wrappedDoc, lists)).toEqual([
      { row: 0, depth: 0, ordered: false },
      { row: 2, depth: 0, ordered: true },
    ]);
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
