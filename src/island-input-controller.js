import { diffInserted } from "./pure/editing.js";
import { externalEditRegions } from "./pure/external-edit-regions.js";
import { byteLen } from "./pure/text-geometry.js";

// Owns browser-originated island input: IME composition, external document
// edits, accessibility selection changes, and pointer cursor placement.
export class IslandInputController {
  constructor({
    client,
    inputQueue,
    fromNvim,
    getBuffer,
    getCursor,
    log,
    requestFrame,
    setTimer,
  }) {
    this.client = client;
    this.inputQueue = inputQueue;
    this.fromNvim = fromNvim;
    this.getBuffer = getBuffer;
    this.getCursor = getCursor;
    this.log = log;
    this.requestFrame = requestFrame;
    this.setTimer = setTimer;
    this.view = null;
    this.composition = null;
    this.compositionSettling = false;
  }

  attach(view) {
    this.view = view;
  }

  onCompositionStart() {
    this.composition = {
      text: this.view.state.doc.toString(),
      sel: this.view.state.selection.main.head,
    };
    return false;
  }

  onCompositionEnd(committed) {
    this.requestFrame(() => this.finishComposition(committed));
    return false;
  }

  onBeforeInput(event) {
    // Safari can omit compositionend. CodeMirror recognizes the final
    // insertText as its fallback completion signal; use that same signal after
    // CodeMirror has finished reconciling its DOM observation.
    if (this.composition && event.inputType === "insertText") {
      const committed = event.data;
      this.setTimer(() => this.finishComposition(committed), 30);
    } else if (
      !this.composition &&
      event.inputType === "insertText" &&
      event.data
    ) {
      // Some macOS input sources emit full-width punctuation as direct
      // insertText with no composition. Route it as keyboard input because
      // nvim_buf_set_text cannot advance Neovim's insert cursor.
      event.preventDefault();
      this.inputQueue.input(event.data.replace(/</g, "<lt>"));
      return true;
    }
    return false;
  }

  finishComposition(committed) {
    const snapshot = this.composition;
    this.composition = null;
    if (!snapshot) return;
    const current = this.view.state.doc.toString();
    const text = committed || diffInserted(snapshot.text, current);
    // Keep CodeMirror's settled composition in place. Neovim's line echo will
    // be a no-op for identical text or a minimal correction after a mapping.
    if (text) {
      this.compositionSettling = true;
      this.inputQueue.input(text.replace(/</g, "<lt>"));
    }
  }

  onDocumentUpdate(update) {
    if (!update.docChanged) return;
    if (
      !update.transactions.some(
        (transaction) => !transaction.annotation(this.fromNvim),
      )
    )
      return;
    // Forwarding a composition before completion, then applying the buffer
    // echo, aborts the browser's active composition.
    if (
      this.composition ||
      update.transactions.some((transaction) =>
        transaction.isUserEvent("input.type.compose"),
      )
    )
      return;
    const buffer = this.getBuffer();
    if (buffer == null) return;
    const regions = externalEditRegions(update.startState.doc, update.changes);
    this.client.edit(buffer, regions).catch((error) =>
      this.log("external island edit failed: " + error),
    );
  }

  onSelectionUpdate(update) {
    // Pointer placement is synchronized by onMousedown. This path is for
    // desktop editors using AXSelectedTextRange.
    if (
      this.composition ||
      this.compositionSettling ||
      update.docChanged ||
      !update.selectionSet ||
      update.transactions.some(
        (transaction) =>
          transaction.annotation(this.fromNvim) ||
          transaction.isUserEvent("select.pointer"),
      )
    )
      return;
    const selection = update.state.selection.main;
    if (!selection.empty) return;
    const line = update.state.doc.lineAt(selection.head);
    const row = line.number - 1;
    const col = byteLen(line.text.slice(0, selection.head - line.from));
    const cursor = this.getCursor();
    if (cursor?.row === row && cursor.col === col) return;
    this.inputQueue.cursor(row, col);
  }

  onMousedown(event, view) {
    const position = view.posAtCoords({
      x: event.clientX,
      y: event.clientY,
    });
    if (position == null) return false;
    const line = view.state.doc.lineAt(position);
    this.inputQueue.cursor(
      line.number - 1,
      byteLen(line.text.slice(0, position - line.from)),
    );
    return false;
  }

  isComposing() {
    return Boolean(this.composition || this.view.composing);
  }

  settleComposition() {
    this.compositionSettling = false;
  }
}
