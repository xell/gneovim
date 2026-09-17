import { RangeSet } from "@codemirror/state";
import { GutterMarker, gutterLineClass, lineNumbers } from "@codemirror/view";

// Singleton marker, like CodeMirror's own activeLineGutterMarker: GutterMarker.compare
// checks reference equality before falling back to eq(), so reusing one instance across
// every recompute is what keeps this cheap.
class ActiveLineNumberMarker extends GutterMarker {
  constructor() {
    super();
    this.elementClass = "cm-gutter-active-line-number";
  }
}
const activeLineNumberMarker = new ActiveLineNumberMarker();

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
        // Current line's number, coloured with the 'Cursor' highlight like the
        // caret itself (see --cursor-bg in styles.css). gutterLineClass.compute
        // recomputes on its own whenever cursorField changes, same mechanism
        // CodeMirror's built-in highlightActiveLineGutter uses for 'selection'.
        gutterLineClass.compute([this.cursorField], (state) => {
          const cursor = state.field(this.cursorField, false)?.pos;
          if (!cursor) return RangeSet.empty;
          const line = state.doc.line(
            Math.min(cursor.row + 1, state.doc.lines),
          );
          return RangeSet.of([activeLineNumberMarker.range(line.from)]);
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
