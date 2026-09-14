import { Decoration, WidgetType } from "@codemirror/view";
import { byteRange } from "./pure/text-geometry.js";
import { visualRanges } from "./pure/visual-ranges.js";
import { foldRanges, overlapsRanges } from "./pure/fold-ranges.js";
import {
  headingMarkerRanges,
  nonOverlappingSpans,
  quoteMarkerRanges,
  structuralLineStarts,
} from "./pure/markdown-decoration-plan.js";

class ConcealWidget extends WidgetType {
  constructor(document, text) {
    super();
    this.document = document;
    this.text = text;
  }

  eq(other) {
    return other.text === this.text;
  }

  toDOM() {
    const span = this.document.createElement("span");
    span.className = "cm-concealed";
    span.textContent = this.text;
    return span;
  }
}

class HeadingIconWidget extends WidgetType {
  constructor(document, level, cursorMode = null) {
    super();
    this.document = document;
    this.level = level;
    this.cursorMode = cursorMode;
  }

  eq(other) {
    return (
      other.level === this.level &&
      other.cursorMode === this.cursorMode
    );
  }

  toDOM() {
    const span = this.document.createElement("span");
    const cursorClass =
      this.cursorMode == null
        ? ""
        : this.cursorMode[0] === "i"
          ? " cm-heading-icon-cursor-bar"
          : " cm-heading-icon-cursor-block";
    span.className = `cm-heading-icon${cursorClass}`;
    const glyph = this.document.createElement("span");
    glyph.className =
      `cm-heading-icon-glyph cm-heading-icon-${this.level}`;
    span.append(glyph);
    return span;
  }
}

class OverlayWidget extends WidgetType {
  constructor(document, highlights, segments) {
    super();
    this.document = document;
    this.highlights = highlights;
    this.segments = segments;
  }

  eq(other) {
    return (
      other.segments.length === this.segments.length &&
      other.segments.every(
        ([text, group], index) =>
          text === this.segments[index][0] &&
          group === this.segments[index][1],
      )
    );
  }

  toDOM() {
    const span = this.document.createElement("span");
    for (const [text, group] of this.segments) {
      const segment = this.document.createElement("span");
      if (group) {
        segment.className = this.highlights.islandClass(group);
      }
      segment.textContent = text;
      span.append(segment);
    }
    return span;
  }
}

// Owns the parsed runtime/md_decor.lua payload and all CodeMirror decorations
// derived from it. Decorations remain view-only and never reach nvim_edit.
export class IslandDisplayDecorations {
  constructor({
    document,
    highlights,
    view,
    element,
    decorationState,
    setTableConcealGuard,
    setInteractiveHighlights,
    getCursor,
    getMode,
    cancelPendingZeroScrolloff,
    keepPositionInView,
    keepCursorInView,
    requestFrame,
    forceRepaint,
    log,
  }) {
    this.document = document;
    this.highlights = highlights;
    this.view = view;
    this.element = element;
    this.decorationState = decorationState;
    this.setTableConcealGuard = setTableConcealGuard;
    this.setInteractiveHighlights = setInteractiveHighlights;
    this.getCursor = getCursor;
    this.getMode = getMode;
    this.cancelPendingZeroScrolloff = cancelPendingZeroScrolloff;
    this.keepPositionInView = keepPositionInView;
    this.keepCursorInView = keepCursorInView;
    this.requestFrame = requestFrame;
    this.forceRepaint = forceRepaint;
    this.log = log;
    this.payload = null;
    this.easyMotionOverlay = false;
    this.interactiveHighlightsKey = null;
    this.incsearchKey = "";
  }

  set(payload) {
    this.payload = payload;
    this.easyMotionOverlay = (payload?.hl?.runs ?? []).some(
      ([, , , group]) => /^EasyMotion(?:Target|Shade)/.test(group),
    );
    if (this.easyMotionOverlay) this.cancelPendingZeroScrolloff();

    if (payload?.visual_hl) {
      this.element.style.setProperty("--visual-bg", payload.visual_hl);
    } else {
      this.element.style.removeProperty("--visual-bg");
    }
    if (payload?.accent_fg) {
      this.element.style.setProperty("--accent", payload.accent_fg);
    } else {
      this.element.style.removeProperty("--accent");
    }

    // The table and image-caption widgets replace real source text with
    // their own DOM (see markdown-presentation.js), so interactive and
    // search highlights need to be copied into it directly; an ordinary
    // Decoration.mark on that text has nothing left to mark. EasyMotionShade
    // would dim every table cell, and HopUnmatched likewise (hop.nvim's own
    // dim_unmatched), so neither is let through; HopPreview is hop's own
    // IncSearch-alike highlight extmark for the pattern typed so far in its
    // first ("type a pattern") step, an ordinary hl_group extmark like
    // Search/IncSearch, not the virt_text overlay hop's second ("pick a hint
    // letter") step draws.
    const interactiveHighlights = (payload?.hl?.runs ?? []).filter(
      ([, , , group]) =>
        /^EasyMotionTarget/.test(group) ||
        group === "Search" ||
        group === "IncSearch" ||
        group === "HopPreview",
    );
    const interactiveHighlightsKey = JSON.stringify(interactiveHighlights);
    const interactiveEffects = [
      this.setTableConcealGuard.of(payload?.guard_row ?? null),
    ];
    if (this.interactiveHighlightsKey !== interactiveHighlightsKey) {
      this.interactiveHighlightsKey = interactiveHighlightsKey;
      interactiveEffects.push(
        this.setInteractiveHighlights.of(interactiveHighlights),
      );
    }
    this.view.dispatch({ effects: interactiveEffects });
    this.apply();

    const incsearch = payload?.incsearch ?? null;
    const incsearchKey = incsearch
      ? `${incsearch[0]}/${incsearch[1]}`
      : "";
    if (incsearchKey !== this.incsearchKey) {
      const wasSearching = Boolean(this.incsearchKey);
      this.incsearchKey = incsearchKey;
      if (incsearch) {
        this.keepPositionInView({
          row: incsearch[0],
          col: incsearch[1],
        });
      } else if (wasSearching) {
        // Follow the authoritative cursor event after Enter or Escape.
        this.requestFrame(() => this.keepCursorInView());
      }
    }
  }

