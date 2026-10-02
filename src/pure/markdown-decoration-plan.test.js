import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  dayNumber,
  dueDateBadges,
  headingMarkerRanges,
  headingSuffixRanges,
  listMarkerRanges,
  listMarkerRows,
  nonOverlappingSpans,
  quoteMarkerRanges,
  structuralLineStarts,
  todayNumber,
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
      [0, 0, true],
      [1, 1, true],
      [2, 0, true],
      [3, 1, true],
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
      listMarkerRanges(listDoc, [[1, 1, true]], -1, (from) => from === 11),
    ).toEqual([]);
  });

  it("leaves an over-indented pseudo-item alone", () => {
    // 8 columns is 4 past item one's content column, so CommonMark reads this
    // as a lazy continuation of item one's paragraph, not a nested item: the
    // text `- buried` is prose. md_decor.lua reports the row at the parent's
    // depth (right, it shares the hanging indent) but flags it as no marker,
    // which is the only thing distinguishing it from a real marker row --
    // LIST_MARKER_PATTERN matches both. Without the flag this row lost its
    // literal text to a replace decoration and gained a depth-0 bullet,
    // drawing it as a sibling of the list it is actually buried inside.
    const buriedDoc = Text.of(["- item one", "        - buried", "- item two"]);
    const lists = [
      [0, 0, true],
      [1, 0, false],
      [2, 0, true],
    ];
    expect(listMarkerRanges(buriedDoc, lists, -1, visible)).toEqual([
      { row: 0, from: 0, to: 2, depth: 0, ordered: false },
      { row: 2, from: 28, to: 30, depth: 0, ordered: false },
    ]);
    expect(listMarkerRows(buriedDoc, lists)).toEqual([
      { row: 0, depth: 0, ordered: false },
      { row: 2, depth: 0, ordered: false },
    ]);
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
      [0, 0, true],
      [1, 0, false],
      [2, 0, true],
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

describe("dueDateBadges", () => {
  const today = dayNumber(2026, 9, 25);

  it("counts future days and names today and overdue", () => {
    const doc = Text.of([
      "- ship the thing |2026-09-30|",
      "- write it up |2026-09-25|",
      "- forgot this |2026-09-20|",
      "- no date here",
    ]);
    const lists = [
      [0, 0, true],
      [1, 0, true],
      [2, 0, true],
      [3, 0, true],
    ];
    expect(dueDateBadges(doc, lists, today)).toEqual([
      { row: 0, label: "5", state: "future" },
      { row: 1, label: "Today", state: "today" },
      { row: 2, label: "Overdue", state: "overdue" },
    ]);
  });

  it("only badges a real marker row, and only a trailing date", () => {
    const doc = Text.of([
      "- a task |2026-09-30|",
      "  |2026-09-30| continuation prose",
      "        - buried |2026-09-30|",
      "- date |2026-09-30| mid-sentence",
      "- trailing spaces |2026-09-30|   ",
    ]);
    const lists = [
      [0, 0, true],
      [1, 0, false],
      [2, 0, false],
      [3, 0, true],
      [4, 0, true],
    ];
    expect(dueDateBadges(doc, lists, today)).toEqual([
      { row: 0, label: "5", state: "future" },
      { row: 4, label: "5", state: "future" },
    ]);
  });

  it("ignores a well-shaped impossible date", () => {
    // Date.UTC would roll 2026-13-40 into 2027 and show a confident count.
    const doc = Text.of(["- bad |2026-13-40|", "- also bad |2026-02-30|"]);
    expect(
      dueDateBadges(doc, [[0, 0, true], [1, 0, true]], today),
    ).toEqual([]);
  });

  it("counts whole calendar days across a DST boundary", () => {
    // US DST ends 2026-11-01, so local midnights around it are 23 and 25
    // hours apart; subtracting local timestamps would land a day out.
    expect(dayNumber(2026, 11, 2) - dayNumber(2026, 10, 30)).toBe(3);
    const now = new Date(2026, 8, 25, 23, 59, 59);
    expect(todayNumber(now)).toBe(today);
  });
});
