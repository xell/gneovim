import { EditorState, StateEffect } from "@codemirror/state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIslandDecorationState } from "./island-decoration-state.js";
import { IslandDisplayDecorations } from "./island-display-decorations.js";

function fixture(
  doc = "# Title\n> quote\nbody",
  { getCursor = () => ({ row: 0, col: 0 }), getMode = () => "n" } = {},
) {
  const decorationState = createIslandDecorationState({
    document: { createElement: vi.fn() },
    log: vi.fn(),
  });
  const setTableConcealGuard = StateEffect.define();
  const setInteractiveHighlights = StateEffect.define();
  const setTableInlineHighlights = StateEffect.define();
  const setInteractiveOverlays = StateEffect.define();
  let state = EditorState.create({
    doc,
    extensions: [
      decorationState.islandDecorField,
      decorationState.islandLineField,
      decorationState.islandMarkField,
      decorationState.islandFoldField,
      decorationState.nvimCursorField,
    ],
  });
  const view = {
    get state() {
      return state;
    },
    dispatch: vi.fn((spec) => {
      state = state.update(spec).state;
    }),
    focus: vi.fn(),
    hasFocus: false,
  };
  const style = {
    removeProperty: vi.fn(),
    setProperty: vi.fn(),
  };
  const frames = [];
  const keepPositionInView = vi.fn();
  const keepCursorInView = vi.fn();
  const forceRepaint = vi.fn();
  const controller = new IslandDisplayDecorations({
    document: {},
    highlights: { islandClass: (group) => `hl-${group}` },
    view,
    element: { style, isConnected: true },
    decorationState,
    setTableConcealGuard,
    setInteractiveHighlights,
    setTableInlineHighlights,
    setInteractiveOverlays,
    getCursor,
    getMode,
    cancelPendingZeroScrolloff: vi.fn(),
    keepPositionInView,
    keepCursorInView,
    requestFrame: (callback) => frames.push(callback),
    forceRepaint,
    log: vi.fn(),
  });
  return {
    controller,
    decorationState,
    forceRepaint,
    frames,
    keepCursorInView,
    keepPositionInView,
    style,
    view,
  };
}

