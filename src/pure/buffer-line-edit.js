import { minimalEdit } from "./editing.js";

// Convert nvim_buf_lines_event's line-oriented range into the smallest
// CodeMirror document edit that has the same result.
export function bufferLineEdit(doc, firstLine, lastLine, lineData) {
  const lineCount = doc.lines;
  const endLine = lastLine < 0 ? lineCount : lastLine;
  let from;
  let to;
  let insert;

  if (firstLine >= lineCount) {
    from = doc.length;
    to = doc.length;
    insert = lineData.map((line) => "\n" + line).join("");
  } else if (endLine >= lineCount) {
    if (firstLine === 0) {
      from = 0;
      to = doc.length;
      insert = lineData.join("\n");
    } else {
      from = doc.line(firstLine).to;
      to = doc.length;
      insert = lineData.length ? "\n" + lineData.join("\n") : "";
    }
  } else {
    from = doc.line(firstLine + 1).from;
    to = doc.line(endLine + 1).from;
    insert = lineData.map((line) => line + "\n").join("");
  }

  const current = doc.sliceString(from, to);
  const edit = minimalEdit(current, insert);
  from += edit.from;
  to = from - edit.from + edit.to;
  insert = edit.insert;
  return from !== to || insert ? { from, to, insert } : null;
}
