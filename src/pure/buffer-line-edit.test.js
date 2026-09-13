import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { bufferLineEdit } from "./buffer-line-edit.js";

function apply(doc, edit) {
  if (!edit) return doc.toString();
  return doc.replace(edit.from, edit.to, Text.of(edit.insert.split("\n"))).toString();
}

describe("bufferLineEdit", () => {
  it("shrinks a full line event to its changed character", () => {
    const doc = Text.of(["abc"]);
    const edit = bufferLineEdit(doc, 0, 1, ["axc"]);
    expect(edit).toEqual({ from: 1, to: 2, insert: "x" });
    expect(apply(doc, edit)).toBe("axc");
  });

  it("replaces the whole document", () => {
    const doc = Text.of(["one", "two"]);
    const edit = bufferLineEdit(doc, 0, -1, ["new", "text"]);
    expect(apply(doc, edit)).toBe("new\ntext");
  });

  it("appends lines beyond the current document", () => {
    const doc = Text.of(["one", "two"]);
    const edit = bufferLineEdit(doc, 2, 2, ["three", "four"]);
    expect(apply(doc, edit)).toBe("one\ntwo\nthree\nfour");
  });

  it("replaces or removes the document tail", () => {
    const doc = Text.of(["one", "two", "three"]);
    expect(apply(doc, bufferLineEdit(doc, 1, -1, ["second"]))).toBe(
      "one\nsecond",
    );
    expect(apply(doc, bufferLineEdit(doc, 1, -1, []))).toBe("one");
  });

  it("replaces complete lines in the middle", () => {
    const doc = Text.of(["one", "two", "three"]);
    const edit = bufferLineEdit(doc, 1, 2, ["second"]);
    expect(apply(doc, edit)).toBe("one\nsecond\nthree");
  });

  it("returns null for an unchanged event", () => {
    const doc = Text.of(["same"]);
    expect(bufferLineEdit(doc, 0, 1, ["same"])).toBeNull();
  });
});
