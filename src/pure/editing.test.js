import { describe, expect, it } from "vitest";
import { diffInserted, minimalEdit } from "./editing.js";

describe("diffInserted", () => {
  it("removes the common prefix and suffix", () => {
    expect(diffInserted("hello world", "hello brave world")).toBe("brave ");
  });

  it("handles insertion, replacement, and deletion", () => {
    expect(diffInserted("", "abc")).toBe("abc");
    expect(diffInserted("abc", "axc")).toBe("x");
    expect(diffInserted("abc", "ac")).toBe("");
  });
});

describe("minimalEdit", () => {
  it("returns the replacement after removing common edges", () => {
    expect(minimalEdit("hello world", "hello brave world")).toEqual({
      from: 6,
      to: 6,
      insert: "brave ",
    });
    expect(minimalEdit("abc", "axc")).toEqual({ from: 1, to: 2, insert: "x" });
    expect(minimalEdit("abc", "ac")).toEqual({ from: 1, to: 2, insert: "" });
  });
});
