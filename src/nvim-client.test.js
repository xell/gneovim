import { describe, expect, it, vi } from "vitest";
import { NvimClient } from "./nvim-client.js";

function client() {
  const invoke = vi.fn(() => Promise.resolve());
  const listen = vi.fn(() => Promise.resolve(() => {}));
  return { invoke, listen, nvim: new NvimClient({ invoke, listen, windowLabel: "main" }) };
}

describe("NvimClient", () => {
  it("owns per-window event names", () => {
    const { listen, nvim } = client();
    const callback = vi.fn();

    nvim.on("grid", callback);

    expect(listen).toHaveBeenCalledWith("gnv://main/grid", callback);
  });

  it("preserves command names and payload shapes", async () => {
    const { invoke, nvim } = client();
    const regions = [{ startRow: 1, startCol: 2, endRow: 3, endCol: 4, replacement: ["x"] }];

    await nvim.input("<CR>");
    nvim.cursorSet(1000, 2, 7);
    nvim.edit(8, regions);
    nvim.mouse("left", "press", "C-", 4, 5);
    nvim.attachIsland(1000);
    nvim.detachIsland(8);
    nvim.resize(120, 40);
    nvim.uiStart(120, 40);

    expect(invoke.mock.calls).toEqual([
      ["nvim_input", { keys: "<CR>" }],
      ["nvim_cursor_set", { win: 1000, row: 2, col: 7 }],
      ["nvim_edit", { buf: 8, regions }],
      ["nvim_mouse", { button: "left", action: "press", modifier: "C-", row: 4, col: 5 }],
      ["island_attach", { win: 1000 }],
      ["island_detach", { buf: 8 }],
      ["nvim_resize", { cols: 120, rows: 40 }],
      ["nvim_ui_start", { cols: 120, rows: 40 }],
    ]);
  });

  it("serializes input and continues after a rejected request", async () => {
    let releaseFirst;
    const first = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const invoke = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockRejectedValueOnce(new Error("input failed"))
      .mockResolvedValueOnce();
    const nvim = new NvimClient({ invoke, listen: vi.fn(), windowLabel: "main" });

    const one = nvim.input("one");
    const two = nvim.input("two");
    const three = nvim.input("three");
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledTimes(1);

    releaseFirst();
    await one;
    await expect(two).rejects.toThrow("input failed");
    await three;
    expect(invoke.mock.calls).toEqual([
      ["nvim_input", { keys: "one" }],
      ["nvim_input", { keys: "two" }],
      ["nvim_input", { keys: "three" }],
    ]);
  });

  it("preserves commands with no payload", () => {
    const { invoke, nvim } = client();

    nvim.config();
    nvim.winFiletypes();
    nvim.guiOptions();
    nvim.windowGutters();
    nvim.refreshMarkdownDecorations();

    expect(invoke.mock.calls).toEqual([
      ["gnv_config"],
      ["nvim_winfts"],
      ["nvim_guiopts"],
      ["nvim_wingutters"],
      ["nvim_md_decor"],
    ]);
  });
});
