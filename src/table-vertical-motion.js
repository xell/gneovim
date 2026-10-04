import { EditorSelection } from "@codemirror/state";
import { tableCursorCell, tableSourceColumn } from "./pure/markdown.js";

// gj/gk through a rendered Markdown table. CodeMirror's moveVertically cannot
// enter the table's block widget, and Neovim's own gj walks the hidden
// window's wrap of the whole source row, which lands in unrelated cells. This
// follows the browser's own wrap of each cell instead: up and down the
// wrapped lines of the current cell, then into the same cell of the
// neighbouring row, then out of the table.
//
// One step from CodeMirror position `pos`. `goal` is the same pixel column,
// relative to the content's left edge, that moveVertically keeps. Returns
// { pos, goal }, or undefined when neither `pos` nor the line it is leaving
// toward is a rendered table, so the caller's own motion applies.
export function tableVerticalStep(view, pos, forward, goal) {
  const doc = view.state.doc;
  const line = doc.lineAt(pos);
  const contentLeft = view.contentDOM.getBoundingClientRect().left;
  const current = renderedTableAt(view, line.number);
  if (current) {
    return stepInTable(view, current, line, pos, forward, goal, contentLeft);
  }
  const entered = renderedTableAt(view, line.number + (forward ? 1 : -1));
  if (!entered) return undefined;
  const next = view.moveVertically(
    EditorSelection.cursor(pos, undefined, undefined, goal),
    forward,
  );
  // Still inside this line's own wrap: not leaving toward the table yet.
  if (doc.lineAt(next.head).number === line.number) return undefined;
  if (goal == null) {
    const coords = view.coordsAtPos(pos);
    goal = coords ? coords.left - contentLeft : 0;
  }
  const display = forward ? 0 : entered.el.rows.length - 1;
  const cells = [...entered.el.rows[display].cells];
  const x = contentLeft + goal;
  const cellIndex = Math.max(
    0,
    cells.findLastIndex((cell) => cell.getBoundingClientRect().left <= x),
  );
  const lines = visualLines(cells[cellIndex]);
  const target = forward ? lines[0] : lines.at(-1);
  return {
    pos: tablePosition(doc, entered, display, cellIndex, pick(target, x)),
    goal,
  };
}

function stepInTable(view, table, line, pos, forward, goal, contentLeft) {
  const doc = view.state.doc;
  const relative = line.number - table.first;
  // The delimiter row is not displayed; treat it as the header, like the
  // table's own cursor rendering does.
  const display = relative <= 1 ? 0 : relative - 1;
  const cursor =
    relative === 1
      ? { cell: 0, offset: 0 }
      : tableCursorCell(line.text, pos - line.from);
  const cell = table.el.rows[display]?.cells[cursor.cell];
  if (!cell) return undefined;
  const lines = visualLines(cell);
  let index = lines.findIndex((visual) =>
    visual.some((char) => char.offset >= cursor.offset),
  );
  if (index < 0) index = Math.max(0, lines.length - 1);
  if (goal == null) {
    const char =
      lines[index]?.find((candidate) => candidate.offset >= cursor.offset) ??
      lines[index]?.at(-1);
    goal = (char ? char.left : cell.getBoundingClientRect().left) - contentLeft;
  }
  const x = contentLeft + goal;
  const step = forward ? 1 : -1;
  if (lines[index + step]) {
    return {
      pos: tablePosition(doc, table, display, cursor.cell, pick(lines[index + step], x)),
      goal,
    };
  }
  const row = table.el.rows[display + step];
  if (row) {
    const rowLines = visualLines(row.cells[cursor.cell]);
    const target = forward ? rowLines[0] : rowLines.at(-1);
    return {
      pos: tablePosition(doc, table, display + step, cursor.cell, pick(target, x)),
      goal,
    };
  }
  // Leave the table onto the adjacent source line: its first visual line
  // going down, its last going up, at the goal column. moveVertically from
  // the widget's edge is not used here: it overshoots, skipping the blank
  // line after a table or landing in an earlier table. If the adjacent line
  // does not exist (the table opens or closes the document), stay put:
  // falling back to Neovim's gj would walk the hidden wrap of the source row
  // instead.
  const number = forward ? table.last + 1 : table.first - 1;
  if (number < 1 || number > doc.lines) return { pos, goal };
  const target = doc.line(number);
  const visual = view.coordsAtPos(forward ? target.from : target.to, forward ? 1 : -1);
  if (!visual) return { pos: forward ? target.from : target.to, goal };
  const hit = view.posAtCoords({ x, y: (visual.top + visual.bottom) / 2 }, false);
  return { pos: Math.min(Math.max(hit, target.from), target.to), goal };
}

// The rendered table widget covering 1-based `lineNumber`, as its element and
// first/last source lines (header, delimiter, one line per body row).
function renderedTableAt(view, lineNumber) {
  const doc = view.state.doc;
  if (lineNumber < 1 || lineNumber > doc.lines) return null;
  for (const el of view.contentDOM.querySelectorAll(".cm-markdown-table")) {
    let from;
    try {
      from = view.posAtDOM(el);
    } catch {
      continue;
    }
    const first = doc.lineAt(from).number;
    const last = first + el.rows.length;
    if (lineNumber >= first && lineNumber <= last) return { el, first, last };
  }
  return null;
}

function tablePosition(doc, table, display, cell, offset) {
  const line = doc.line(display === 0 ? table.first : table.first + display + 1);
  return line.from + tableSourceColumn(line.text, cell, offset);
}

// The cell's visible characters grouped into the lines the browser wrapped
// them onto. Offsets count every text character in DOM order, hidden markup
// included, matching tableCursorCell and the table's own caret placement.
function visualLines(cell) {
  const lines = [];
  let offset = 0;
  let line = null;
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const hidden = node.parentElement?.closest(".cm-markdown-source-shadow");
      if (!hidden) {
        const range = document.createRange();
        for (let i = 0; i < node.length; i++) {
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const rect = range.getClientRects()[0];
          if (!rect) continue;
          const char = {
            offset: offset + i,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          };
          if (!line || (char.top + char.bottom) / 2 > line.bottom) {
            line = Object.assign([], { bottom: char.bottom });
            lines.push(line);
          }
          line.bottom = Math.max(line.bottom, char.bottom);
          line.push(char);
        }
      }
      offset += node.length;
      return;
    }
    for (const child of node.childNodes) walk(child);
  };
  walk(cell);
  return lines;
}

// The character on `line` under pixel column `x`, else the nearer end.
function pick(line, x) {
  if (!line?.length) return 0;
  const hit = line.find((char) => x >= char.left && x < char.right);
  if (hit) return hit.offset;
  return x < line[0].left ? line[0].offset : line.at(-1).offset;
}
