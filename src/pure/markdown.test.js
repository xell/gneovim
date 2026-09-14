import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  imageCaptionHighlights,
  imageLabel,
  tableAlign,
  tableCells,
  tableCursorCell,
} from "./markdown.js";

describe("Markdown image labels", () => {
  it("extracts a numeric width suffix but leaves the caption verbatim", () => {
    expect(imageLabel("diagram|320")).toEqual({
      alt: "diagram",
      caption: "diagram|320",
      width: 320,
    });
    expect(imageLabel("diagram|0")).toEqual({
      alt: "diagram|0",
      caption: "diagram|0",
      width: null,
    });
  });

  it("maps a highlight run onto the caption, clipped to the alt text", () => {
    const doc = Text.of(["![diagram|320](a/fake/path)"]);
    // "diagram|320" runs from column 2 to 13 in the source line.
    expect(imageCaptionHighlights(doc, 0, 2, 13, [[0, 4, 8, "Search"]])).toEqual([
      [2, 4, "Search"],
    ]);
    // A match reaching into "](a/fake" is clipped to what the caption shows.
    expect(imageCaptionHighlights(doc, 0, 2, 13, [[0, 10, 18, "Search"]])).toEqual([
      [8, 3, "Search"],
    ]);
    // A different row, or a match entirely outside the alt text, drops out.
    expect(imageCaptionHighlights(doc, 0, 2, 13, [[1, 4, 8, "Search"]])).toEqual([]);
    expect(imageCaptionHighlights(doc, 0, 2, 13, [[0, 15, 20, "Search"]])).toEqual([]);
  });
});

describe("Markdown tables", () => {
  it("splits cells while preserving escaped pipes", () => {
    expect(tableCells("| one | two\\|parts |")).toEqual(["one", "two|parts"]);
    expect(tableCells("plain text")).toBeNull();
  });

  it("recognizes separator alignment", () => {
    expect(tableAlign(["---", ":---:", "---:"])).toEqual(["left", "center", "right"]);
    expect(tableAlign(["--"])).toBeNull();
  });

  it("maps source columns into displayed cells", () => {
    expect(tableCursorCell("| one | two\\|parts |", 10)).toEqual({ cell: 1, offset: 2 });
  });
});
