import { byteLen, byteToCol } from "./text-geometry.js";

export function semanticWordTarget(
  doc,
  cursor,
  segmenter = new Intl.Segmenter("zh", { granularity: "word" }),
) {
  if (!cursor) return null;
  const firstRow = Math.min(cursor.row, doc.lines - 1);
  const firstLine = doc.line(firstRow + 1);
  const firstCol = byteToCol(firstLine.text, cursor.col);
  for (let row = firstRow; row < doc.lines; row++) {
    const line = doc.line(row + 1);
    const after = row === firstRow ? firstCol : -1;
    for (const part of segmenter.segment(line.text)) {
      if (part.index > after && part.segment.trim()) {
        return {
          row,
          col: byteLen(line.text.slice(0, part.index)),
        };
      }
    }
  }
  return null;
}
