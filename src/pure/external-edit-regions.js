import { byteLen } from "./text-geometry.js";

// Convert CodeMirror changes into Neovim's byte-oriented nvim_buf_set_text
// regions. Reverse order keeps every range valid while Neovim applies them.
export function externalEditRegions(oldDoc, changes) {
  const regions = [];
  changes.iterChanges((from, to, _fromNew, _toNew, inserted) => {
    const start = oldDoc.lineAt(from);
    const end = oldDoc.lineAt(to);
    regions.push({
      startRow: start.number - 1,
      startCol: byteLen(start.text.slice(0, from - start.from)),
      endRow: end.number - 1,
      endCol: byteLen(end.text.slice(0, to - end.from)),
      replacement: inserted.toJSON(),
    });
  });
  return regions.reverse();
}
