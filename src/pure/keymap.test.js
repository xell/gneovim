import { describe, expect, it } from "vitest";
import { exitsNormalMode, keyToNvim, normalModePunctuation } from "./keymap.js";

const event = (overrides = {}) => ({
  key: "a",
  code: "KeyA",
  isComposing: false,
  keyCode: 65,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
});

describe("keyToNvim", () => {
  it("encodes literal, named, and modified keys", () => {
    expect(keyToNvim(event())).toBe("a");
    expect(keyToNvim(event({ key: "Enter", code: "Enter" }))).toBe("<CR>");
    expect(keyToNvim(event({ key: "A", ctrlKey: true, shiftKey: true }))).toBe("<C-S-a>");
    expect(keyToNvim(event({ key: "<", code: "Comma", shiftKey: true }))).toBe("<lt>");
  });

  it("recovers Option as Meta from the physical key", () => {
    expect(keyToNvim(event({ key: "Dead", code: "KeyE", altKey: true }))).toBe("<M-e>");
    expect(
      keyToNvim(event({ key: "é", code: "KeyE", altKey: true }), { optionIsMeta: false }),
    ).toBe("é");
  });

  it("respects composition and Cmd forwarding policy", () => {
    expect(keyToNvim(event({ isComposing: true }))).toBeNull();
    expect(keyToNvim(event({ key: "a", metaKey: true }))).toBeNull();
    expect(
      keyToNvim(event({ key: "a", metaKey: true }), { forwardCmdKeys: true }),
    ).toBe("<D-a>");
  });
});

describe("normalModePunctuation", () => {
  it("normalizes punctuation from its physical key", () => {
    expect(normalModePunctuation(event({ key: "≤", code: "Comma" }))).toBe(",");
    expect(normalModePunctuation(event({ key: ">", code: "Period", shiftKey: true }))).toBe(">");
    expect(normalModePunctuation(event({ code: "Period", altKey: true }))).toBeNull();
  });
});

describe("exitsNormalMode", () => {
  it("names the keys that leave Normal mode on their own", () => {
    for (const key of ["i", "I", "a", "A", "o", "O", "s", "S", "C", "R", "v", "V"])
      expect(exitsNormalMode(event({ key }))).toBe(true);
  });

  it("ignores motions, operators, and counts", () => {
    for (const key of ["j", "k", "w", "g", "c", "d", "y", "3", "x", "z"])
      expect(exitsNormalMode(event({ key }))).toBe(false);
  });

  it("ignores modified keys, which are their own commands", () => {
    expect(exitsNormalMode(event({ key: "i", ctrlKey: true }))).toBe(false);
    expect(exitsNormalMode(event({ key: "o", altKey: true }))).toBe(false);
    expect(exitsNormalMode(event({ key: "v", metaKey: true }))).toBe(false);
  });
});
