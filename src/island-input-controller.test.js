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
  now = () => Date.now(),
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
    now,
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

  it("suppresses the external-caret correction during a fast typing burst, but not after a real pause", async () => {
    // Confirmed live (2026-09-15): a stale DOM Selection read one keystroke
    // behind CodeMirror's own already-applied position, during ordinary fast
    // typing, kept reading as an external move and getting honoured, which
    // forced Neovim's cursor backward on every key and corrupted real typed
    // text into reordered garbage. See EXTERNAL_CARET_QUIET_MS.
    const doc = Text.of(["ok", "ADHD people"]);
    const burstView = domView({ doc, selection: 2, anchor: 7 }); // -> row 1, col 4
    let clock = 10_000;
    const { client, controller, cursorRequest, inputQueue, state } = integrated({
      view: burstView,
      cursor: { row: 0, col: 2 },
      now: () => clock,
    });

    // A fast burst: the same stale DOM read mismatches nvim's cursor on
    // every key, but only the first one is within a quiet window.
    controller.syncSelectionBeforeInput({ isComposing: false }, "a");
    clock += 50;
    controller.syncSelectionBeforeInput({ isComposing: false }, "b");
    clock += 50;
    controller.syncSelectionBeforeInput({ isComposing: false }, "c");
    await Promise.resolve(); // let the one enqueued cursorSet actually run
    expect(client.cursorSet).toHaveBeenCalledTimes(1);

    // Neovim's echo confirms the one placement the burst asked for, then a
    // real pause follows (Grammarly's own timing, not a typing burst). Also
    // unblocks IslandInputQueue's own serialized chain, stalled since the
    // burst's cursorSet call, so the next one below can actually run.
    controller.onNvimCursor(1, 4);
    state.cursor = { row: 1, col: 4 };
    cursorRequest.resolve();
    client.cursorSet.mockClear();
    clock += 5_000;

    // A genuinely new external move (a different DOM position) after the
    // pause is still honoured.
    controller.attach(domView({ doc, selection: 2, anchor: 9 })); // -> row 1, col 6
    controller.syncSelectionBeforeInput({ isComposing: false }, "d");
    await inputQueue.pending;
    expect(client.cursorSet).toHaveBeenCalledTimes(1);
    expect(client.cursorSet).toHaveBeenCalledWith(12, 1, 6);
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
