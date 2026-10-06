import { GridStore } from "./grid-store.js";

const PLAIN_ASCII = /^[\x20-\x7e]$/;

// A Neovim grid rendered as reusable DOM rows. Browser and highlight
// dependencies are injected so this module has no import-time DOM side effects.
export class GridView {
  constructor(id, { document, highlightCss, cellWidth }) {
    this.id = id;
    this.document = document;
    this.highlightCss = highlightCss;
    this.cellWidth = cellWidth;
    this.store = new GridStore();
    this.el = document.createElement("div");
    this.el.className = "grid gridwin";
    this.el.dataset.grid = id;
    this.cursor = null;
    this.rowEls = [];
    this.dirtyRows = new Set();
    this.fullDirty = true;
  }

  get cols() {
    return this.store.cols;
  }

  get rows() {
    return this.store.rows;
  }

  get cells() {
    return this.store.cells;
  }

  resize(width, height) {
    // Neovim preserves overlapping cells across grid_resize.
    this.store.resize(width, height);
    this.fullDirty = true;
  }

  clear() {
    this.store.clear();
    this.fullDirty = true;
  }

  line(row, col, cells) {
    if (!this.store.line(row, col, cells)) return;
    this.dirtyRows.add(row);
  }

  scroll(spec) {
    if (!this.store.scroll(spec)) return;
    const { top, bot, left, right, rows } = spec;
    const region = bot - top;
    if (left === 0 && right === this.cols && this.rowEls.length === this.rows) {
      const segment = this.rowEls.slice(top, bot);
      const amount = ((rows % region) + region) % region;
      const rotated = segment.slice(amount).concat(segment.slice(0, amount));
      for (let index = 0; index < region; index++) this.rowEls[top + index] = rotated[index];
      const anchor = this.rowEls[bot] || null;
      for (let index = top; index < bot; index++) {
        this.el.insertBefore(this.rowEls[index], anchor);
      }
      if (rows > 0) {
        for (let row = bot - rows; row < bot; row++) this.dirtyRows.add(row);
      } else {
        for (let row = top; row < top - rows; row++) this.dirtyRows.add(row);
      }
    } else {
      for (let row = top; row < bot; row++) this.dirtyRows.add(row);
    }
  }

  paintRow(rowIndex) {
    const rowElement = this.rowEls[rowIndex];
    const row = this.cells[rowIndex];
    const fragment = this.document.createDocumentFragment();
    let run = "";
    let runHighlight = row.length ? row[0][1] : 0;
    const flush = () => {
      if (!run) return;
      const span = this.document.createElement("span");
      span.style.cssText = this.highlightCss(runHighlight);
      span.textContent = run;
      fragment.append(span);
      run = "";
    };
    for (let col = 0; col < this.cols; col++) {
      const [character, highlight] = row[col];
      if (character === "") continue;
      if (highlight !== runHighlight) {
        flush();
        runHighlight = highlight;
      }
      const wide = col + 1 < this.cols && row[col + 1][0] === "";
      // A non-ASCII cell is pinned too: its glyph often comes from a fallback
      // font wider than one cell (⚠, …, ✻), which in a flowing text run
      // shifts the rest of the row right. Pinned, it can only overlap.
      if (wide || !PLAIN_ASCII.test(character)) {
        flush();
        const span = this.document.createElement("span");
        span.className = wide ? "wide" : "narrow";
        span.style.cssText =
          this.highlightCss(highlight) + `width:${(wide ? 2 : 1) * this.cellWidth()}px`;
        span.textContent = character;
        fragment.append(span);
      } else {
        run += character;
      }
    }
    flush();
    rowElement.replaceChildren(fragment);
  }

  // Paint just the first `count` rows, for a grid an island covers below
  // them (its winbar). The rest stays as it is; whatever releases the grid
  // back to the renderer forces a full repaint anyway.
  repaintTop(count) {
    let rebuilt = false;
    if (this.rowEls.length !== this.rows) {
      this.rowEls = Array.from({ length: this.rows }, () => {
        const row = this.document.createElement("div");
        row.className = "grid-row";
        return row;
      });
      this.el.replaceChildren(...this.rowEls);
      rebuilt = true;
    }
    for (let row = 0; row < Math.min(count, this.rows); row++) {
      if (rebuilt || this.fullDirty || this.dirtyRows.has(row)) this.paintRow(row);
      this.dirtyRows.delete(row);
    }
  }

  repaint() {
    if (this.fullDirty || this.rowEls.length !== this.rows) {
      this.rowEls = Array.from({ length: this.rows }, () => {
        const row = this.document.createElement("div");
        row.className = "grid-row";
        return row;
      });
      this.el.replaceChildren(...this.rowEls);
      for (let row = 0; row < this.rows; row++) this.paintRow(row);
    } else {
      for (const row of this.dirtyRows) if (row < this.rows) this.paintRow(row);
    }
    this.fullDirty = false;
    this.dirtyRows.clear();
  }
}
