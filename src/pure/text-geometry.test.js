import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { byteLen, byteRange, byteToCol } from "./text-geometry.js";

describe("UTF-8 and UTF-16 text geometry", () => {
  it("measures ASCII, CJK, and surrogate pairs in UTF-8 bytes", () => {
    expect(byteLen("a中😀")).toBe(8);
  });

  it("maps Neovim byte columns to CodeMirror offsets", () => {
    const text = "a中😀z";
    expect([0, 1, 4, 8, 9].map((byte) => byteToCol(text, byte))).toEqual([0, 1, 2, 4, 5]);
  });

  it("stops at the containing character for an interior byte column", () => {
    expect(byteToCol("中a", 1)).toBe(1);
  });

  it("maps English and CJK byte ranges into absolute document positions", () => {
    const doc = Text.of(["alpha", "a中文b"]);

    expect(byteRange(doc, 0, 0, 1)).toEqual({ from: 0, to: 1 });
    expect(byteRange(doc, 1, 1, 4)).toEqual({ from: 7, to: 8 });
    expect(byteRange(doc, 1, 1, 7)).toEqual({ from: 7, to: 9 });
    expect(byteRange(doc, 1, 0, byteLen("a中文b"))).toEqual({ from: 6, to: 10 });
  });

  it("rejects empty and out-of-document ranges", () => {
    const doc = Text.of(["text"]);
    expect(byteRange(doc, -1, 0, 1)).toBeNull();
    expect(byteRange(doc, 1, 0, 1)).toBeNull();
    expect(byteRange(doc, 0, 2, 2)).toBeNull();
  });
});
