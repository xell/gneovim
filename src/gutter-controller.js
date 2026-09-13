import { lineNumbers } from "@codemirror/view";

export function formatGutterNumber(gutter, cursor, lineNumber, lineCount) {
  if (!gutter.relativenumber) return String(lineNumber);
  const cursorLine = cursor
    ? Math.min(cursor.row + 1, lineCount)
    : null;
  if (cursorLine == null) return String(lineNumber);
  if (lineNumber === cursorLine) {
    return gutter.number ? String(lineNumber) : "0";
  }
  return String(Math.abs(lineNumber - cursorLine));
}

// Owns the CodeMirror number-column extension and its cursor-driven refresh.
export class GutterController {
  constructor({
    element,
    compartment,
    cursorField,
    requestFrame,
    cancelFrame,
  }) {
    this.element = element;
    this.compartment = compartment;
    this.cursorField = cursorField;
    this.requestFrame = requestFrame;
    this.cancelFrame = cancelFrame;
    this.view = null;
    this.gutter = null;
    this.frame = 0;
  }

  extension() {
    return this.compartment.of([]);
  }

  attach(view) {
    this.view = view;
  }

  set(gutter) {
    this.gutter = gutter;
    this.apply();
  }

  onUpdate(update) {
    if (!this.gutter?.relativenumber) return;
    const before = update.startState.field(this.cursorField, false)?.pos?.row;
    const after = update.state.field(this.cursorField, false)?.pos?.row;
    if (before !== after) this.scheduleRefresh();
  }

  apply() {
    const gutter = this.gutter;
    const extensions = [];
    if (gutter && (gutter.number || gutter.relativenumber)) {
      this.element.style.setProperty(
        "--gutter-numw",
        String(Math.max(gutter.numberwidth || 4, 2)),
      );
      extensions.push(
        lineNumbers({
          formatNumber: (lineNumber, state) =>
            formatGutterNumber(
              gutter,
              state.field(this.cursorField, false)?.pos,
              lineNumber,
              state.doc.lines,
            ),
        }),
      );
    } else {
      this.element.style.removeProperty("--gutter-numw");
    }
    this.view.dispatch({
      effects: this.compartment.reconfigure(extensions),
    });
  }

  scheduleRefresh() {
    if (this.frame) return;
    this.frame = this.requestFrame(() => {
      this.frame = 0;
      this.apply();
    });
  }

  destroy() {
    if (this.frame) this.cancelFrame(this.frame);
    this.frame = 0;
  }
}
