import { byteToCol } from "./text-geometry.js";

export function imageLabel(alt) {
  const size = /^(.*)\|([1-9]\d*)$/.exec(alt);
  if (!size) return { alt, caption: alt, width: null };
  const width = Number(size[2]);
  return Number.isSafeInteger(width)
    ? { alt: size[1], caption: `${size[1]} (${width}px)`, width }
    : { alt, caption: alt, width: null };
}

export function tableCells(text) {
  if (!text.includes("|")) return null;
  let row = text.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  const cells = [];
  let cell = "";
  let escaped = false;
  for (const ch of row) {
    if (escaped) {
      cell += ch;
      escaped = false;
    } else if (ch === "\\") escaped = true;
    else if (ch === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += ch;
  }
  if (escaped) cell += "\\";
  cells.push(cell.trim());
  return cells;
}

export function tableCursorCell(text, column) {
  let start = 0;
  let end = text.length;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (text[start] === "|") start++;
  if (text[end - 1] === "|") end--;

  let cell = 0;
  let cellStart = start;
  let escaped = false;
  const finishCell = (cellEnd) => {
    let visibleStart = cellStart;
    let visibleEnd = cellEnd;
    while (visibleStart < visibleEnd && /\s/.test(text[visibleStart])) visibleStart++;
    while (visibleEnd > visibleStart && /\s/.test(text[visibleEnd - 1])) visibleEnd--;
    if (column <= visibleStart) return { cell, offset: 0 };
    let offset = 0;
    for (let i = visibleStart; i < Math.min(column, visibleEnd); i++) {
      if (text[i] === "\\" && i + 1 < visibleEnd) i++;
      offset++;
    }
    return { cell, offset };
  };
  for (let i = start; i <= end; i++) {
    const boundary = i === end || (!escaped && text[i] === "|");
    if (boundary) {
      if (column <= i || i === end) return finishCell(i);
      cell++;
      cellStart = i + 1;
    }
    if (text[i] === "\\" && !escaped) escaped = true;
    else escaped = false;
  }
  return { cell, offset: 0 };
}

export function tableAlign(cells) {
  const align = [];
  for (const cell of cells) {
    const spec = cell.trim();
    if (!/^:?-{3,}:?$/.test(spec)) return null;
    align.push(
      spec.startsWith(":") && spec.endsWith(":")
        ? "center"
        : spec.endsWith(":")
          ? "right"
          : "left",
    );
  }
  return align;
}

export function tableHighlightCells(doc, firstRow, lastRow, highlights) {
  const out = [];
  for (const [row, startColumn, endColumn, group] of highlights) {
    if (row < firstRow || row > lastRow || row === firstRow + 1) continue;
    const line = doc.line(row + 1);
    const start = byteToCol(line.text, startColumn);
    const end = byteToCol(line.text, endColumn);
    const from = tableCursorCell(line.text, start);
    const to = tableCursorCell(line.text, end);
    if (from.cell !== to.cell) continue;
    const displayRow = row === firstRow ? 0 : row - firstRow - 1;
    out.push([displayRow, from.cell, from.offset, Math.max(1, to.offset - from.offset), group]);
  }
  return out;
}
