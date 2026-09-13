export function headingMarkerRanges(doc, headings, guardRow, inFold) {
  const ranges = [];
  for (const [row, , level] of headings || []) {
    if (row < 0 || row >= doc.lines || row === guardRow) continue;
    const line = doc.line(row + 1);
    const match = /^(#{1,6})(\s+)/.exec(line.text);
    if (!match) continue;
    const from = line.from;
    const to = from + match[0].length;
    if (inFold(from, to)) continue;
    ranges.push({
      row,
      from,
      to,
      level: Math.min(Math.max(level, 1), 6),
    });
  }
  return ranges;
}

export function quoteMarkerRanges(doc, quotes, guardRow, inFold) {
  const ranges = [];
  for (const [startRow, endRow] of quotes || []) {
    const start = Math.max(startRow, 0);
    const end = Math.min(endRow, doc.lines - 1);
    for (let row = start; row <= end; row++) {
      if (row === guardRow) continue;
      const line = doc.line(row + 1);
      const match = /^(?:[ \t]*>[ \t]?)+/.exec(line.text);
      if (!match || !match[0]) continue;
      const from = line.from;
      const to = from + match[0].length;
      if (!inFold(from, to)) ranges.push({ from, to });
    }
  }
  return ranges;
}

export function structuralLineStarts(doc, startRow, endRow, inFold) {
  const starts = [];
  const start = Math.max(startRow, 0);
  const end = Math.min(endRow, doc.lines - 1);
  for (let row = start; row <= end; row++) {
    const from = doc.line(row + 1).from;
    if (!inFold(from, from + 1)) starts.push(from);
  }
  return starts;
}

export function nonOverlappingSpans(spans) {
  const sorted = [...spans].sort((left, right) => left.from - right.from || left.to - right.to);
  const accepted = [];
  let end = -1;
  for (const span of sorted) {
    if (span.from < end) continue;
    end = span.to;
    accepted.push(span);
  }
  return accepted;
}
