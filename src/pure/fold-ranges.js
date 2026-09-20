// Plan closed-fold ranges without constructing CodeMirror decorations. The
// first physical line remains visible; its content range is returned separately
// for the closed-fold text treatment.
export function foldRanges(doc, folds) {
  const spans = [];
  const firstLines = [];
  for (const [startRow, endRow, closed = true] of folds || []) {
    if (startRow < 0 || startRow >= doc.lines) continue;
    if (!closed) continue;
    const first = doc.line(startRow + 1);
    const to = doc.line(Math.min(endRow + 1, doc.lines)).to;
    if (first.to > first.from) firstLines.push({ from: first.from, to: first.to });
    if (to > first.to) spans.push({ from: first.to, to });
  }
  return { spans, firstLines };
}

export function overlapsRanges(ranges, from, to) {
  return ranges.some((range) => from < range.to && to > range.from);
}
