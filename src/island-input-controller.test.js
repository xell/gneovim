import { ChangeSet, EditorSelection, Text } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { IslandInputController } from "./island-input-controller.js";
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
  const inputQueue = { cursor: vi.fn(), input: vi.fn() };
  const fromNvim = {};
  const log = vi.fn();
  const view = {
    composing: false,
    state: {
      doc: Text.of(["a中文b"]),
      selection: EditorSelection.single(1),
    },
  };
  const controller = new IslandInputController({
    client,
    inputQueue,
    fromNvim,
    getBuffer: () => buffer,
    getCursor: () => cursor,
    log,
    requestFrame: (callback) => frames.push(callback),
    setTimer: (callback) => timers.push(callback),
  });
  controller.attach(view);
  return {
    client,
    controller,
    frames,
    fromNvim,
    inputQueue,
    timers,
    view,
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

  it("does not forward selection changes during an owned composition", () => {
    const { controller, fromNvim, inputQueue, view } = fixture();
    controller.onCompositionStart();
    controller.onSelectionUpdate({
      docChanged: false,
      selectionSet: true,
      state: {
        doc: view.state.doc,
        selection: EditorSelection.single(2),
      },
      transactions: [transaction(fromNvim)],
    });
    expect(inputQueue.cursor).not.toHaveBeenCalled();
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
});
