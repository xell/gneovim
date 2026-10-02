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

// A heading's trailing `|anything|` suffix, matched non-greedily against the
// end of the line only (vim: /|[^|]\{-}|$/). Purely a font cue, so unlike
// headingMarkerRanges this never hides the guard row: the pipes stay in
// place, only their face changes.
const HEADING_SUFFIX_PATTERN = /\|[^|]*\|$/;

export function headingSuffixRanges(doc, headings, inFold) {
  const ranges = [];
  for (const [row] of headings || []) {
    if (row < 0 || row >= doc.lines) continue;
    const line = doc.line(row + 1);
    const match = HEADING_SUFFIX_PATTERN.exec(line.text);
    if (!match) continue;
    const from = line.from + match.index;
    const to = from + match[0].length;
    if (inFold(from, to)) continue;
    ranges.push({ from, to });
  }
  return ranges;
}

// A list item's leading run: the raw indentation whitespace, plus -- for
// unordered bullets only -- the marker character and its trailing gap.
// Ordered markers ("1.", "12)") keep their literal digits on screen, since
// a fixed-width glyph can't stand in for a number; only the indentation
// whitespace ahead of them is hidden. The depth-driven hanging indent
// itself is a plain per-row line class (see apply()), not part of this
// span.
//
// Only ever run against a row md_decor.lua already flagged as a marker row:
// this pattern happily matches an over-indented `        - item`, which the
// grammar parses as prose inside the item above it, not as a marker of its
// own.
const LIST_MARKER_PATTERN = /^([ \t]*)((?:[-+*])|(?:\d{1,9}[.)]))([ \t]+|$)/;

export function listMarkerRanges(doc, lists, guardRow, inFold) {
  const ranges = [];
  for (const [row, depth, marker] of lists || []) {
    if (!marker) continue; // a continuation row, even when its text looks like one
    if (row < 0 || row >= doc.lines || row === guardRow) continue;
    const line = doc.line(row + 1);
    const match = LIST_MARKER_PATTERN.exec(line.text);
    if (!match) continue;
    const ordered = /\d/.test(match[2]);
    const from = line.from;
    const to = from + (ordered ? match[1].length : match[0].length);
    // An ordered item flush against the left margin has no leading
    // whitespace to hide and keeps its digits, so there is nothing to
    // conceal; a zero-width span here would be a no-op replace decoration.
    if (to === from) continue;
    if (inFold(from, to)) continue;
    ranges.push({ row, from, to, depth: Math.max(depth, 0), ordered });
  }
  return ranges;
}

// Which of a list's per-row depth entries (see collect_list_depths in
// md_decor.lua, which covers a hard-wrapped item's continuation lines too,
// not just its marker line) are the item's own marker row, and whether that
// marker is ordered. Deliberately ignores guardRow/folds: it only decides
// which rows need the ordered-marker text-indent pull-back (see apply()'s
// cm-list-marker-line -- unordered bullets don't need it, they're
// positioned out of the text flow instead), which should stay stable while
// editing, same as a heading's font-size does. The actual concealment of
// the marker text is the guard/fold-aware listMarkerRanges above.
export function listMarkerRows(doc, lists) {
  const rows = [];
  for (const [row, depth, marker] of lists || []) {
    if (!marker) continue;
    if (row < 0 || row >= doc.lines) continue;
    const match = LIST_MARKER_PATTERN.exec(doc.line(row + 1).text);
    if (!match) continue;
    rows.push({ row, depth: Math.max(depth, 0), ordered: /\d/.test(match[2]) });
  }
  return rows;
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

// A due date pinned to the end of a to-do list item:
//
//     - ship the thing |2026-09-30|
//
// Anchored to the end of the line so it reads as metadata rather than prose.
// The literal `|2026-09-30|` is never concealed: `/2026-09` has to keep
// finding it and the syntax highlighting has to keep colouring it, the same
// reasoning that keeps a '---' divider's source text on screen.
const DUE_DATE_PATTERN = /\|(\d{4})-(\d{2})-(\d{2})\|[ \t]*$/;

// Whole days since the epoch for a local calendar date. Date.UTC rather than
// a local Date: two local midnights are 23 or 25 hours apart across a DST
// boundary, so subtracting local timestamps lands a day out twice a year.
export function dayNumber(year, month, day) {
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function todayNumber(now = new Date()) {
  return dayNumber(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

// One capsule per list item carrying a due date, as {row, label, state}.
// `today` is a dayNumber, injected so this stays a pure function of the doc
// and a date rather than of the wall clock.
//
// Marker rows only, from the same payload the bullets use: a continuation row
// ending in a date belongs to prose, and an over-indented pseudo-item is not a
// task at all (see collect_list_depths in md_decor.lua).
//
// The label is deliberately a closed set -- a decimal count, "Today", or
// "Overdue" -- because the caller interpolates it straight into a CSS custom
// property. Anything derived from buffer text would have to be escaped first.
export function dueDateBadges(doc, lists, today) {
  const badges = [];
  for (const [row, , marker] of lists || []) {
    if (!marker) continue;
    if (row < 0 || row >= doc.lines) continue;
    const match = DUE_DATE_PATTERN.exec(doc.line(row + 1).text);
    if (!match) continue;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const due = dayNumber(year, month, day);
    // Reject a well-shaped but impossible date ("2026-13-40") rather than let
    // Date.UTC roll it silently into next year and show a confident count.
    const check = new Date(due * 86_400_000);
    if (
      check.getUTCFullYear() !== year ||
      check.getUTCMonth() + 1 !== month ||
      check.getUTCDate() !== day
    ) {
      continue;
    }
    const delta = due - today;
    badges.push({
      row,
      state: delta > 0 ? "future" : delta === 0 ? "today" : "overdue",
      label: delta > 0 ? String(delta) : delta === 0 ? "Today" : "Overdue",
    });
  }
  return badges;
}
