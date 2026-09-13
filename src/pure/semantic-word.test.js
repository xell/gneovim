import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { semanticWordTarget } from "./semantic-word.js";

function segmenter(partsByText) {
  return {
    segment: (text) => partsByText.get(text) ?? [],
  };
}

describe("semanticWordTarget", () => {
  it("returns null without a cursor or later word", () => {
    const doc = Text.of(["alpha"]);
    const words = segmenter(new Map([["alpha", [{ index: 0, segment: "alpha" }]]]));
    expect(semanticWordTarget(doc, null, words)).toBeNull();
    expect(
      semanticWordTarget(doc, { row: 0, col: 0 }, words),
    ).toBeNull();
  });

  it("finds a later word using UTF-8 byte coordinates", () => {
    const doc = Text.of(["中 alpha"]);
    const words = segmenter(
      new Map([
        [
          "中 alpha",
          [
            { index: 0, segment: "中" },
            { index: 1, segment: " " },
            { index: 2, segment: "alpha" },
          ],
        ],
      ]),
    );
    expect(
      semanticWordTarget(doc, { row: 0, col: 0 }, words),
    ).toEqual({ row: 0, col: 4 });
  });

  it("continues searching on following lines", () => {
    const doc = Text.of(["alpha", "中文"]);
    const words = segmenter(
      new Map([
        ["alpha", [{ index: 0, segment: "alpha" }]],
        ["中文", [{ index: 0, segment: "中文" }]],
      ]),
    );
    expect(
      semanticWordTarget(doc, { row: 0, col: 5 }, words),
    ).toEqual({ row: 1, col: 0 });
  });
});
