import { describe, expect, it } from "vitest";
import { byteLen, byteToCol } from "./text-geometry.js";

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
});
