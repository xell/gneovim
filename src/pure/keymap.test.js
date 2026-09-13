import { describe, expect, it } from "vitest";
import { keyToNvim, normalModePunctuation } from "./keymap.js";

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
