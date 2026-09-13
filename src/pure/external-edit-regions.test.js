import { ChangeSet, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { externalEditRegions } from "./external-edit-regions.js";

describe("externalEditRegions", () => {
  it("uses UTF-8 byte columns around multibyte text", () => {
    const doc = Text.of(["a中文b"]);
    const changes = ChangeSet.of(
      [{ from: 2, to: 3, insert: "日" }],
      doc.length,
    );
    expect(externalEditRegions(doc, changes)).toEqual([
      {
        startRow: 0,
        startCol: 4,
        endRow: 0,
        endCol: 7,
        replacement: ["日"],
      },
    ]);
  });

  it("represents multiline replacements as line arrays", () => {
    const doc = Text.of(["one", "two", "three"]);
    const changes = ChangeSet.of(
      [{ from: 2, to: 9, insert: "A\nB" }],
      doc.length,
    );
    expect(externalEditRegions(doc, changes)).toEqual([
      {
        startRow: 0,
        startCol: 2,
        endRow: 2,
        endCol: 1,
        replacement: ["A", "B"],
      },
    ]);
  });

  it("returns disjoint edits in reverse document order", () => {
    const doc = Text.of(["abcdef"]);
    const changes = ChangeSet.of(
      [
        { from: 1, to: 2, insert: "B" },
        { from: 4, to: 5, insert: "E" },
      ],
      doc.length,
    );
    expect(externalEditRegions(doc, changes)).toEqual([
      {
        startRow: 0,
        startCol: 4,
        endRow: 0,
        endCol: 5,
        replacement: ["E"],
      },
      {
        startRow: 0,
        startCol: 1,
        endRow: 0,
        endCol: 2,
        replacement: ["B"],
      },
    ]);
  });
});