  apply() {
    const payload = this.payload;
    const doc = this.view.state.doc;
    const {
      concealHide,
      islandDecorField,
      islandFoldField,
      lineDecoration,
      setIslandDecor,
      setIslandFolds,
      visualMark,
    } = this.decorationState;

    // A closed fold hides everything after its first line through the final
    // line's text. The first line remains available for normal decorations.
    const { spans: foldSpans, firstLines: foldLines } = foldRanges(
      doc,
      payload?.folds,
    );
    const inFold = (from, to) =>
      overlapsRanges(foldSpans, from, to);

    const guardRow = payload?.guard_row ?? -1;
    const spans = [];
    for (const { row, from, to, level } of headingMarkerRanges(
      doc,
      payload?.heads,
      guardRow,
      inFold,
    )) {
      const cursor = this.getCursor();
      const cursorMode =
        cursor?.row === row && cursor.col === 0
          ? this.getMode()
          : null;
      spans.push({
        from,
        to,
        deco:
          level <= 3
            ? Decoration.replace({
                widget: new HeadingIconWidget(
                  this.document,
                  level,
                  cursorMode,
                ),
              })
            : concealHide,
      });
    }
    for (const { from, to } of quoteMarkerRanges(
      doc,
      payload?.quotes,
      guardRow,
      inFold,
    )) {
      spans.push({ from, to, deco: concealHide });
    }

    for (const [row, col, hide, segments] of payload?.hl?.virt ?? []) {
      const range = byteRange(doc, row, col, col + hide);
      if (range && !inFold(range.from, range.to)) {
        spans.push({
          ...range,
          deco: Decoration.replace({
            widget: new OverlayWidget(
              this.document,
              this.highlights,
              segments,
            ),
          }),
        });
      }
    }
    for (const [row, startCol, endCol, text] of payload?.conceal ?? []) {
      const range = byteRange(doc, row, startCol, endCol);
      if (range && !inFold(range.from, range.to)) {
        spans.push({
          ...range,
          deco: text
            ? Decoration.replace({
                widget: new ConcealWidget(this.document, text),
              })
            : concealHide,
        });
      }
    }

    const ranges = [];
    for (const span of nonOverlappingSpans(spans)) {
      ranges.push(span.deco.range(span.from, span.to));
    }
    for (const [row, startCol, endCol] of payload?.hl?.codespans ?? []) {
      const range = byteRange(doc, row, startCol, endCol);
      if (range && !inFold(range.from, range.to)) {
        ranges.push(
          Decoration.mark({ class: "cm-inline-code" }).range(
            range.from,
            range.to,
          ),
        );
      }
    }
    for (const [row, startCol, endCol, group] of payload?.hl?.runs ?? []) {
      const range = byteRange(doc, row, startCol, endCol);
      if (range && !inFold(range.from, range.to)) {
        ranges.push(
          Decoration.mark({
            class: this.highlights.islandClass(group),
          }).range(range.from, range.to),
        );
      }
    }
    for (const range of visualRanges(doc, payload?.visual, inFold)) {
      ranges.push(visualMark.range(range.from, range.to));
    }
    for (const foldLine of foldLines) {
      ranges.push(
        Decoration.mark({ class: "cm-fold-closed" }).range(
          foldLine.from,
          foldLine.to,
        ),
      );
    }

    const addLines = (startRow, endRow, className) => {
      const decoration = lineDecoration(className);
      for (const from of structuralLineStarts(
        doc,
        startRow,
        endRow,
        inFold,
      )) {
        ranges.push(decoration.range(from));
      }
    };
    for (const [startRow, endRow, level] of payload?.heads ?? []) {
      addLines(
        startRow,
        endRow,
        `cm-h${Math.min(Math.max(level, 1), 6)}`,
      );
    }
    for (const [startRow, endRow] of payload?.codes ?? []) {
      addLines(startRow, endRow, "cm-code-block");
    }
    for (const [startRow, endRow] of payload?.quotes ?? []) {
      addLines(startRow, endRow, "cm-blockquote");
    }

    const foldSet = Decoration.set(
      foldSpans.map((fold) => concealHide.range(fold.from, fold.to)),
    );
    const state = this.view.state;
    const noDecorationChange =
      !ranges.length && !state.field(islandDecorField).size;
    const noFoldChange =
      !foldSpans.length && !state.field(islandFoldField).size;
    if (noDecorationChange && noFoldChange) return;

    const effects = [];
    if (!noDecorationChange) {
      try {
        effects.push(
          setIslandDecor.of(Decoration.set(ranges, true)),
        );
      } catch (error) {
        this.log("island decor build failed: " + error);
      }
    }
    if (!noFoldChange) effects.push(setIslandFolds.of(foldSet));
    if (!effects.length) return;

    this.view.dispatch({ effects });
    // WKWebView can leave an idle absolute subtree applied but unpainted.
    const hadFocus = this.view.hasFocus;
    this.forceRepaint(this.element);
    if (hadFocus) this.view.focus();
  }
}
