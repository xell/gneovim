import { Decoration, WidgetType } from "@codemirror/view";
import { byteRange } from "./pure/text-geometry.js";
import { visualRanges } from "./pure/visual-ranges.js";
import { foldRanges, overlapsRanges } from "./pure/fold-ranges.js";
import {
  headingMarkerRanges,
  headingSuffixRanges,
  listMarkerRanges,
  listMarkerRows,
  nonOverlappingSpans,
  quoteMarkerRanges,
  structuralLineStarts,
} from "./pure/markdown-decoration-plan.js";

// Depth-cycled glyphs for unordered bullets, repeating every 3 levels
// (Bear-style: solid dot, hollow ring, diamond).
const LIST_BULLET_GLYPHS = ["●", "○", "◆"];
// CSS only carries a handful of `cm-list-depth-N` rules (see styles.css);
// deeper nesting just reuses the deepest one and keeps cycling glyphs.
const MAX_LIST_DEPTH_CLASS = 7;

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
    span.setAttribute("contenteditable", "false");
    span.textContent = this.text;
    return span;
  }
}

// The `#`/`>`/ordered-marker source characters this editor conceals
// entirely, kept as a real (zero-size, in-flow) text node rather than
// dropped from the DOM. See the .cm-ax-shadow comment in styles.css for why.
class HiddenTextWidget extends WidgetType {
  constructor(document, text) {
    super();
    this.document = document;
    this.text = text;
  }

  eq(other) {
    return other.text === this.text;
  }

  toDOM() {
    return hiddenText(this.document, this.text);
  }
}

function hiddenText(document, text) {
  const span = document.createElement("span");
  span.className = "cm-ax-shadow";
  span.setAttribute("contenteditable", "false");
  span.textContent = text;
  return span;
}

class ListBulletWidget extends WidgetType {
  constructor(document, depth, text, cursorHere) {
    super();
    this.document = document;
    this.depth = depth;
    this.text = text;
    this.cursorHere = cursorHere;
  }

  eq(other) {
    return (
      other.depth === this.depth &&
      other.text === this.text &&
      other.cursorHere === this.cursorHere
    );
  }

