import { describe, expect, it } from "vitest";
import { parseGuifont } from "./guifont.js";

describe("parseGuifont", () => {
  it("parses the first family and height", () => {
    expect(parseGuifont("JetBrains\\ Mono:h14,Fallback:h13")).toEqual({
      family: "JetBrains Mono",
      size: 14,
    });
  });

  it("preserves the existing permissive fallback behavior", () => {
    expect(parseGuifont("")).toBeNull();
    expect(parseGuifont("SF_Mono")).toEqual({ family: "SF Mono", size: null });
  });
});
