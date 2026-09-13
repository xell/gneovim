import { describe, expect, it } from "vitest";
import { imageLabel, tableAlign, tableCells, tableCursorCell } from "./markdown.js";

describe("Markdown image labels", () => {
  it("extracts a numeric width suffix", () => {
    expect(imageLabel("diagram|320")).toEqual({
      alt: "diagram",
      caption: "diagram (320px)",
      width: 320,
    });
    expect(imageLabel("diagram|0")).toEqual({
      alt: "diagram|0",
      caption: "diagram|0",
      width: null,
    });
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
