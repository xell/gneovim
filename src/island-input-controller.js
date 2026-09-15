import { ChangeSet } from "@codemirror/state";
import { diffInserted } from "./pure/editing.js";
import { externalEditRegions } from "./pure/external-edit-regions.js";
import { byteLen } from "./pure/text-geometry.js";

// Neovim key notation for keys that insert text in Insert mode. Only such a
// key may replace an external selection, the way typing replaces a selection
// in an ordinary editor.
const TEXT_KEYS = new Set(["<lt>", "<Space>", "<CR>", "<Tab>"]);
const DELETE_KEYS = new Set(["<BS>", "<Del>"]);

// A collapsed-caret mismatch is trusted as an external move (Grammarly, an
// accessibility client) immediately, *unless* it exactly reproduces the one
// specific false positive this boundary is known to produce on its own:
// during an ordinary fast typing burst, the DOM's own native Selection can
// read one keystroke behind CodeMirror's already-applied position. That
// stale read is, by construction, wherever Neovim's cursor stood *before*
// the previous key landed, so it is recognised by comparing the mismatch
// against `priorCursor`, not by timing it. Confirmed live (2026-09-15):
// honouring that stale read moved Neovim's cursor backward to it, which made
// the *next* real keystroke land there too, so the next check found the same
// "mismatch" again. That feedback loop reproduced as a seemingly frozen
// cursor and, worse, real corruption of the buffer (repeated and reordered
// characters), not just a display glitch: it drives nvim_input via the wrong
// cursor, live and un-reversibly.
//
// An earlier version of this fix gated *every* mismatch behind a 250ms quiet
// window since the previous key, own or external. That also suppressed a
// genuine Grammarly correction arriving less than 250ms after the user's own
// last keystroke, or a second Grammarly correction posted less than 250ms
// after the first (Grammarly applies a detected range's corrections one
// after another, reading `AXValue` back in between, not necessarily paced by
// a human pause) — Grammarly reads back a result that never landed and gives
// up, which looked exactly like "Grammarly does nothing". Comparing against
// `priorCursor` instead only ever suppresses the one stale-echo shape, so an
// external target that is not that exact position is still honoured
// straight away.

// Classify one queued input string: "text" inserts, "delete" removes the
// character next to the cursor, "other" is a motion, mode change, or mapping.
export function classifyInput(keys) {
  if (DELETE_KEYS.has(keys)) return "delete";
  if (TEXT_KEYS.has(keys) || !/^<[^>]*>$/.test(keys)) return "text";
  return "other";
}

// Owns browser-originated island input: IME composition, external document
// edits, accessibility selection changes, and pointer cursor placement.
export class IslandInputController {
  constructor({
    client,
    inputQueue,
    fromNvim,
    getBuffer,
    getCursor,
    getMode,
    isCursorHidden,
    log,
    requestFrame,
    setTimer,
    syncSelectionToCursor,
    tx,
  }) {
    this.client = client;
    this.inputQueue = inputQueue;
    this.fromNvim = fromNvim;
    this.getBuffer = getBuffer;
    this.getCursor = getCursor;
    this.getMode = getMode;
    this.isCursorHidden = isCursorHidden;
    this.log = log;
    this.requestFrame = requestFrame;
    this.setTimer = setTimer;
    this.syncSelectionToCursor = syncSelectionToCursor;
    this.tx = tx;
    this.view = null;
    this.composition = null;
    this.compositionSettling = false;
    // The cursor most recently requested from Neovim and not yet confirmed by
    // its gnv_cursor echo. Between the request and the echo the DOM selection
    // already sits there while getCursor() still reports the old position, so
    // a second key in that window must not queue the same placement again
    // behind the first key: that would move Neovim back and reverse the text.
    this.pendingCursor = null;
    // The Neovim cursor as of the previous call to syncSelectionBeforeInput,
    // used to recognise the one specific stale-DOM-read shape described
    // above classifyInput.
    this.priorCursor = null;
    // The last collapsed-caret target this boundary itself asked Neovim to
    // adopt, kept until the DOM reports something else. See the "frozen"
    // check in syncSelectionBeforeInput: unlike priorCursor (one call's
    // worth of staleness), this catches a native Selection that never
    // recovers at all, however many real keys land in between.
    this.lastExternalTarget = null;
  }

