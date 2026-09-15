import { ChangeSet, EditorSelection, Text } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import {
  IslandInputController,
  classifyInput,
} from "./island-input-controller.js";
import { IslandInputQueue } from "./island-input-queue.js";

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function fixture({ buffer = 8, cursor = null } = {}) {
  const frames = [];
  const timers = [];
  const client = { edit: vi.fn(() => Promise.resolve()) };
  const inputQueue = { cursor: vi.fn(), edit: vi.fn(), input: vi.fn() };
  const fromNvim = {};
  const log = vi.fn();
  const view = {
    composing: false,
    contentDOM: {
      contains: () => false,
      ownerDocument: { getSelection: () => null },
    },
    state: {
      doc: Text.of(["a中文b"]),
      selection: EditorSelection.single(1),
    },
  };
  const syncSelectionToCursor = vi.fn();
  const tx = vi.fn();
  const controller = new IslandInputController({
    client,
    inputQueue,
    fromNvim,
    getBuffer: () => buffer,
    getCursor: () => cursor,
    getMode: () => "i",
    isCursorHidden: () => false,
    log,
    requestFrame: (callback) => frames.push(callback),
    setTimer: (callback) => timers.push(callback),
    syncSelectionToCursor,
    tx,
  });
  controller.attach(view);
  return {
    client,
    controller,
    frames,
    fromNvim,
    inputQueue,
    syncSelectionToCursor,
    timers,
    tx,
    view,
  };
}

// A fake WKWebView selection over CodeMirror's content node. `positions` maps
// each node to the CodeMirror offset of its DOM offset 0.
function domView({ doc, selection, anchor, focus = anchor, cursor }) {
  const nodes = { a: {}, f: {} };
  const positions = { a: anchor, f: focus };
  const contentDOM = {
    contains: (node) => node === nodes.a || node === nodes.f,
    ownerDocument: {
      getSelection: () => ({
        anchorNode: nodes.a,
        anchorOffset: 0,
        focusNode: nodes.f,
        focusOffset: 0,
        isCollapsed: anchor === focus,
      }),
    },
  };
  return {
    composing: false,
    contentDOM,
    posAtDOM: vi.fn((node) => (node === nodes.a ? positions.a : positions.f)),
    state: { doc, selection: EditorSelection.single(selection) },
    cursor,
  };
}

function integrated({
  view,
  cursor,
  mode = "i",
  buffer = 5,
  isCursorHidden = () => false,
}) {
  const cursorRequest = deferred();
  const client = {
    cursorSet: vi.fn(() => cursorRequest.promise),
    edit: vi.fn(() => Promise.resolve()),
    input: vi.fn(() => Promise.resolve()),
  };
  const inputQueue = new IslandInputQueue({
    client,
    winId: 12,
    log: vi.fn(),
  });
  const fromNvim = {};
  const state = { cursor };
  const tx = vi.fn();
  const syncSelectionToCursor = vi.fn();
  const controller = new IslandInputController({
    client,
    inputQueue,
    fromNvim,
    getBuffer: () => buffer,
    getCursor: () => state.cursor,
    getMode: () => mode,
    isCursorHidden,
    log: vi.fn(),
    requestFrame: vi.fn(),
    setTimer: vi.fn(),
    syncSelectionToCursor,
    tx,
  });
  controller.attach(view);
  return {
    client,
    controller,
    cursorRequest,
    fromNvim,
    inputQueue,
    state,
    syncSelectionToCursor,
    tx,
  };
}

function transaction(fromNvim, { annotated = false, userEvent = false } = {}) {
  return {
    annotation: (annotation) => annotation === fromNvim && annotated,
    isUserEvent: (name) => name === "input.type.compose" && userEvent,
  };
}

