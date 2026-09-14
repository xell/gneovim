import { StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import {
  imageCaptionHighlights,
  imageLabel,
  tableAlign,
  tableCells,
  tableCursorCell,
  tableHighlightCells,
} from "./pure/markdown.js";
import { imageSource } from "./pure/image-source.js";
import { byteToCol } from "./pure/text-geometry.js";

export function createMarkdownPresentation({
  document,
  textNodeType,
  highlights,
  convertFileSrc,
  setCursor,
  setImageBase,
  setTableConcealGuard,
  setInteractiveHighlights,
}) {
  // Both the table and the image caption widget replace real source text
  // with their own DOM, so Neovim search/incsearch/hop highlights that land
  // on that text (an ordinary Decoration.mark elsewhere) never reach it: a
  // Decoration.mark on a byte hidden behind another field's Decoration.replace
  // has nothing left to mark. This renders those highlights inline instead,
  // fed by the same interactive-highlight list (Search / IncSearch /
  // EasyMotionTarget / HopPreview) both widgets are given.
  function appendHighlightedText(container, text, spans) {
    const boundaries = [
      ...new Set([
        0,
        text.length,
        ...spans.flatMap(({ from, to }) => [from, to]),
      ]),
    ].sort((a, b) => a - b);
    for (let index = 0; index + 1 < boundaries.length; index++) {
      const from = boundaries[index];
      const to = boundaries[index + 1];
      const groups = [
        ...new Set(
          spans
            .filter((span) => span.from < to && span.to > from)
            .map((span) => span.group),
        ),
      ];
      if (groups.length) {
        const mark = document.createElement("span");
        // Search and IncSearch may overlap. Preserve every class so the
        // registry's Neovim-derived priority determines the visible style.
        mark.className = groups
          .map((group) => highlights.islandClass(group))
          .join(" ");
        mark.textContent = text.slice(from, to);
        container.append(mark);
      } else {
        container.append(document.createTextNode(text.slice(from, to)));
      }
    }
    if (!container.childNodes.length) {
      container.append(document.createTextNode(""));
    }
  }

  function clampSpans(text, entries) {
    return entries
      .map(([start, length, group]) => ({
        from: Math.max(0, Math.min(start, text.length)),
        to: Math.max(0, Math.min(start + length, text.length)),
        group,
      }))
      .filter(({ from, to }) => to > from);
  }
  class MarkdownTableWidget extends WidgetType {
    constructor(header, align, rows, cursor, cellHighlights) {
      super();
      this.header = header;
      this.align = align;
      this.rows = rows;
      this.cursor = cursor;
      this.cellHighlights = cellHighlights;
      this.key = JSON.stringify([
        header,
        align,
        rows,
        cursor,
        cellHighlights,
      ]);
    }

    eq(other) {
      return other.key === this.key;
    }

    toDOM() {
      const table = document.createElement("table");
      table.className = "cm-markdown-table";
      table.setAttribute("contenteditable", "false");
      table.setAttribute("aria-label", "Markdown table");
      const addRow = (parent, cells, tag, rowIndex) => {
        const row = document.createElement("tr");
        cells.forEach((text, index) => {
          const cell = document.createElement(tag);
          if (tag === "th") cell.scope = "col";
          if (this.align[index]) {
            cell.style.textAlign = this.align[index];
          }
          appendTableText(
            cell,
            text,
            this.cellHighlights.filter(
              ([highlightRow, highlightCell]) =>
                highlightRow === rowIndex && highlightCell === index,
            ),
          );
          if (
            this.cursor?.row === rowIndex &&
            this.cursor.cell === index
          ) {
            addTableCursor(cell, this.cursor);
          }
          row.append(cell);
        });
        parent.append(row);
      };
      const head = document.createElement("thead");
      addRow(head, this.header, "th", 0);
      table.append(head);
      const body = document.createElement("tbody");
      this.rows.forEach((row, index) =>
        addRow(body, row, "td", index + 1),
      );
      table.append(body);
      return table;
    }
  }

  function appendTableText(cell, text, cellHighlights) {
    appendHighlightedText(
      cell,
      text,
      clampSpans(
        text,
        cellHighlights.map(([, , start, length, group]) => [
          start,
          length,
          group,
        ]),
      ),
    );
  }

  function addTableCursor(cell, cursor) {
    let offset = cursor.offset;
    let textNode = null;
    for (const node of cell.childNodes) {
      const length = node.textContent.length;
      if (offset < length || node === cell.lastChild) {
        textNode =
          node.nodeType === textNodeType ? node : node.firstChild;
        break;
      }
      offset -= length;
    }
    if (!textNode) {
      textNode = document.createTextNode("");
      cell.append(textNode);
    }
    offset = Math.min(offset, textNode.length);
    const range = document.createRange();
    if (cursor.mode[0] !== "i" && offset < textNode.length) {
      range.setStart(textNode, offset);
      range.setEnd(textNode, offset + 1);
      const block = document.createElement("span");
      block.className = "nvim-cursor nvim-cursor-block";
      range.surroundContents(block);
      return;
    }
    range.setStart(textNode, offset);
    range.collapse(true);
    const caret = document.createElement("span");
    caret.className =
      cursor.mode[0] === "i"
        ? "nvim-cursor nvim-cursor-bar"
        : "nvim-cursor nvim-cursor-block nvim-cursor-eol";
    range.insertNode(caret);
  }

  class MarkdownImageWidget extends WidgetType {
    constructor(src, alt, width) {
      super();
      this.src = src;
      this.alt = alt;
      this.width = width;
    }

    eq(other) {
      return (
        other.src === this.src &&
        other.alt === this.alt &&
        other.width === this.width
      );
    }

    toDOM() {
      const figure = document.createElement("figure");
      figure.className = "cm-markdown-image";
      figure.setAttribute("contenteditable", "false");
      const image = document.createElement("img");
      image.src = this.src;
      image.alt = this.alt;
      image.loading = "lazy";
      if (this.width != null) image.style.width = `${this.width}px`;
      figure.append(image);
      return figure;
    }
  }

  class MarkdownImageSourceWidget extends WidgetType {
    constructor(text, captionHighlights) {
      super();
      this.text = text;
      this.captionHighlights = captionHighlights;
      this.key = JSON.stringify([text, captionHighlights]);
    }

    eq(other) {
      return other.key === this.key;
    }

    toDOM() {
      const source = document.createElement("span");
      source.className = "cm-markdown-image-source";
      appendHighlightedText(
        source,
        this.text,
        clampSpans(this.text, this.captionHighlights),
      );
      return source;
    }
  }

  function imageDecorations(doc, bufferName, cursor, interactiveHighlights = []) {
    const ranges = [];
    for (let number = 1; number <= doc.lines; number++) {
      const line = doc.line(number);
      const match =
        /^\s*!\[([^\]]*)\]\((?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\)\s*$/.exec(
          line.text,
        );
      if (!match) continue;
      const src = imageSource(
        match[2] || match[3],
        bufferName,
        convertFileSrc,
      );
      if (!src) continue;
      const label = imageLabel(match[1]);
      if (cursor?.row !== number - 1) {
        // The alt text is copied verbatim into the caption (see imageLabel),
        // so its bounds in the source line are also its bounds in the
        // caption: the leading "![" is the only fixed prefix ahead of it.
        const altStart = /^\s*/.exec(line.text)[0].length + 2;
        const altEnd = altStart + match[1].length;
        const captionHighlights = imageCaptionHighlights(
          doc,
          number - 1,
          altStart,
          altEnd,
          interactiveHighlights,
        );
        ranges.push(
          Decoration.replace({
            widget: new MarkdownImageSourceWidget(
              label.caption,
              captionHighlights,
            ),
          }).range(line.from, line.to),
        );
      }
      ranges.push(
        Decoration.widget({
          block: true,
          side: 1,
          widget: new MarkdownImageWidget(
            src,
            label.alt,
            label.width,
          ),
        }).range(line.to),
      );
    }
    return Decoration.set(ranges, true);
  }

  const markdownImageField = StateField.define({
    create: (state) => ({
      deco: imageDecorations(state.doc, "", null),
      bufferName: "",
      cursor: null,
      highlights: [],
    }),
    update(value, transaction) {
      let bufferName = value.bufferName;
      let cursor = value.cursor;
      let interactiveHighlights = value.highlights;
      for (const effect of transaction.effects) {
        if (effect.is(setImageBase)) bufferName = effect.value;
        if (effect.is(setCursor)) cursor = effect.value;
        if (effect.is(setInteractiveHighlights)) {
          interactiveHighlights = effect.value;
        }
      }
      return transaction.docChanged ||
        bufferName !== value.bufferName ||
        cursor !== value.cursor ||
        interactiveHighlights !== value.highlights
        ? {
            deco: imageDecorations(
              transaction.state.doc,
              bufferName,
              cursor,
              interactiveHighlights,
            ),
            bufferName,
            highlights: interactiveHighlights,
            cursor,
          }
        : value;
    },
    provide: (field) =>
      EditorView.decorations.from(field, (value) => value.deco),
  });

  function tableDecorations(doc, cursor, guardRow, tableHighlights = []) {
    const ranges = [];
    let fence = null;
    for (let number = 1; number < doc.lines; number++) {
      const line = doc.line(number);
      const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line.text);
      if (fenceMatch) {
        const fenceCharacter = fenceMatch[1][0];
        if (fence == null) fence = fenceCharacter;
        else if (fence === fenceCharacter) fence = null;
        continue;
      }
      if (fence != null) continue;
      const header = tableCells(line.text);
      const delimiter = tableCells(doc.line(number + 1).text);
      const align =
        header &&
        delimiter &&
        header.length === delimiter.length &&
        tableAlign(delimiter);
      if (!align) continue;
      const rows = [];
      let end = number + 1;
      while (end < doc.lines) {
        const cells = tableCells(doc.line(end + 1).text);
        if (!cells || cells.length !== header.length) break;
        rows.push(cells);
        end++;
      }
      const last = doc.line(end);
      const cursorOffset =
        cursor && cursor.row >= 0 && cursor.row < doc.lines
          ? (() => {
              const cursorLine = doc.line(cursor.row + 1);
              return Math.min(
                cursorLine.from +
                  byteToCol(cursorLine.text, cursor.col),
                cursorLine.to,
              );
            })()
          : null;
      const revealForCursor =
        guardRow !== -1 &&
        cursorOffset != null &&
        cursorOffset >= line.from &&
        cursorOffset <= last.to;
      if (!revealForCursor) {
        let tableCursor = null;
        if (
          cursorOffset != null &&
          cursorOffset >= line.from &&
          cursorOffset <= last.to
        ) {
          const sourceLine = doc.line(cursor.row + 1);
          const sourceRow = cursor.row - (number - 1);
          const target = tableCursorCell(
            sourceLine.text,
            cursorOffset - sourceLine.from,
          );
          tableCursor = {
            row: sourceRow <= 1 ? 0 : sourceRow - 1,
            ...target,
            mode: cursor.mode,
          };
        }
        const cellHighlights = tableHighlightCells(
          doc,
          number - 1,
          end - 1,
          tableHighlights,
        );
        ranges.push(
          Decoration.replace({
            block: true,
            widget: new MarkdownTableWidget(
              header,
              align,
              rows,
              tableCursor,
              cellHighlights,
            ),
          }).range(line.from, last.to),
        );
      }
      number = end;
    }
    return Decoration.set(ranges, true);
  }

  const markdownTableField = StateField.define({
    create: (state) => ({
      deco: tableDecorations(state.doc, null, null),
      cursor: null,
      guardRow: null,
      highlights: [],
    }),
    update(value, transaction) {
      let cursor = value.cursor;
      let guardRow = value.guardRow;
      let tableHighlights = value.highlights;
      for (const effect of transaction.effects) {
        if (effect.is(setCursor)) cursor = effect.value;
        if (effect.is(setTableConcealGuard)) {
          guardRow = effect.value;
        }
        if (effect.is(setInteractiveHighlights)) {
          tableHighlights = effect.value;
        }
      }
      return transaction.docChanged ||
        cursor !== value.cursor ||
        guardRow !== value.guardRow ||
        tableHighlights !== value.highlights
        ? {
            deco: tableDecorations(
              transaction.state.doc,
              cursor,
              guardRow,
              tableHighlights,
            ),
            cursor,
            guardRow,
            highlights: tableHighlights,
          }
        : value;
    },
    provide: (field) =>
      EditorView.decorations.from(field, (value) => value.deco),
  });

  return { markdownImageField, markdownTableField };
}