  attach(view) {
    this.view = view;
  }

  onNvimCursor(row, col) {
    const pending = this.pendingCursor;
    if (pending && pending.row === row && pending.col === col)
      this.pendingCursor = null;
  }

  reset() {
    this.pendingCursor = null;
    this.lastExternalTarget = null;
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
      // insertText with no composition, and an accessibility client may set
      // AXSelectedText the same way. Route it as keyboard input because
      // nvim_buf_set_text cannot advance Neovim's insert cursor.
      event.preventDefault();
      const keys = event.data.replace(/</g, "<lt>");
      if (this.syncSelectionBeforeInput(event, keys)) this.inputQueue.input(keys);
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
    // desktop editors using AXSelectedTextRange. Deliberately decide from the
    // transaction itself, as in the verified a42cda1 fix: persistent browser
    // composition flags can be stale and must not veto an external placement.
    // A ranged selection is left in place: it only gains a meaning when a key
    // arrives while it is still selected (see syncSelectionBeforeInput).
    if (
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
    const target = this.cursorAt(update.state.doc, selection.head);
    if (!this.cursorMatches(target)) this.requestCursor(target);
  }

  onMousedown(event, view) {
    const position = view.posAtCoords({
      x: event.clientX,
      y: event.clientY,
    });
    if (position == null) return false;
    this.requestCursor(this.cursorAt(view.state.doc, position));
    return false;
  }

  // Called with the key about to be queued. Returns whether that key should
  // still be sent to Neovim.
  //
  // AXSelectedTextRange updates WebKit's DOM selection before Grammarly posts
  // its keys, but CodeMirror's selection observer may not have dispatched yet,
  // so sample the native selection at the causal key boundary. A collapsed
  // selection is a cursor placement. A ranged selection is what a desktop
  // editor sets when it means "replace this span": it selects the error and
  // types the correction, expecting the editor to delete the selection first.
  // Neovim has one cursor and no idea of that range, so delete it here, seat
  // the cursor at its start, and only then let the replacement key through.
  syncSelectionBeforeInput(event, keys) {
    if (event.isComposing) return true;
    const range = this.domSelectionRange();
    if (!range) return true;
    const cursor = this.getCursor();
    const priorCursor = this.priorCursor;
    this.priorCursor = cursor;
    if (range.from === range.to) {
      const target = this.cursorAt(this.view.state.doc, range.from);
      // A rendered HTML table or image swallows its source lines behind a
      // non-editable replace widget. The browser cannot seat a native caret
      // inside that widget, so when Neovim's own cursor (still authoritative)
      // moves in there, the DOM selection just stays wherever it last sat
      // outside it. That is not an external move to honour: honouring it
      // snapped Neovim's cursor straight back out again on every keystroke,
      // trapping k/h at a table or image's edge while j/l (which happen to
      // approach it from the side the DOM caret was already stuck on) passed
      // through untouched.
      //
      // `staleEcho` guards the other false positive this boundary can produce
      // on its own: during ordinary fast typing, the DOM's native Selection
      // reads exactly where Neovim's cursor stood one key ago, one keystroke
      // behind CodeMirror's own already-applied position. See the comment
      // above classifyInput.
      const staleEcho =
        priorCursor != null &&
        priorCursor.row === target.row &&
        priorCursor.col === target.col &&
        !(cursor != null && cursor.row === target.row && cursor.col === target.col);
      const matches = this.cursorMatches(target);
      if (matches) this.lastExternalTarget = null;
      // A frozen native caret: this boundary already asked Neovim to adopt
      // `target` once, a real key has since moved Neovim's cursor away from
      // it for a genuine reason, yet the DOM still reports the exact same
      // spot. staleEcho only recognises one call's worth of lag; this
      // recognises the caret never recovering at all. A real external client
      // (Grammarly, a click) sets a *new* target each time it acts, it does
      // not repeat the identical spot after Neovim has visibly moved on, so
      // repetition here means WebKit's Selection is stuck (most likely a
      // decoration now sitting there that isCursorHidden does not know to
      // check), not a second genuine correction. Confirmed live 2026-09-15:
      // chasing it forced every following keystroke to land at the wrong
      // place instead of where the cursor actually was, the same failure
      // shape bea7c4b and 8bfc859 fixed a narrower (one-step-stale) case of.
      const frozen =
        !matches &&
        this.lastExternalTarget != null &&
        this.lastExternalTarget.row === target.row &&
        this.lastExternalTarget.col === target.col;
      if (!staleEcho && !frozen && !matches && !this.isCursorHidden(cursor)) {
        this.log(`external caret ${target.row}:${target.col} before ${keys}`);
        this.lastExternalTarget = target;
        this.requestCursor(target);
      } else if (frozen) {
        this.log(`frozen external caret ${target.row}:${target.col} ignored before ${keys}`);
        // Give WebKit a fresh, explicit reason to re-seat its caret at the
        // position Neovim actually has, rather than leaving it stuck.
        this.syncSelectionToCursor();
      }
      return true;
    }
    const kind = classifyInput(keys);
    if (kind === "other" || !this.insertModeActive() || this.getBuffer() == null) {
      // A foreign range Neovim cannot honour is dropped now, so a later text
      // key does not replace a span the user never saw as selected.
      this.log(`external range ${range.from}-${range.to} dropped before ${keys}`);
      this.syncSelectionToCursor();
      return true;
    }
    this.log(`external range ${range.from}-${range.to} replaced by ${keys}`);
    this.replaceSelection(range);
    // Backspace and Delete on a selection remove the selection itself.
    return kind === "text";
  }

  replaceSelection({ from, to }) {
    const doc = this.view.state.doc;
    const regions = externalEditRegions(
      doc,
      ChangeSet.of([{ from, to }], doc.length),
    );
    // The bridge suppresses the buffer echo of its own nvim_buf_set_text, so
    // mirror the deletion locally exactly as a native DOM edit would have.
    this.tx({ changes: { from, to, insert: "" }, selection: { anchor: from } });
    this.inputQueue.edit(this.getBuffer(), regions);
    this.requestCursor(this.cursorAt(doc, from));
  }

  domSelectionRange() {
    const content = this.view.contentDOM;
    const selection = content.ownerDocument.getSelection();
    if (
      !selection ||
      !selection.anchorNode ||
      !selection.focusNode ||
      !content.contains(selection.anchorNode) ||
      !content.contains(selection.focusNode)
    )
      return null;
    let anchor;
    let focus;
    try {
      anchor = this.view.posAtDOM(selection.anchorNode, selection.anchorOffset);
      focus = this.view.posAtDOM(selection.focusNode, selection.focusOffset);
    } catch {
      return null;
    }
    return { from: Math.min(anchor, focus), to: Math.max(anchor, focus) };
  }

  cursorAt(doc, position) {
    const line = doc.lineAt(position);
    return {
      row: line.number - 1,
      col: byteLen(line.text.slice(0, position - line.from)),
    };
  }

  cursorMatches({ row, col }) {
    return [this.getCursor(), this.pendingCursor].some(
      (cursor) => cursor != null && cursor.row === row && cursor.col === col,
    );
  }

  requestCursor({ row, col }) {
    this.pendingCursor = { row, col };
    this.inputQueue.cursor(row, col);
  }

  insertModeActive() {
    return /^[iR]/.test(this.getMode());
  }

  isComposing() {
    return Boolean(this.composition || this.view.composing);
  }

  settleComposition() {
    this.compositionSettling = false;
  }
}