describe("IslandInputController", () => {
  it("settles a composition through the animation frame", () => {
    const { controller, frames, inputQueue, view } = fixture();
    controller.onCompositionStart();
    view.state = {
      ...view.state,
      doc: Text.of(["a中"]),
    };
    controller.onCompositionEnd("中");
    expect(inputQueue.input).not.toHaveBeenCalled();

    frames[0]();
    expect(inputQueue.input).toHaveBeenCalledWith("中");
    expect(controller.compositionSettling).toBe(true);
    controller.settleComposition();
    expect(controller.compositionSettling).toBe(false);
  });

  it("routes direct insertText through Neovim and escapes angle brackets", () => {
    const { controller, inputQueue } = fixture();
    const event = {
      data: "<",
      inputType: "insertText",
      preventDefault: vi.fn(),
    };
    expect(controller.onBeforeInput(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(inputQueue.input).toHaveBeenCalledWith("<lt>");
  });

  it("forwards external document edits but not Neovim echoes", () => {
    const { client, controller, fromNvim, view } = fixture();
    const changes = ChangeSet.of(
      [{ from: 2, to: 3, insert: "日" }],
      view.state.doc.length,
    );
    const update = {
      changes,
      docChanged: true,
      startState: view.state,
      transactions: [transaction(fromNvim)],
    };
    controller.onDocumentUpdate(update);
    expect(client.edit).toHaveBeenCalledWith(8, [
      {
        startRow: 0,
        startCol: 4,
        endRow: 0,
        endCol: 7,
        replacement: ["日"],
      },
    ]);

    client.edit.mockClear();
    controller.onDocumentUpdate({
      ...update,
      transactions: [transaction(fromNvim, { annotated: true })],
    });
    expect(client.edit).not.toHaveBeenCalled();
  });

  it("converts accessibility selections and pointer positions to bytes", () => {
    const { controller, fromNvim, inputQueue, view } = fixture();
    controller.onSelectionUpdate({
      docChanged: false,
      selectionSet: true,
      state: {
        doc: view.state.doc,
        selection: EditorSelection.single(2),
      },
      transactions: [transaction(fromNvim)],
    });
    expect(inputQueue.cursor).toHaveBeenCalledWith(0, 4);

    inputQueue.cursor.mockClear();
    controller.onMousedown(
      { clientX: 10, clientY: 20 },
      {
        state: view.state,
        posAtCoords: () => 3,
      },
    );
    expect(inputQueue.cursor).toHaveBeenCalledWith(0, 7);
  });

  it("uses the selection transaction even when composition flags are stale", () => {
    const { controller, fromNvim, inputQueue, view } = fixture();
    controller.onCompositionStart();
    controller.compositionSettling = true;
    view.composing = true;
    controller.onSelectionUpdate({
      docChanged: false,
      selectionSet: true,
      state: {
        doc: view.state.doc,
        selection: EditorSelection.single(2),
      },
      transactions: [transaction(fromNvim)],
    });
    expect(inputQueue.cursor).toHaveBeenCalledWith(0, 4);
  });

  it("orders a Grammarly AX selection before its posted key", async () => {
    const cursorRequest = deferred();
    const client = {
      cursorSet: vi.fn(() => cursorRequest.promise),
      edit: vi.fn(() => Promise.resolve()),
      input: vi.fn(() => Promise.resolve()),
    };
    const inputQueue = new IslandInputQueue({
      client,
      winId: 12,
      log: vi.fn(),
    });
    const fromNvim = {};
    const doc = Text.of(["ok", "ADHD people"]);
    const view = {
      // WebKit may leave this advisory flag set after its owned composition
      // lifecycle has ended. It must not suppress a later AX cursor placement.
      composing: true,
      state: {
        doc,
        selection: EditorSelection.single(7),
      },
    };
    const controller = new IslandInputController({
      client,
      inputQueue,
      fromNvim,
      getBuffer: () => 5,
      getCursor: () => ({ row: 0, col: 2 }),
      isCursorHidden: () => false,
      log: vi.fn(),
      requestFrame: vi.fn(),
      setTimer: vi.fn(),
    });
    controller.attach(view);

    controller.onSelectionUpdate({
      docChanged: false,
      selectionSet: true,
      state: view.state,
      transactions: [transaction(fromNvim)],
    });
    inputQueue.input(",");
    await Promise.resolve();

    expect(client.cursorSet).toHaveBeenCalledWith(12, 1, 4);
    expect(client.input).not.toHaveBeenCalled();

    cursorRequest.resolve();
    await inputQueue.pending;
    expect(client.input).toHaveBeenCalledWith(",");
  });

  it("does not chase the DOM caret back out of a hidden table or image widget", async () => {
    // Neovim's cursor moved onto a table row, which replaces its own source
    // lines with a non-editable widget. The browser cannot seat a native
    // caret there, so the DOM selection stays wherever it last sat outside
    // it (Grammarly's own domView fixture, reused here to model "no real
    // change"). That must not be read as an external placement: honouring it
    // would snap Neovim straight back out of the table on every keystroke.
    const doc = Text.of(["ok", "ADHD people"]);
    const view = domView({ doc, selection: 2, anchor: 7 });
    const { client, controller, inputQueue } = integrated({
      view,
      cursor: { row: 1, col: 4 },
      isCursorHidden: () => true,
    });

    expect(controller.syncSelectionBeforeInput({ isComposing: false }, "k")).toBe(true);
    inputQueue.input("k");
    await inputQueue.pending;

    expect(client.cursorSet).not.toHaveBeenCalled();
    expect(client.input).toHaveBeenCalledWith("k");
  });

  it("does not drag Neovim's cursor onto a hidden position it was never at", async () => {
    // Confirmed live 2026-09-16, a real ~175-line document full of headings:
    // the previous fix only stopped a *second* drag to the same bogus spot.
    // Here Neovim's own cursor (row 10, plain body text) is not hidden, but
    // the DOM's own reported target (row 20, a heading's column 0 -- a
    // HeadingIconWidget replace boundary) is. Unlike the table/image case
    // above, isCursorHidden(cursor) alone says nothing is wrong; only
    // checking the target itself catches it.
    const doc = Text.of(["body text here", "## A Heading"]);
    const view = domView({ doc, selection: 2, anchor: 15 }); // -> row 1, col 0
    const { client, controller, inputQueue } = integrated({
      view,
      cursor: { row: 10, col: 3 },
      isCursorHidden: (pos) => pos.row === 1 && pos.col === 0,
    });

    expect(controller.syncSelectionBeforeInput({ isComposing: false }, "j")).toBe(true);
    inputQueue.input("j");
    await inputQueue.pending;

    expect(client.cursorSet).not.toHaveBeenCalled();
    expect(client.input).toHaveBeenCalledWith("j");
  });

  it("does not chase a DOM read that is exactly one keystroke stale during ordinary typing", async () => {
    // Confirmed live (2026-09-15): the DOM's own native Selection can read
    // exactly where Neovim's cursor stood *before* the previous key landed,
    // one keystroke behind CodeMirror's own already-applied position. Every
    // key in a fast burst reproduces this same shape (today's cursor is
    // tomorrow's stale read), so honouring it moved Neovim's cursor backward
    // on every key and corrupted real typed text into reordered garbage.
    // There is no Grammarly involved anywhere in this test: `getCursor()`
    // reports the plain result of the user's own typing, just one echo
    // ahead of the DOM's own rendering.
    const doc = Text.of(["hello world"]);
    const { client, controller, inputQueue, state } = integrated({
      view: domView({ doc, selection: 2, anchor: 2 }),
      cursor: { row: 0, col: 2 },
    });

    controller.syncSelectionBeforeInput({ isComposing: false }, "l");
    state.cursor = { row: 0, col: 3 }; // Neovim's echo of "l" already landed

    controller.attach(domView({ doc, selection: 2, anchor: 2 })); // still stale
    controller.syncSelectionBeforeInput({ isComposing: false }, "l");
    state.cursor = { row: 0, col: 4 };

    controller.attach(domView({ doc, selection: 3, anchor: 3 })); // still stale
    controller.syncSelectionBeforeInput({ isComposing: false }, "o");
    state.cursor = { row: 0, col: 5 };

    await inputQueue.pending;
    expect(client.cursorSet).not.toHaveBeenCalled();
  });

  it("stops chasing a native caret that never recovers across many real keys", async () => {
    // Confirmed live 2026-09-15: unlike the one-keystroke-stale echo above,
    // WebKit's Selection can get stuck at one spot and never catch up again,
    // however many real keys land. staleEcho only recognises the one-call
    // shape (target === priorCursor), so it re-triggered on every following
    // key, dragging Neovim's real cursor backward to the frozen spot each
    // time and making it look like navigation and edits were landing at the
    // wrong place -- because they were.
    const doc = Text.of(["one", "two", "three", "four", "five"]);
    const frozenView = domView({ doc, selection: 2, anchor: 2 }); // row 0, col 2
    const { client, controller, cursorRequest, inputQueue, state, syncSelectionToCursor } =
      integrated({ view: frozenView, cursor: { row: 3, col: 1 } });

    // First check: a genuine mismatch, honoured once as usual.
    controller.syncSelectionBeforeInput({ isComposing: false }, "j");
    await Promise.resolve();
    expect(client.cursorSet).toHaveBeenCalledTimes(1);
    expect(client.cursorSet).toHaveBeenCalledWith(12, 0, 2);
    cursorRequest.resolve();
    await inputQueue.pending;

    // Neovim echoes the forced placement (clearing pendingCursor, as a real
    // intermediate redraw would), then moves for real reasons on every
    // subsequent key; the DOM never budges from row 0 col 2 (a fresh
    // domView with the same fixed anchor models WebKit's Selection staying
    // put across renders).
    controller.onNvimCursor(0, 2);
    for (const [row, key] of [[1, "j"], [2, "j"], [3, "k"], [4, "j"]]) {
      state.cursor = { row, col: 2 };
      controller.attach(domView({ doc, selection: 2, anchor: 2 }));
      controller.syncSelectionBeforeInput({ isComposing: false }, key);
    }

    // Not re-dragged back to the frozen spot on any of those, and given a
    // real chance to re-seat instead.
    expect(client.cursorSet).toHaveBeenCalledTimes(1);
    expect(syncSelectionToCursor).toHaveBeenCalled();

    // Once the DOM finally reports somewhere new, a genuine mismatch there
    // is honoured normally again.
    state.cursor = { row: 4, col: 2 };
    controller.attach(domView({ doc, selection: 5, anchor: 5 })); // row 1, col 1
    controller.syncSelectionBeforeInput({ isComposing: false }, "l");
    await Promise.resolve();
    expect(client.cursorSet).toHaveBeenCalledTimes(2);
    expect(client.cursorSet).toHaveBeenNthCalledWith(2, 12, 1, 1);
  });

  it("honours a second, distinct Grammarly correction posted right after the first", async () => {
    // Grammarly applies every correction in a detected range one after
    // another, reading AXValue back in between rather than waiting for a
    // human pause; a batch of automatic fixes can post two unrelated AX
    // placements only milliseconds apart. An earlier fix gated every
    // collapsed-caret mismatch behind a 250ms quiet window since the
    // previous key, own or external, which silently dropped the second
    // correction here: Grammarly then read back a result that never landed
    // and gave up, which looked exactly like "Grammarly does nothing".
    const doc = Text.of(["ok", "ADHD peple, and teh dog"]);
    const firstView = domView({ doc, selection: 2, anchor: 7 }); // -> row 1, col 4
    const { client, controller, cursorRequest, inputQueue, state } = integrated({
      view: firstView,
      cursor: { row: 0, col: 2 },
    });

    controller.syncSelectionBeforeInput({ isComposing: false }, "p");
    controller.onNvimCursor(1, 4);
    state.cursor = { row: 1, col: 4 };

    // A second, distinct correction arrives immediately: no pause at all.
    controller.attach(domView({ doc, selection: 2, anchor: 16 })); // -> row 1, col 13
    controller.syncSelectionBeforeInput({ isComposing: false }, "t");
    cursorRequest.resolve();
    await inputQueue.pending;

    expect(client.cursorSet).toHaveBeenCalledTimes(2);
    expect(client.cursorSet).toHaveBeenNthCalledWith(1, 12, 1, 4);
    expect(client.cursorSet).toHaveBeenNthCalledWith(2, 12, 1, 13);
  });

  it("samples Grammarly's DOM selection before CodeMirror observes it", async () => {
    const doc = Text.of(["ok", "ADHD people"]);
    // CodeMirror still has Neovim's old cursor when keydown arrives.
    const view = domView({ doc, selection: 2, anchor: 7 });
    const { client, controller, cursorRequest, inputQueue } = integrated({
      view,
      cursor: { row: 0, col: 2 },
    });

    expect(controller.syncSelectionBeforeInput({ isComposing: false }, ",")).toBe(true);
    inputQueue.input(",");
    await Promise.resolve();

    expect(client.cursorSet).toHaveBeenCalledWith(12, 1, 4);
    expect(client.input).not.toHaveBeenCalled();

    cursorRequest.resolve();
    await inputQueue.pending;
    expect(client.input).toHaveBeenCalledWith(",");
  });

  it("does not re-request a placement Neovim has not echoed yet", async () => {
    const doc = Text.of(["ok", "ADHD people"]);
    const view = domView({ doc, selection: 7, anchor: 7 });
    const { client, controller, cursorRequest, inputQueue, state } = integrated({
      view,
      cursor: { row: 0, col: 2 },
    });

    // Grammarly posts two keys before Neovim confirms the cursor placement.
    controller.syncSelectionBeforeInput({ isComposing: false }, "a");
    inputQueue.input("a");
    controller.syncSelectionBeforeInput({ isComposing: false }, "b");
    inputQueue.input("b");
    cursorRequest.resolve();
    await inputQueue.pending;

    expect(client.cursorSet).toHaveBeenCalledTimes(1);
    expect(client.input.mock.calls).toEqual([["a"], ["b"]]);

    // The echo confirms the placement; an unrelated stale echo does not.
    controller.onNvimCursor(0, 2);
    expect(controller.pendingCursor).toEqual({ row: 1, col: 4 });
    controller.onNvimCursor(1, 4);
    state.cursor = { row: 1, col: 4 };
    expect(controller.pendingCursor).toBeNull();
    controller.syncSelectionBeforeInput({ isComposing: false }, "c");
    expect(client.cursorSet).toHaveBeenCalledTimes(1);
  });

  it("replaces a ranged accessibility selection with the typed correction", async () => {
    const doc = Text.of(["ok", "ADHD peple here"]);
    // Grammarly selected "peple" (positions 8..13) while Neovim sits after "ok".
    const view = domView({ doc, selection: 2, anchor: 8, focus: 13 });
    const { client, controller, cursorRequest, inputQueue, tx } = integrated({
      view,
      cursor: { row: 0, col: 2 },
    });

    expect(controller.syncSelectionBeforeInput({ isComposing: false }, "p")).toBe(true);
    inputQueue.input("p");
    expect(tx).toHaveBeenCalledWith({
      changes: { from: 8, to: 13, insert: "" },
      selection: { anchor: 8 },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.edit).toHaveBeenCalledWith(5, [
      { startRow: 1, startCol: 5, endRow: 1, endCol: 10, replacement: [""] },
    ]);
    expect(client.edit.mock.invocationCallOrder[0]).toBeLessThan(
      client.cursorSet.mock.invocationCallOrder[0],
    );
    expect(client.cursorSet).toHaveBeenCalledWith(12, 1, 5);
    expect(client.input).not.toHaveBeenCalled();

    cursorRequest.resolve();
    await inputQueue.pending;
    expect(client.input).toHaveBeenCalledWith("p");
  });

  it("consumes Backspace on a ranged selection as the deletion itself", () => {
    const doc = Text.of(["ADHD peple"]);
    const view = domView({ doc, selection: 0, anchor: 5, focus: 10 });
    const { controller, inputQueue, tx } = integrated({
      view,
      cursor: { row: 0, col: 0 },
    });
    vi.spyOn(inputQueue, "edit");
    vi.spyOn(inputQueue, "cursor");

    expect(controller.syncSelectionBeforeInput({ isComposing: false }, "<BS>")).toBe(false);
    expect(tx).toHaveBeenCalledOnce();
    expect(inputQueue.edit).toHaveBeenCalledWith(5, [
      { startRow: 0, startCol: 5, endRow: 0, endCol: 10, replacement: [""] },
    ]);
    expect(inputQueue.cursor).toHaveBeenCalledWith(0, 5);
  });

  it("drops a ranged selection for motions and outside Insert mode", () => {
    const doc = Text.of(["ADHD peple"]);
    for (const [keys, mode] of [
      ["<Esc>", "i"],
      ["<Left>", "i"],
      ["x", "n"],
    ]) {
      const view = domView({ doc, selection: 0, anchor: 5, focus: 10 });
      const { controller, inputQueue, syncSelectionToCursor, tx } = integrated({
        view,
        cursor: { row: 0, col: 0 },
        mode,
      });
      vi.spyOn(inputQueue, "edit");
      expect(controller.syncSelectionBeforeInput({ isComposing: false }, keys)).toBe(true);
      expect(syncSelectionToCursor).toHaveBeenCalledOnce();
      expect(tx).not.toHaveBeenCalled();
      expect(inputQueue.edit).not.toHaveBeenCalled();
    }
  });

  it("routes an accessibility insertText over a selection through the same replacement", () => {
    const doc = Text.of(["ADHD peple"]);
    const view = domView({ doc, selection: 0, anchor: 5, focus: 10 });
    const { client, controller, inputQueue, tx } = integrated({
      view,
      cursor: { row: 0, col: 0 },
    });
    vi.spyOn(inputQueue, "edit");
    vi.spyOn(inputQueue, "input");
    const event = {
      data: "people",
      inputType: "insertText",
      isComposing: false,
      preventDefault: vi.fn(),
    };
    expect(controller.onBeforeInput(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(tx).toHaveBeenCalledOnce();
    expect(inputQueue.edit).toHaveBeenCalledOnce();
    expect(inputQueue.input).toHaveBeenCalledWith("people");
    expect(client.edit).not.toHaveBeenCalled();
  });

  it("classifies queued keys", () => {
    expect(classifyInput("a")).toBe("text");
    expect(classifyInput("<lt>")).toBe("text");
    expect(classifyInput("<lt>a")).toBe("text");
    expect(classifyInput("<CR>")).toBe("text");
    expect(classifyInput("<Space>")).toBe("text");
    expect(classifyInput("<BS>")).toBe("delete");
    expect(classifyInput("<Del>")).toBe("delete");
    expect(classifyInput("<Esc>")).toBe("other");
    expect(classifyInput("<C-w>")).toBe("other");
    expect(classifyInput("<S-Space>")).toBe("other");
  });
});