  // .cm-list-bullet is deliberately position: absolute (out of text flow,
  // for the hanging-indent alignment -- see styles.css), which is itself
  // enough to throw off the same accessibility text-position translation
  // .cm-ax-shadow otherwise fixes, independent of whether the widget has
  // real text: confirmed live, this bullet's own glyph is real text and
  // still drifted. The shadow sibling here stays in normal flow so an
  // accessibility client's position math has something to count, while the
  // visual bullet keeps its existing out-of-flow placement untouched.
  //
  // A Normal-mode cursor sitting on the marker's own hidden characters has
  // nowhere else to render -- same problem the heading icon had (see
  // cm-heading-icon-cursor), same fix: cm-list-bullet-cursor draws a
  // reversed-video block behind the glyph instead.
  toDOM() {
    const bullet = this.document.createElement("span");
    bullet.className = this.cursorHere
      ? "cm-list-bullet cm-list-bullet-cursor"
      : "cm-list-bullet";
    bullet.setAttribute("contenteditable", "false");
    bullet.textContent = LIST_BULLET_GLYPHS[this.depth % LIST_BULLET_GLYPHS.length];
    const wrapper = this.document.createElement("span");
    wrapper.setAttribute("contenteditable", "false");
    wrapper.append(bullet);
    wrapper.append(hiddenText(this.document, this.text));
    return wrapper;
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
    span.setAttribute("contenteditable", "false");
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
    setInteractiveOverlays,
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
    this.setInteractiveOverlays = setInteractiveOverlays;
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
    this.interactiveOverlaysKey = null;
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
    if (payload?.nontext_fg) {
      this.element.style.setProperty("--nontext-fg", payload.nontext_fg);
    } else {
      this.element.style.removeProperty("--nontext-fg");
    }
    if (payload?.linenr_fg) {
      this.element.style.setProperty("--linenr-fg", payload.linenr_fg);
    } else {
      this.element.style.removeProperty("--linenr-fg");
    }
    // The heading icon's reversed-video cursor block: the colorscheme's own
    // 'Cursor' highlight, not an invented color. Either half can be missing
    // (see cursor_hl in md_decor.lua); styles.css falls back to --fg/--bg
    // itself via var()'s second argument, so only set what we actually have.
    if (payload?.cursor_hl?.bg) {
      this.element.style.setProperty("--cursor-bg", payload.cursor_hl.bg);
    } else {
      this.element.style.removeProperty("--cursor-bg");
    }
    if (payload?.cursor_hl?.fg) {
      this.element.style.setProperty("--cursor-fg", payload.cursor_hl.fg);
    } else {
      this.element.style.removeProperty("--cursor-fg");
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
    // hop.nvim's per-target hint letters (virt_text overlay, hl.virt): every
    // entry is a candidate, tableOverlayCells / imageCaptionOverlays drop
    // whatever isn't actually inside that table's rows or that image's
    // caption. Unlike interactiveHighlights this needs no group filtering:
    // hl.virt only ever carries overlay extmarks in the first place.
    const interactiveOverlays = payload?.hl?.virt ?? [];
    const interactiveOverlaysKey = JSON.stringify(interactiveOverlays);
    if (this.interactiveOverlaysKey !== interactiveOverlaysKey) {
      this.interactiveOverlaysKey = interactiveOverlaysKey;
      interactiveEffects.push(
        this.setInteractiveOverlays.of(interactiveOverlays),
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
    // Confirmed live (see conversation): a custom widget standing in for the
    // hidden "#"s is what broke Grammarly's own AX-based position math --
    // independent of the widget's content, and independent of column-0 vs
    // mid-line (markdown links conceal far more text this same
    // widget-less way and never had the problem). So every heading level
    // hides its marker exactly like quote/list markers and links do: real
    // hidden text, no widget standing in for it. The icon is drawn
    // separately below, as a line-level CSS decoration that never replaces
    // any document text, so there is nothing left for that translation to
    // get wrong.
    //
    // Leo's call, 2026-09-16: the icon is the permanent, always-visible
    // representation of a heading marker; the raw "#"s only ever surface
    // while actively typing there. So unlike quote/list markers (which keep
    // sharing the ordinary guardRow -- reveal on the cursor's line in any
    // mode), a heading's own marker reveals only in Insert mode; a Normal-
    // mode cursor sitting on the line never uncovers it, and the icon shows
    // a reversed-video cursor block instead (cm-heading-icon-cursor),
    // reviving 7103ab0's visual with the new line-decoration structure.
    const cursor = this.getCursor();
    const mode = this.getMode();
    const headingGuardRow = mode[0] === "i" ? guardRow : -1;
    const headingIconLines = [];
    for (const { row, from, to, level } of headingMarkerRanges(
      doc,
      payload?.heads,
      headingGuardRow,
      inFold,
    )) {
      spans.push({
        from,
        to,
        deco: Decoration.replace({
          widget: new HiddenTextWidget(
            this.document,
            doc.sliceString(from, to),
          ),
        }),
      });
      if (level <= 3) {
        headingIconLines.push({
          from,
          level,
          cursorHere: cursor?.row === row && cursor.col === 0,
        });
      }
    }
    for (const { from, to } of quoteMarkerRanges(
      doc,
      payload?.quotes,
      guardRow,
      inFold,
    )) {
      spans.push({
        from,
        to,
        deco: Decoration.replace({
          widget: new HiddenTextWidget(this.document, doc.sliceString(from, to)),
        }),
      });
    }
    for (const { row, from, to, depth, ordered } of listMarkerRanges(
      doc,
      payload?.lists,
      guardRow,
      inFold,
    )) {
      // listMarkerRanges anchors `from` at the line's own start (indentation
      // is part of the hidden run), so the cursor's byte column compares
      // directly against the run's own length -- no separate line lookup
      // needed.
      const cursorHere =
        !ordered && cursor?.row === row && cursor.col < to - from;
      spans.push({
        from,
        to,
        deco: ordered
          ? Decoration.replace({
              widget: new HiddenTextWidget(this.document, doc.sliceString(from, to)),
            })
          : Decoration.replace({
              widget: new ListBulletWidget(
                this.document,
                depth,
                doc.sliceString(from, to),
                cursorHere,
              ),
            }),
      });
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
            : Decoration.replace({
                widget: new HiddenTextWidget(
                  this.document,
                  doc.sliceString(range.from, range.to),
                ),
              }),
        });
      }
    }

    const ranges = [];
    for (const span of nonOverlappingSpans(spans)) {
      ranges.push(span.deco.range(span.from, span.to));
    }
    // The heading icon: a pure CSS line decoration (see .cm-heading-icon-*
    // in styles.css), not a widget standing in for any text -- see the
    // comment above headingIconLines. It never disappears on its own (the
    // heading-specific guard row above already excludes a row from this
    // list entirely once Insert mode reveals its raw "#"s, so there is
    // nothing left to hide here); a Normal-mode cursor sitting on the line
    // instead gets a reversed-video cursor block drawn behind the glyph.
    for (const { from, level, cursorHere } of headingIconLines) {
      ranges.push(
        lineDecoration(
          `cm-heading-icon-line cm-heading-icon-line-${level}${
            cursorHere ? " cm-heading-icon-cursor" : ""
          }`,
        ).range(from),
      );
    }
    for (const { from, to } of headingSuffixRanges(
      doc,
      payload?.heads,
      inFold,
    )) {
      ranges.push(
        Decoration.mark({ class: "cm-heading-suffix" }).range(from, to),
      );
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
    // '---' dividers keep their literal source text (search/EasyMotion/hop
    // all read real text, not a widget's rendered stand-in -- see the
    // heading-icon widget's Grammarly regression above), and just get a
    // line class; the rule itself is a pure CSS ::after, drawn after the
    // text rather than replacing it.
    for (const row of payload?.hrs ?? []) {
      addLines(row, row, "cm-hr-line");
    }
    // Every row belonging to a list item gets the depth's padding-left, so a
    // hard-wrapped item's continuation lines (no marker of their own) still
    // form a left-aligned text column under the marker row's own text.
    for (const [row, depth] of payload?.lists ?? []) {
      addLines(
        row,
        row,
        `cm-list-depth-${Math.min(Math.max(depth, 0), MAX_LIST_DEPTH_CLASS)}`,
      );
    }
    // Only an *ordered* marker row also needs the text-indent pull-back: its
    // digits are real text sharing the line's normal flow, so they have to
    // be yanked back out of the text column by hand. An unordered bullet is
    // a widget positioned out of flow entirely (see .cm-list-bullet in
    // styles.css), so it never needs this, and adding it anyway would pull
    // the real text after the bullet left too.
    for (const { row, ordered } of listMarkerRows(doc, payload?.lists)) {
      if (ordered) addLines(row, row, "cm-list-marker-line");
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
