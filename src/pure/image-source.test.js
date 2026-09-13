import { describe, expect, it, vi } from "vitest";
import { imageSource } from "./image-source.js";

describe("imageSource", () => {
  it("passes trusted web and image data URLs through unchanged", () => {
    const convert = vi.fn();
    expect(imageSource("https://example.test/a.png", "/tmp/readme.md", convert)).toBe(
      "https://example.test/a.png",
    );
    expect(imageSource("data:image/png;base64,AA==", "/tmp/readme.md", convert)).toBe(
      "data:image/png;base64,AA==",
    );
    expect(convert).not.toHaveBeenCalled();
  });

  it("resolves local images against the buffer directory", () => {
    const convert = vi.fn((path) => `asset:${path}`);

    expect(imageSource("../images/a%20b.png", "/notes/project/readme.md", convert)).toBe(
      "asset:/notes/images/a b.png",
    );
    expect(convert).toHaveBeenCalledWith("/notes/images/a b.png");
  });

  it("rejects relative images without a local buffer and non-file schemes", () => {
    const convert = vi.fn();
    expect(imageSource("image.png", "", convert)).toBeNull();
    expect(imageSource("javascript:alert(1)", "/tmp/readme.md", convert)).toBeNull();
    expect(convert).not.toHaveBeenCalled();
  });
});