describe("IslandDisplayDecorations", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("applies structural, highlight, conceal, visual, and fold ranges", () => {
    const {
      controller,
      decorationState,
      forceRepaint,
      view,
    } = fixture();
    controller.set({
      accent_fg: "#123456",
      visual_hl: "#abcdef",
      guard_row: -1,
      heads: [[0, 0, 1]],
      quotes: [[1, 1]],
      conceal: [[2, 0, 1, "x"]],
      visual: [[2, 1, 3]],
      folds: [[1, 2]],
      hl: {
        runs: [[0, 2, 7, "Title"]],
        codespans: [],
        virt: [],
      },
    });

    expect(
      view.state.field(decorationState.islandDecorField).size,
    ).toBeGreaterThan(0);
    expect(
      view.state.field(decorationState.islandFoldField).size,
    ).toBe(1);
    expect(forceRepaint).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(forceRepaint).toHaveBeenCalledOnce();
  });

  it("applies a divider line class for '---' rows and publishes NonText as --nontext-fg", () => {
    const { controller, decorationState, style, view } = fixture(
      "para\n---\nafter",
    );
    controller.set({
      nontext_fg: "#889900",
      guard_row: -1,
      hrs: [1],
      hl: { runs: [], codespans: [], virt: [] },
    });

    expect(style.setProperty).toHaveBeenCalledWith(
      "--nontext-fg",
      "#889900",
    );
    expect(
      view.state.field(decorationState.islandLineField).size,
    ).toBeGreaterThan(0);
  });

  it("publishes LineNr as --linenr-fg for the gutter", () => {
    const { controller, style } = fixture();
    controller.set({
      linenr_fg: "#445566",
      guard_row: -1,
      hl: { runs: [], codespans: [], virt: [] },
    });

    expect(style.setProperty).toHaveBeenCalledWith("--linenr-fg", "#445566");
  });

  it("applies list depth line classes and bullet/ordinal marker decorations", () => {
    const { controller, decorationState, view } = fixture(
      "- item one\n  - nested a\n1. ordered one",
    );
    controller.set({
      guard_row: -1,
      heads: [],
      quotes: [],
      // Row 2 is an ordered item flush against the left margin (no leading
      // whitespace to hide) -- this used to build a zero-width replace
      // decoration that CodeMirror rejects outright; asserting this doesn't
      // throw is the point of the case.
      lists: [
        [0, 0, true],
        [1, 1, true],
        [2, 0, true],
      ],
      hl: { runs: [], codespans: [], virt: [] },
    });

    const decor = view.state.field(decorationState.islandLineField);
    expect(decor.size).toBeGreaterThan(0);

    const classes = [];
    decor.between(0, view.state.doc.length, (from, to, deco) => {
      const cls = deco.spec?.attributes?.class;
      if (cls) classes.push(cls);
    });
    expect(classes).toEqual(
      expect.arrayContaining([
        "cm-list-depth-0",
        "cm-list-depth-1",
        "cm-list-marker-line",
      ]),
    );
  });

  it("keeps concealed heading/quote markup as real, zero-size text instead of dropping it", () => {
    // Grammarly (and any other accessibility client) only ever sees this
    // island through the WKWebView accessibility tree, which reflects the
    // live DOM. A concealed "## " or "> " that vanishes from the DOM
    // entirely (no widget, or a widget with no text of its own) makes that
    // client's next AXSelectedTextRange land on however many characters
    // silently disappeared -- confirmed live with a real document full of
    // headings, where a correction a couple of lines away from a "## "
    // landed 2 characters off. The fix keeps the real "#"/">" characters
    // present (font-size: 0 via .cm-ax-shadow), not display:none/
    // visibility:hidden/aria-hidden, any of which would drop them from the
    // accessibility tree exactly as before.
    function fakeElement() {
      const children = [];
      return {
        className: "",
        setAttribute: () => {},
        append: (child) => children.push(child),
        set textContent(value) {
          this._text = value;
        },
        get textContent() {
          return this._text ?? children.map((c) => c.textContent).join("");
        },
      };
    }
    const fakeDocument = { createElement: fakeElement };
    const { controller, decorationState, view } = fixture(
      "## Heading\n\n> quoted\n\nbody",
    );
    controller.document = fakeDocument;
    controller.set({
      guard_row: -1,
      heads: [[0, 0, 2]],
      quotes: [[2, 2]],
      hl: { runs: [], codespans: [], virt: [] },
    });

    const decor = view.state.field(decorationState.islandDecorField);
    const widgets = [];
    decor.between(0, view.state.doc.length, (from, to, deco) => {
      if (deco.spec?.widget) widgets.push(deco.spec.widget);
    });

    // Every heading level hides its marker the same widget-content-based way
    // as quote/list markers and links do; the heading icon is a separate,
    // non-replacing line decoration (see the next test), so this can't (and
    // shouldn't) key off `.level` the way the old icon widget did.
    const heading = widgets.find((w) => w.text === "## ");
    expect(heading).toBeTruthy();
    expect(heading.toDOM().textContent).toBe("## ");

    const quote = widgets.find((w) => w.text === "> ");
    expect(quote).toBeTruthy();
    expect(quote.toDOM().textContent).toBe("> ");
  });

  // Leo's call, 2026-09-16: the heading icon is a pure line decoration (no
  // widget replacing any text -- see the previous test and the comment
  // above headingIconLines) that is the marker's permanent face. Unlike
  // quote/list markers, a heading's own raw "#"s reveal only in Insert mode
  // on that line -- a Normal-mode cursor sitting there instead gets a
  // reversed-video cursor block drawn behind the icon (cm-heading-icon-
  // cursor), reviving 7103ab0's visual on the new structure.
  it("keeps the heading icon as the permanent face, cursor-blocked in Normal mode, gone only while typing there", () => {
    const iconClasses = (view, decorationState) => {
      const found = [];
      view.state
        .field(decorationState.islandLineField)
        .between(0, view.state.doc.length, (from, to, deco) => {
          const cls = deco.spec?.attributes?.class;
          if (cls?.includes("cm-heading-icon-line")) found.push(cls);
        });
      return found;
    };

    // Normal mode, cursor elsewhere: icon shows, no cursor block.
    {
      const { controller, decorationState, view } = fixture("## Heading\nbody", {
        getCursor: () => ({ row: 1, col: 0 }),
        getMode: () => "n",
      });
      controller.set({ guard_row: -1, heads: [[0, 0, 2]], hl: { runs: [], codespans: [], virt: [] } });
      const classes = iconClasses(view, decorationState);
      expect(classes).toHaveLength(1);
      expect(classes[0]).toContain("cm-heading-icon-line-2");
      expect(classes[0]).not.toContain("cm-heading-icon-cursor");
    }

    // Normal mode, cursor sitting right on the marker's hidden character:
    // the marker's raw "#"s do NOT reveal (Normal mode never uncovers a
    // heading marker, only Insert does) -- the icon shows instead with the
    // reversed-video cursor block.
    {
      const { controller, decorationState, view } = fixture("## Heading\nbody", {
        getCursor: () => ({ row: 0, col: 0 }),
        getMode: () => "n",
      });
      // A real bridge would report guard_row: 0 here (Neovim's own cursor
      // row) since default 'concealcursor' exempts every mode; the
      // heading-specific guard in island-display-decorations.js ignores
      // that outside Insert mode, which this asserts.
      controller.set({ guard_row: 0, heads: [[0, 0, 2]], hl: { runs: [], codespans: [], virt: [] } });
      const classes = iconClasses(view, decorationState);
      expect(classes).toHaveLength(1);
      expect(classes[0]).toContain("cm-heading-icon-cursor");
    }

    // Insert mode, cursor elsewhere: icon shows, no cursor block.
    {
      const { controller, decorationState, view } = fixture("## Heading\nbody", {
        getCursor: () => ({ row: 1, col: 0 }),
        getMode: () => "i",
      });
      controller.set({ guard_row: 1, heads: [[0, 0, 2]], hl: { runs: [], codespans: [], virt: [] } });
      const classes = iconClasses(view, decorationState);
      expect(classes).toHaveLength(1);
      expect(classes[0]).not.toContain("cm-heading-icon-cursor");
    }

    // Insert mode, cursor on the heading line: the marker reveals (guard_row
    // matches this row), so the icon's line decoration is not emitted at
    // all -- Neovim's own caret rendering shows the cursor in the now-real
    // "## " text instead.
    {
      const { controller, decorationState, view } = fixture("## Heading\nbody", {
        getCursor: () => ({ row: 0, col: 0 }),
        getMode: () => "i",
      });
      controller.set({ guard_row: 0, heads: [[0, 0, 2]], hl: { runs: [], codespans: [], virt: [] } });
      const classes = iconClasses(view, decorationState);
      expect(classes).toHaveLength(0);
    }
  });

  // Same underlying problem as the heading icon, same fix: an unordered
  // bullet's marker is a widget standing in for real (now-hidden) text, so a
  // Normal-mode cursor landing there has nothing to render on top of unless
  // the widget itself carries a reversed-video cursor block.
  it("shows a reversed-video cursor block on an unordered bullet when the marker stays concealed under the cursor", () => {
    const bulletWidget = (view, decorationState) => {
      let found = null;
      view.state
        .field(decorationState.islandDecorField)
        .between(0, view.state.doc.length, (from, to, deco) => {
          if (deco.spec?.widget?.constructor?.name === "ListBulletWidget") {
            found = deco.spec.widget;
          }
        });
      return found;
    };

    // Cursor sitting right on the bullet's hidden marker characters, with a
    // guard_row that does not exempt this row (e.g. a 'concealcursor'
    // setting that keeps conceal on even the cursor's own line, a common
    // prose-writing preference) -- the dash stays hidden behind the bullet
    // widget, which needs the cursor block.
    {
      const { controller, decorationState, view } = fixture(
        "- item one\nbody",
        { getCursor: () => ({ row: 0, col: 0 }), getMode: () => "n" },
      );
      controller.set({
        guard_row: -1,
        lists: [[0, 0, true]],
        hl: { runs: [], codespans: [], virt: [] },
      });
      expect(bulletWidget(view, decorationState).cursorHere).toBe(true);
    }

    // Cursor elsewhere on the same line's text: no cursor block.
    {
      const { controller, decorationState, view } = fixture(
        "- item one\nbody",
        { getCursor: () => ({ row: 0, col: 5 }), getMode: () => "n" },
      );
      controller.set({
        guard_row: -1,
        lists: [[0, 0, true]],
        hl: { runs: [], codespans: [], virt: [] },
      });
      expect(bulletWidget(view, decorationState).cursorHere).toBe(false);
    }

    // The row's own guard_row unconceals the raw "- " text instead: no
    // widget at all, so nothing left to add a cursor block to.
    {
      const { controller, decorationState, view } = fixture(
        "- item one\nbody",
        { getCursor: () => ({ row: 0, col: 0 }), getMode: () => "n" },
      );
      controller.set({
        guard_row: 0,
        lists: [[0, 0, true]],
        hl: { runs: [], codespans: [], virt: [] },
      });
      expect(bulletWidget(view, decorationState)).toBeNull();
    }
  });

  // Most pushes while holding j/k change little or nothing; each kind of
  // decoration is only sent when it changed.
  it("dispatches only the decoration kinds a push actually changed", () => {
    let cursor = { row: 1, col: 0 };
    const { controller, decorationState, forceRepaint, view } = fixture(
      "- item\nbody `code`",
      { getCursor: () => cursor, getMode: () => "n" },
    );
    const payload = () => ({
      guard_row: -1,
      lists: [[0, 0, true]],
      folds: [],
      hl: { runs: [[1, 5, 11, "Special"]], codespans: [[1, 5, 11]], virt: [] },
    });
    controller.set(payload());
    const fields = () =>
      [
        decorationState.islandDecorField,
        decorationState.islandLineField,
        decorationState.islandMarkField,
      ].map((field) => view.state.field(field));
    const before = fields();
    view.dispatch.mockClear();
    forceRepaint.mockClear();

    // The same payload again: no transaction.
    controller.set(payload());
    expect(view.dispatch).not.toHaveBeenCalled();

    // The cursor lands on the bullet: only the replace widgets change.
    cursor = { row: 0, col: 0 };
    controller.set(payload());
    expect(view.dispatch).toHaveBeenCalledOnce();
    const after = fields();
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2]);

    // A guard row change alone is one transaction.
    view.dispatch.mockClear();
    controller.set({ ...payload(), guard_row: 1 });
    expect(view.dispatch).toHaveBeenCalledOnce();
  });

  // A held j/k pushes about every 70ms; the WKWebView repaint (a full island
  // relayout) runs once when the pushes stop, not after each one. Even a push
  // that changed nothing still schedules it, since an earlier update may be
  // the one left unpainted.
  it("repaints once, after a burst of pushes has settled", () => {
    const { controller, forceRepaint } = fixture("alpha beta");
    const push = (group) =>
      controller.set({
        guard_row: -1,
        hl: { runs: [[0, 0, 5, group]], codespans: [], virt: [] },
      });
    for (const group of ["A", "B", "B", "C"]) {
      push(group);
      vi.advanceTimersByTime(70);
    }
    expect(forceRepaint).not.toHaveBeenCalled();
    vi.advanceTimersByTime(80);
    expect(forceRepaint).toHaveBeenCalledOnce();

    push("C"); // nothing changed, still repainted
    vi.advanceTimersByTime(150);
    expect(forceRepaint).toHaveBeenCalledTimes(2);

    push("D");
    controller.destroy();
    vi.runAllTimers();
    expect(forceRepaint).toHaveBeenCalledTimes(2);
  });

  // Regression 2026-10-09: the change check used RangeSet.eq, which ignores
  // marks, so once any highlight was applied no later one ever replaced it
  // (EasyMotion's shade stayed up under hop's hints, scrolled-in rows kept
  // no syntax colour).
  it("replaces applied highlights when the next push brings different ones", () => {
    const { controller, decorationState, view } = fixture("alpha beta");
    const classes = () => {
      const found = [];
      view.state
        .field(decorationState.islandMarkField)
        .between(0, view.state.doc.length, (from, to, deco) => {
          found.push([from, to, deco.spec.class]);
        });
      return found;
    };
    const push = (runs) =>
      controller.set({ guard_row: -1, hl: { runs, codespans: [], virt: [] } });

    push([[0, 0, 10, "EasyMotionShade"]]);
    expect(classes()).toEqual([[0, 10, "hl-EasyMotionShade"]]);
    push([[0, 0, 10, "HopUnmatched"]]);
    expect(classes()).toEqual([[0, 10, "hl-HopUnmatched"]]);
    push([[0, 6, 10, "HopUnmatched"]]);
    expect(classes()).toEqual([[6, 10, "hl-HopUnmatched"]]);
    push([]);
    expect(classes()).toEqual([]);
  });

  it("coordinates EasyMotion, table highlights, and incremental search", () => {
    const {
      controller,
      frames,
      keepCursorInView,
      keepPositionInView,
      style,
    } = fixture("alpha");
    controller.set({
      accent_fg: "#123456",
      visual_hl: "#abcdef",
      guard_row: 0,
      incsearch: [0, 3],
      hl: {
        runs: [[0, 0, 1, "EasyMotionTarget"]],
      },
    });
    expect(controller.easyMotionOverlay).toBe(true);
    expect(style.setProperty).toHaveBeenCalledWith(
      "--visual-bg",
      "#abcdef",
    );
    expect(keepPositionInView).toHaveBeenCalledWith({ row: 0, col: 3 });

    controller.set({ hl: { runs: [] }, incsearch: null });
    expect(frames).toHaveLength(1);
    frames[0]();
    expect(keepCursorInView).toHaveBeenCalledOnce();
  });
});
