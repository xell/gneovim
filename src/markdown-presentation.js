import { StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { markdownLanguage } from "@codemirror/lang-markdown";
import {
  entriesInSpans,
  imageCaptionHighlights,
  imageCaptionOverlays,
  imageLabel,
  rowInSpans,
  tableAlign,
  tableCells,
  tableCursorCell,
  tableHighlightCells,
  tableOverlayCells,
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
  setTableInlineHighlights,
  setInteractiveOverlays,
}) {
  const markdownParser = markdownLanguage.parser;
  const markdownNodeNames = markdownParser.nodeSet.types.map(
    (type) => type.name,
  );

  // Both the table and the image caption widget replace real source text
  // with their own DOM, so a Neovim decoration that targets that text never
  // reaches it: a Decoration.mark or Decoration.replace on a byte hidden
  // behind another field's Decoration.replace has nothing left to mark or
  // replace. This renders both kinds inline instead: `spans` (Search /
  // IncSearch / EasyMotionTarget / HopPreview) colour the underlying text,
  // `overlays` (hop.nvim's per-target hint letters) replace it outright and
  // take priority over a `spans` colour on the same characters, matching the
  // non-table/image OverlayWidget elsewhere in this codebase.
  function appendHighlightedText(container, text, spans, overlays = []) {
    const boundaries = [
      ...new Set([
        0,
        text.length,
        ...spans.flatMap(({ from, to }) => [from, to]),
        ...overlays.flatMap(({ from, to }) => [from, to]),
      ]),
    ].sort((a, b) => a - b);
    for (let index = 0; index + 1 < boundaries.length; index++) {
      const from = boundaries[index];
      const to = boundaries[index + 1];
      const overlay = overlays.find(
        (span) => span.from <= from && span.to >= to,
      );
      if (overlay) {
        for (const [segmentText, group] of overlay.segments) {
          const segment = document.createElement("span");
          if (group) segment.className = highlights.islandClass(group);
          segment.textContent = segmentText;
          container.append(segment);
        }
        // The overlay's whole range is rendered from its first slice; skip
        // past any further boundaries still inside it.
        index = boundaries.indexOf(overlay.to) - 1;
        continue;
      }
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

  function clampOverlaySpans(text, entries) {
    return entries
      .map(([start, length, segments]) => ({
        from: Math.max(0, Math.min(start, text.length)),
        to: Math.max(0, Math.min(start + length, text.length)),
        segments,
      }))
      .filter(({ from, to }) => to > from);
  }

  function appendHighlightedRange(
    container,
    text,
    from,
    to,
    cellHighlights,
    cellOverlays,
  ) {
    if (to <= from) return;
    appendHighlightedText(
      container,
      text.slice(from, to),
      clampSpans(
        text.slice(from, to),
        cellHighlights.map(([, , start, length, group]) => [
          start - from,
          length,
          group,
        ]),
      ),
      clampOverlaySpans(
        text.slice(from, to),
        cellOverlays.map(([, , start, length, segments]) => [
          start - from,
          length,
          segments,
        ]),
      ),
    );
  }

  function nodeName(node) {
    return markdownNodeNames[node.type];
  }

  function childRange(node, markName) {
    const marks = node.children.filter(
      (child) => nodeName(child) === markName,
    );
    return marks.length >= 2
      ? { from: marks[0].to, to: marks[1].from }
      : null;
  }

  function inlineUrl(text, node) {
    const url = node.children.find((child) => nodeName(child) === "URL");
    return url ? text.slice(url.from, url.to) : null;
  }

  function appendSourceShadow(parent, text, from, to) {
    if (to <= from) return;
    const shadow = document.createElement("span");
    shadow.className = "cm-markdown-source-shadow";
    shadow.setAttribute("aria-hidden", "true");
    shadow.textContent = text.slice(from, to);
    parent.append(shadow);
  }

  function safeLinkHref(url) {
    if (!url) return null;
    if (/^(?:https?:|mailto:|#|\/|\.\.?\/)/i.test(url)) return url;
    return null;
  }

  function appendInlineMarkdown(
    container,
    text,
    cellHighlights,
    cellOverlays,
    bufferName,
  ) {
    const elements = markdownParser.parseInline(text, 0);

    const appendPlain = (parent, from, to) =>
      appendHighlightedRange(
        parent,
        text,
        from,
        to,
        cellHighlights,
        cellOverlays,
      );

    const appendElements = (parent, children, from, to) => {
      let position = from;
      for (const child of children) {
        if (child.to <= from || child.from >= to) continue;
        const childFrom = Math.max(child.from, from);
        const childTo = Math.min(child.to, to);
        if (childFrom > position) appendPlain(parent, position, childFrom);
        appendElement(parent, child, childFrom, childTo);
        position = Math.max(position, childTo);
      }
      if (position < to) appendPlain(parent, position, to);
    };

    const appendElement = (parent, node, from, to) => {
      const name = nodeName(node);
      if (name === "StrongEmphasis" || name === "Emphasis" || name === "Strikethrough") {
        const range = childRange(
          node,
          name === "Strikethrough" ? "StrikethroughMark" : "EmphasisMark",
        );
        if (!range) return appendPlain(parent, from, to);
        const element = document.createElement(
          name === "StrongEmphasis"
            ? "strong"
            : name === "Emphasis"
              ? "em"
              : "del",
        );
        appendSourceShadow(element, text, node.from, range.from);
        appendElements(
          element,
          node.children.filter(
            (child) => child.from >= range.from && child.to <= range.to,
          ),
          Math.max(from, range.from),
          Math.min(to, range.to),
        );
        appendSourceShadow(element, text, range.to, node.to);
        parent.append(element);
        return;
      }

      if (name === "InlineCode") {
        const range = childRange(node, "CodeMark");
        if (!range) return appendPlain(parent, from, to);
        const code = document.createElement("code");
        code.className = "cm-inline-code";
        appendSourceShadow(code, text, node.from, range.from);
        appendPlain(code, range.from, range.to);
        appendSourceShadow(code, text, range.to, node.to);
        parent.append(code);
        return;
      }

      if (name === "Link" || name === "Autolink") {
        const range = childRange(node, "LinkMark");
        if (!range) return appendPlain(parent, from, to);
        const link = document.createElement("a");
        const href = safeLinkHref(inlineUrl(text, node));
        if (href) {
          link.href = href;
          link.rel = "noreferrer noopener";
        }
        appendSourceShadow(link, text, node.from, range.from);
        appendElements(
          link,
          node.children.filter(
            (child) => child.from >= range.from && child.to <= range.to,
          ),
          Math.max(from, range.from),
          Math.min(to, range.to),
        );
        appendSourceShadow(link, text, range.to, node.to);
        parent.append(link);
        return;
      }

      if (name === "Image") {
        const range = childRange(node, "LinkMark");
        const url = inlineUrl(text, node);
        if (!range || !url) return appendPlain(parent, from, to);
        const alt = text.slice(range.from, range.to);
        const label = imageLabel(alt);
        const src = imageSource(url, bufferName, convertFileSrc);
        if (!src) return appendPlain(parent, from, to);
        const image = document.createElement("img");
        image.className = "cm-markdown-inline-image";
        image.src = src;
        image.alt = label.alt;
        image.loading = "lazy";
        if (label.width != null) image.style.width = `${label.width}px`;
        parent.append(image);
        appendSourceShadow(parent, text, node.from, node.to);
        return;
      }

      appendPlain(parent, from, to);
    };

    appendElements(container, elements, 0, text.length);
  }

  // Last rendered height per table content (cursor excluded). Every cursor
  // move inside a table builds a new widget, and with no estimate CodeMirror
  // first sizes the block from its few source lines, then measures the real
  // table and "restores" its scroll anchor over the difference, undoing the
  // cursor scroller's move.
  const tableHeights = new Map();

  class MarkdownTableWidget extends WidgetType {
    constructor(
      header,
      align,
      rows,
      cursor,
      cellHighlights,
      cellOverlays,
      bufferName,
    ) {
      super();
      this.header = header;
      this.align = align;
      this.rows = rows;
      this.cursor = cursor;
      this.cellHighlights = cellHighlights;
      this.cellOverlays = cellOverlays;
      this.bufferName = bufferName;
      this.key = JSON.stringify([
        header,
        align,
        rows,
        cursor,
        cellHighlights,
        cellOverlays,
        bufferName,
      ]);
      this.heightKey = JSON.stringify([header, align, rows, bufferName]);
    }

    eq(other) {
      return other.key === this.key;
    }

    get estimatedHeight() {
      return tableHeights.get(this.heightKey) ?? -1;
    }

    toDOM() {
      // CodeMirror measures a block widget without its margins, so a margin
      // here would push every line below further from where its height map
      // (and with it the gutter and moveVertically) puts it, one table at a
      // time. The block's vertical spacing is the wrapper's padding instead.
      const block = document.createElement("div");
      block.className = "cm-markdown-table-block";
      const table = document.createElement("table");
      block.append(table);
      globalThis.requestAnimationFrame?.(() => {
        if (!block.offsetHeight) return;
        tableHeights.delete(this.heightKey);
        tableHeights.set(this.heightKey, block.offsetHeight);
        if (tableHeights.size > 64)
          tableHeights.delete(tableHeights.keys().next().value);
      });
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
            this.cellOverlays.filter(
              ([overlayRow, overlayCell]) =>
                overlayRow === rowIndex && overlayCell === index,
            ),
            this.bufferName,
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
      return block;
    }
  }

  function appendTableText(
    cell,
    text,
    cellHighlights,
    cellOverlays = [],
    bufferName = "",
  ) {
    appendInlineMarkdown(
      cell,
      text,
      cellHighlights,
      cellOverlays,
      bufferName,
    );
  }

  function addTableCursor(cell, cursor) {
    const textNodes = [];
    const collectTextNodes = (node) => {
      if (node.nodeType === textNodeType) {
        textNodes.push(node);
        return;
      }
      for (const child of node.childNodes ?? []) collectTextNodes(child);
    };
    collectTextNodes(cell);
    if (!textNodes.length) {
      const textNode = document.createTextNode("");
      cell.append(textNode);
      textNodes.push(textNode);
    }
    let offset = cursor.offset;
    const lastTextNode = textNodes[textNodes.length - 1];
    let textNode = lastTextNode;
    for (const candidate of textNodes) {
      if (offset < candidate.length || candidate === lastTextNode) {
        textNode = candidate;
        break;
      }
      offset -= candidate.length;
    }
    offset = Math.min(offset, textNode.length);
    // A cursor on hidden markup (the `**` of bold text) would put the caret
    // inside a display:none source shadow, invisible and with no geometry for
    // the cursor scroller to measure; show it on the nearest visible text.
    const isShadow = (node) =>
      node.parentElement?.closest(".cm-markdown-source-shadow");
    if (isShadow(textNode)) {
      const index = textNodes.indexOf(textNode);
      const next = textNodes.slice(index + 1).find((node) => !isShadow(node));
      const previous = textNodes
        .slice(0, index)
        .findLast((node) => !isShadow(node));
      if (next) {
        textNode = next;
        offset = 0;
      } else if (previous) {
        textNode = previous;
        offset = previous.length;
      }
    }
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
    constructor(text, captionHighlights, captionOverlays) {
      super();
      this.text = text;
      this.captionHighlights = captionHighlights;
      this.captionOverlays = captionOverlays;
      this.key = JSON.stringify([text, captionHighlights, captionOverlays]);
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
        clampOverlaySpans(this.text, this.captionOverlays),
      );
      return source;
    }
  }

  function imageDecorations(
    doc,
    bufferName,
    cursor,
    interactiveHighlights = [],
    interactiveOverlays = [],
  ) {
    const ranges = [];
    const rows = [];
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
      rows.push([number - 1, number - 1]);
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
        const captionOverlays = imageCaptionOverlays(
          doc,
          number - 1,
          altStart,
          altEnd,
          interactiveOverlays,
        );
        ranges.push(
          Decoration.replace({
            widget: new MarkdownImageSourceWidget(
              label.caption,
              captionHighlights,
              captionOverlays,
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
    return { deco: Decoration.set(ranges, true), rows };
  }

  // What imageDecorations reads beyond the document itself, narrowed to the
  // image rows: the cursor only matters on an image's own line.
  const imageInputKey = (rows, cursor, highlights, overlays) =>
    JSON.stringify([
      rowInSpans(rows, cursor?.row) ? cursor.row : null,
      entriesInSpans(rows, highlights),
      entriesInSpans(rows, overlays),
    ]);

  const markdownImageField = StateField.define({
    create: (state) => ({
      ...imageDecorations(state.doc, "", null),
      key: imageInputKey([], null, [], []),
      bufferName: "",
      cursor: null,
      highlights: [],
      overlays: [],
    }),
    update(value, transaction) {
      let bufferName = value.bufferName;
      let cursor = value.cursor;
      let interactiveHighlights = value.highlights;
      let interactiveOverlays = value.overlays;
      for (const effect of transaction.effects) {
        if (effect.is(setImageBase)) bufferName = effect.value;
        if (effect.is(setCursor)) cursor = effect.value;
        if (effect.is(setInteractiveHighlights)) {
          interactiveHighlights = effect.value;
        }
        if (effect.is(setInteractiveOverlays)) {
          interactiveOverlays = effect.value;
        }
      }
      if (
        !transaction.docChanged &&
        bufferName === value.bufferName &&
        cursor === value.cursor &&
        interactiveHighlights === value.highlights &&
        interactiveOverlays === value.overlays
      ) {
        return value;
      }
      const inputs = {
        bufferName,
        highlights: interactiveHighlights,
        overlays: interactiveOverlays,
        cursor,
      };
      // A cursor move or a highlight change away from every image leaves the
      // widgets as they are, without rescanning the document.
      if (!transaction.docChanged && bufferName === value.bufferName) {
        const key = imageInputKey(
          value.rows,
          cursor,
          interactiveHighlights,
          interactiveOverlays,
        );
        if (key === value.key) return { ...value, ...inputs };
      }
      const built = imageDecorations(
        transaction.state.doc,
        bufferName,
        cursor,
        interactiveHighlights,
        interactiveOverlays,
      );
      return {
        ...built,
        key: imageInputKey(
          built.rows,
          cursor,
          interactiveHighlights,
          interactiveOverlays,
        ),
        ...inputs,
      };
    },
    provide: (field) =>
      EditorView.decorations.from(field, (value) => value.deco),
  });

  function tableDecorations(
    doc,
    cursor,
    guardRow,
    tableHighlights = [],
    tableOverlays = [],
    bufferName = "",
  ) {
    const ranges = [];
    const tables = [];
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
      tables.push([number - 1, end - 1]);
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
        const cellOverlays = tableOverlayCells(
          doc,
          number - 1,
          end - 1,
          tableOverlays,
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
              cellOverlays,
              bufferName,
            ),
          }).range(line.from, last.to),
        );
      }
      number = end;
    }
    return { deco: Decoration.set(ranges, true), rows: tables };
  }

  // What tableDecorations reads beyond the document itself, narrowed to the
  // table rows: the cursor (and with it the guard row, which only reveals a
  // table the cursor is in) matters only inside a table.
  const tableInputKey = (rows, cursor, guardRow, highlights, overlays) =>
    JSON.stringify([
      rowInSpans(rows, cursor?.row)
        ? [cursor.row, cursor.col, cursor.mode, guardRow]
        : null,
      entriesInSpans(rows, highlights),
      entriesInSpans(rows, overlays),
    ]);

  const markdownTableField = StateField.define({
    create: (state) => ({
      ...tableDecorations(state.doc, null, null, [], [], ""),
      key: tableInputKey([], null, null, [], []),
      bufferName: "",
      cursor: null,
      guardRow: null,
      highlights: [],
      inlineHighlights: [],
      overlays: [],
    }),
    update(value, transaction) {
      let bufferName = value.bufferName;
      let cursor = value.cursor;
      let guardRow = value.guardRow;
      let tableHighlights = value.highlights;
      let inlineHighlights = value.inlineHighlights;
      let tableOverlays = value.overlays;
      for (const effect of transaction.effects) {
        if (effect.is(setImageBase)) bufferName = effect.value;
        if (effect.is(setCursor)) cursor = effect.value;
        if (effect.is(setTableConcealGuard)) {
          guardRow = effect.value;
        }
        if (effect.is(setTableInlineHighlights)) {
          inlineHighlights = effect.value;
        }
        if (effect.is(setInteractiveHighlights)) {
          tableHighlights = effect.value;
        }
        if (effect.is(setInteractiveOverlays)) {
          tableOverlays = effect.value;
        }
      }
      if (
        !transaction.docChanged &&
        bufferName === value.bufferName &&
        cursor === value.cursor &&
        guardRow === value.guardRow &&
        tableHighlights === value.highlights &&
        inlineHighlights === value.inlineHighlights &&
        tableOverlays === value.overlays
      ) {
        return value;
      }
      const inputs = {
        bufferName,
        cursor,
        guardRow,
        highlights: tableHighlights,
        inlineHighlights,
        overlays: tableOverlays,
      };
      const highlights = [...inlineHighlights, ...tableHighlights];
      // Profiled on the real app 2026-10-09 while holding j/k: this rescan
      // was 22% of all renderer CPU, nearly all of it from cursor moves
      // nowhere near a table. Those now keep the widgets as they are.
      if (!transaction.docChanged && bufferName === value.bufferName) {
        const key = tableInputKey(
          value.rows,
          cursor,
          guardRow,
          highlights,
          tableOverlays,
        );
        if (key === value.key) return { ...value, ...inputs };
      }
      const built = tableDecorations(
        transaction.state.doc,
        cursor,
        guardRow,
        highlights,
        tableOverlays,
        bufferName,
      );
      return {
        ...built,
        key: tableInputKey(
          built.rows,
          cursor,
          guardRow,
          highlights,
          tableOverlays,
        ),
        ...inputs,
      };
    },
    provide: (field) =>
      EditorView.decorations.from(field, (value) => value.deco),
  });

  return { markdownImageField, markdownTableField };
}
