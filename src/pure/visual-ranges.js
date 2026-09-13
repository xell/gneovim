import { byteRange } from "./text-geometry.js";

// Convert md_decor.lua visual runs into CodeMirror ranges, excluding content
// hidden by a closed fold. Decoration construction remains a view concern.
export function visualRanges(doc, runs, inFold = () => false) {
  const ranges = [];
  for (const [row, startByte, endByte] of runs || []) {
    const range = byteRange(doc, row, startByte, endByte);
    if (range && !inFold(range.from, range.to)) ranges.push(range);
  }
  return ranges;
}
