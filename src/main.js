// Spike: ext_multigrid grid renderer for non-markdown windows, CodeMirror
// island for the markdown window, one nvim driving both.

import "../styles.css";
import { EditorView, basicSetup } from "codemirror";
import { Decoration, WidgetType } from "@codemirror/view";
import { Annotation, StateEffect, StateField, Compartment } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

// this webview's window label; event names are per-window (gnv://<label>/<kind>)
// because emit_to() broadcasts to every webview in this app.
const currentWin = getCurrentWebviewWindow();
const winLabel = currentWin.label;
const ev = (kind) => `gnv://${winLabel}/${kind}`;

const viewportEl = document.getElementById("viewport");
const te = new TextEncoder();
const byteLen = (s) => te.encode(s).length;

// mirror the webview console into the app log (spike debugging)
const jlog = (m) => invoke("js_log", { msg: String(m) }).catch(() => {});
addEventListener("error", (e) =>
  jlog(`ERROR ${e.message} @ ${e.filename}:${e.lineno}\n${e.error?.stack || ""}`),
);
addEventListener("unhandledrejection", (e) => jlog(`REJECT ${e.reason}`));
const _origErr = console.error.bind(console);
console.error = (...a) => {
  jlog("console.error " + a.map(String).join(" "));
  _origErr(...a);
};
jlog("main.js loaded");

// ---------------------------------------------------------------------------
// cell metrics (monospace grid)
// ---------------------------------------------------------------------------
let cellW = 8.4;
let cellH = 17;
let originX = 4; // left margin in px; the grid is letterboxed, see screenMetrics
let gridLinespace = 0; // from :set linespace, added to the natural line box
const GRID_FONT_FALLBACK = 'ui-monospace, "SF Mono", Menlo, monospace';
const GRID_SIZE_FALLBACK = "13px";
function measureCell() {
  const cs = getComputedStyle(document.documentElement);
  const fam = cs.getPropertyValue("--grid-font-family").trim() || GRID_FONT_FALLBACK;
  const size = cs.getPropertyValue("--grid-font-size").trim() || GRID_SIZE_FALLBACK;
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:absolute;visibility:hidden;left:-9999px;white-space:pre;" +
    `font-family:${fam};font-size:${size};line-height:1.3`;
  probe.textContent = "M".repeat(50);
  viewportEl.append(probe);
  const r = probe.getBoundingClientRect();
  cellW = r.width / 50;
  // one integer cell height, used for every row's DOM height AND the pixel math
  cellH = Math.max(1, Math.round(r.height) + gridLinespace);
  probe.remove();
  viewportEl.style.setProperty("--cell-w", cellW + "px");
  viewportEl.style.setProperty("--cell-h", cellH + "px");
}

// Parse `guifont` ("Family:h14,Fallback:h13" ...) -> { family, size } from the
// first entry. Neovim does not validate it (no built-in GUI), so anything goes.
function parseGuifont(s) {
  const first = (s || "").split(",")[0].trim();
  if (!first) return null;
  const parts = first.split(":");
  const family = parts[0].replace(/\\ /g, " ").replace(/_/g, " ").trim();
  let size = null;
  for (const p of parts.slice(1)) {
    const m = /^h([\d.]+)$/.exec(p);
    if (m) size = parseFloat(m[1]);
  }
  return { family, size };
}
function applyGuiOptRaw(name, value) {
  const root = document.documentElement.style;
  if (name === "guifont") {
    const f = parseGuifont(value);
    if (f && f.family) {
      const fam = /[^\w-]/.test(f.family) ? `"${f.family}"` : f.family;
      root.setProperty("--grid-font-family", `${fam}, ${GRID_FONT_FALLBACK}`);
    } else root.removeProperty("--grid-font-family");
    if (f && f.size) root.setProperty("--grid-font-size", `${f.size}px`);
    else root.removeProperty("--grid-font-size");
  } else if (name === "linespace") {
    gridLinespace = Math.max(0, parseInt(value, 10) || 0);
  }
}
function relayoutForFont() {
  measureCell();
  applyScreen(screenMetrics());
  lastSize = { cols: 0, rows: 0 }; // force a resize down to nvim
  pushSize();
  repaintNow();
}
function applyGuiOpt(name, value) {
  applyGuiOptRaw(name, value);
  relayoutForFont();
}

// ---------------------------------------------------------------------------
// highlight table
// ---------------------------------------------------------------------------
// id -> the rgb_attr map from hl_attr_define, verbatim: foreground, background,
// special, reverse, bold, italic, strikethrough, underline, undercurl,
// underdouble, underdotted, underdashed, blend, ...
const hlAttrs = new Map();
let defColors = { fg: "#000000", bg: "#ffffff", sp: "#d40000" };
const hex = (n) =>
  n == null || n < 0 ? null : "#" + n.toString(16).padStart(6, "0");

function luma(hex6) {
  const n = parseInt(hex6.slice(1), 16);
  return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
}

// Push Neovim's Normal colours into CSS custom properties so every surface
// (body, grid backgrounds, islands, cursors) tracks :colorscheme / :set bg.
function applyTheme() {
  const s = document.documentElement.style;
  s.setProperty("--fg", defColors.fg);
  s.setProperty("--bg", defColors.bg);
  s.setProperty("--sp", defColors.sp);
  s.colorScheme = luma(defColors.bg) < 128 ? "dark" : "light";
}

function hlCss(id) {
  const a = hlAttrs.get(id) || {};
  let fg = hex(a.foreground) ?? defColors.fg;
  let bg = hex(a.background) ?? null;
  const sp = hex(a.special) ?? defColors.sp;
  if (a.reverse || a.standout) {
    const t = fg;
    fg = bg ?? defColors.bg;
    bg = t;
  }
  let s = `color:${fg};`;
  if (bg) s += `background:${bg};`;
  if (a.bold) s += "font-weight:700;";
  if (a.italic) s += "font-style:italic;";

  const anyUnderline =
    a.underline || a.undercurl || a.underdouble || a.underdotted || a.underdashed;
  const lines = [];
  if (anyUnderline) lines.push("underline");
  if (a.strikethrough) lines.push("line-through");
  if (lines.length) s += `text-decoration-line:${lines.join(" ")};`;
  if (anyUnderline) {
    const style = a.undercurl
      ? "wavy"
      : a.underdouble
        ? "double"
        : a.underdotted
          ? "dotted"
          : a.underdashed
            ? "dashed"
            : "solid";
    s += `text-decoration-style:${style};text-decoration-color:${sp};`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// GridWin: a Neovim grid rendered as DOM cell rows
// ---------------------------------------------------------------------------
class GridWin {
  constructor(id) {
    this.id = id;
    this.cols = 0;
    this.rows = 0;
    this.cells = []; // rows of [char, hlId]
    this.el = document.createElement("div");
    this.el.className = "grid gridwin";
    this.el.dataset.grid = id;
    this.cursor = null;
  }
  resize(w, h) {
    // grid_resize does NOT imply a clear: Neovim keeps the overlapping cells and
    // only sends grid_line for what changed. Blanking here leaves stale rows
    // empty forever after a window shrinks and grows back (q:, devtools, ...).
    const old = this.cells;
    this.cells = Array.from({ length: h }, (_, r) =>
      Array.from({ length: w }, (_, c) =>
        old[r] && old[r][c] ? old[r][c] : [" ", 0],
      ),
    );
    this.cols = w;
    this.rows = h;
  }
  clear() {
    this.cells = Array.from({ length: this.rows }, () =>
      Array.from({ length: this.cols }, () => [" ", 0]),
    );
  }
  line(row, col, cells) {
    const r = this.cells[row];
    if (!r) return;
    let hl = 0;
    let c = col;
    for (const [text, cellHl, repeat] of cells) {
      if (cellHl != null) hl = cellHl;
      const n = repeat ?? 1;
      for (let k = 0; k < n && c < this.cols; k++) r[c++] = [text, hl];
    }
  }
  scroll({ top, bot, left, right, rows }) {
    const move = (from, to) => {
      for (let c = left; c < right; c++) this.cells[to][c] = this.cells[from][c];
    };
    if (rows > 0) {
      for (let r = top + rows; r < bot; r++) move(r, r - rows);
    } else if (rows < 0) {
      for (let r = bot - 1 + rows; r >= top; r--) move(r, r - rows);
    }
  }
  repaint() {
    const frag = document.createDocumentFragment();
    for (let r = 0; r < this.rows; r++) {
      const rowEl = document.createElement("div");
      rowEl.className = "grid-row";
      const row = this.cells[r];
      let run = "";
      let runHl = row.length ? row[0][1] : 0;
      const flush = () => {
        if (!run) return;
        const sp = document.createElement("span");
        sp.style.cssText = hlCss(runHl);
        sp.textContent = run;
        rowEl.append(sp);
        run = "";
      };
      for (let c = 0; c < this.cols; c++) {
        const [ch, hl] = row[c];
        // "" is the right half of a preceding double-width cell; skip it
        if (ch === "") continue;
        if (hl !== runHl) {
          flush();
          runHl = hl;
        }
        // A double-width glyph (CJK, some emoji): the next cell is "". The
        // fallback CJK font is not monospace, so pin the glyph to exactly two
        // cells or the row drifts out of sync with the cell-based cursor math.
        if (c + 1 < this.cols && row[c + 1][0] === "") {
          flush();
          const sp = document.createElement("span");
          sp.className = "wide";
          sp.style.cssText = hlCss(hl) + `width:${2 * cellW}px`;
          sp.textContent = ch;
          rowEl.append(sp);
        } else {
          run += ch;
        }
      }
      flush();
      if (this.cursor && this.cursor.row === r) {
        rowEl.dataset.cursorCol = this.cursor.col;
      }
      frag.append(rowEl);
    }
    this.el.replaceChildren(frag);
  }
}

const grids = new Map(); // gridId -> GridWin
const winPos = new Map(); // gridId -> {srow,scol,w,h,float,zindex}
const gridToWin = new Map(); // gridId -> winId
const winFt = new Map(); // winId -> filetype
const winBuf = new Map(); // winId -> bufnr
const islands = new Map(); // winId -> Island (one CM instance per markdown window)
let islandGridIds = new Set(); // gridIds currently rendered as an island
let modeName_ = "n";

function gw(id) {
  let g = grids.get(id);
  if (!g) {
    g = new GridWin(id);
    grids.set(id, g);
    viewportEl.append(g.el);
  }
  return g;
}

const isMarkdown = (wid) => (winFt.get(wid) || "").includes("markdown");

// Mount an Island over every markdown window, unmount the rest, re-point any
// whose buffer changed. `force` re-attaches every island (desync recovery).
function reconcileIslands(force = false) {
  const desired = new Map(); // winId -> gridId
  for (const [gid, wid] of gridToWin) if (isMarkdown(wid)) desired.set(wid, gid);

  for (const [wid, isl] of [...islands]) {
    if (!desired.has(wid)) {
      islands.delete(wid);
      const b = isl.bufnr;
      isl.destroy();
      if (b != null) invoke("island_detach", { buf: b }).catch(() => {});
    }
  }
  for (const wid of desired.keys()) {
    const cur = islands.get(wid);
    const wantBuf = winBuf.get(wid);
    if (!cur) {
      const isl = new Island(wid);
      islands.set(wid, isl);
      attachIsland(isl);
    } else if (force || (wantBuf != null && cur.bufnr !== wantBuf)) {
      const old = cur.bufnr;
      cur.bufnr = null;
      if (old != null) invoke("island_detach", { buf: old }).catch(() => {});
      attachIsland(cur);
    }
  }
  islandGridIds = new Set(desired.values());
  layout();
}

function attachIsland(isl) {
  invoke("island_attach", { win: isl.winId })
    .then((snap) => {
      if (islands.get(isl.winId) !== isl) return; // unmounted while awaiting
      isl.bufnr = snap.buf;
      isl.applyReset(snap);
      layout();
    })
    .catch((e) => jlog("island_attach failed: " + e));
}

const islandForGrid = (gid) => islands.get(gridToWin.get(gid));

function place(el, p) {
  el.style.left = `${p.scol * cellW + originX}px`;
  el.style.top = `${p.srow * cellH}px`;
  el.style.width = `${p.w * cellW}px`;
  el.style.height = `${p.h * cellH}px`;
  if (p.zindex != null) el.style.zIndex = p.zindex;
}

function layout() {
  for (const [gid, g] of grids) {
    if (gid === 1) {
      // outer grid: statuslines, separators, tabline. Letterboxed by originX.
      g.el.style.cssText =
        `position:absolute;left:${originX}px;right:${originX}px;top:0;bottom:0;z-index:0`;
      g.el.hidden = false;
      continue;
    }
    const p = winPos.get(gid);
    const isl = islandForGrid(gid);
    if (isl) {
      g.el.hidden = true;
      if (p) {
        place(isl.el, p);
        isl.el.style.zIndex = 5;
        const wasHidden = isl.el.hidden;
        isl.el.hidden = false;
        if (wasHidden) isl.view.requestMeasure();
      } else {
        isl.el.hidden = true;
      }
      continue;
    }
    if (!p) {
      g.el.hidden = true;
      continue;
    }
    g.el.hidden = false;
    g.el.style.position = "absolute";
    place(g.el, p);
    if (!p.float) g.el.style.zIndex = 1;
  }
}

// one block cursor for whichever grid window has focus
const gridCursorEl = document.createElement("div");
gridCursorEl.id = "grid-cursor";
gridCursorEl.hidden = true;
viewportEl.append(gridCursorEl);
let cursorGrid = 1;
let modeInfo = []; // from mode_info_set, indexed by mode_change idx
let cursorStyleEnabled = false;
let curMode = null; // modeInfo entry for the current mode

// ---------------------------------------------------------------------------
// grid-window IME: a hidden contenteditable at the cursor is the composition
// surface (grid windows are plain divs). Its input / compositionend forward the
// committed text to nvim via nvim_input, which inserts it and moves the cursor.
// ---------------------------------------------------------------------------
let imeComposing = false;
// A hidden <textarea> is the keyboard/IME sink for grid windows (the standard
// pattern: Monaco, ace, CodeMirror 5). It stays focused so macOS keeps the
// user's input source, and is readOnly outside insert mode so the OS IME has
// nothing to compose into (preventDefault alone does not reliably stop a
// textarea composition in a production WebKit build). If macOS still re-picks
// the default input source on the readonly->editable flip, disable "Keyboard >
// Automatically switch to a document's input source".
const imeEl = document.createElement("textarea");
imeEl.id = "ime";
imeEl.rows = 1;
imeEl.spellcheck = false;
imeEl.autocapitalize = "off";
imeEl.setAttribute("autocorrect", "off");
imeEl.readOnly = true;
viewportEl.append(imeEl);

function imeFlush() {
  const v = imeEl.value;
  imeEl.value = "";
  if (v && gridInsertActive())
    invoke("nvim_input", { keys: v.replace(/</g, "<lt>") });
}
imeEl.addEventListener("compositionstart", () => {
  imeComposing = true;
});
imeEl.addEventListener("compositionend", () => {
  imeComposing = false;
  imeFlush(); // discards if we somehow composed outside insert mode
});
imeEl.addEventListener("input", () => {
  if (!imeComposing) imeFlush();
});

function gridInsertActive() {
  return !islandForGrid(cursorGrid) && /^(insert|replace)/.test(modeName_);
}
// #ime stays FOCUSED whenever a grid window holds the cursor, in every mode, so
// macOS keeps the user's chosen input source. It is only contenteditable in
// insert mode; outside insert mode a focused-but-non-editable element gives the
// OS IME nothing to compose into, so normal-mode keys reach nvim untouched.
function updateImeFocus() {
  if (islandForGrid(cursorGrid)) {
    if (document.activeElement === imeEl) imeEl.blur();
    return;
  }
  const ro = !gridInsertActive();
  if (imeEl.readOnly !== ro) imeEl.readOnly = ro;
  if (ro && imeComposing) {
    imeComposing = false; // left insert mid-composition: drop it
    imeEl.value = "";
  }
  if (document.activeElement !== imeEl) imeEl.focus({ preventScroll: true });
}
addEventListener("focus", () => {
  updateImeFocus(); // regain focus after cmd-tab
  invoke("nvim_input", { keys: "<FocusGained>" }).catch(() => {});
});
addEventListener("blur", () => {
  invoke("nvim_input", { keys: "<FocusLost>" }).catch(() => {});
});
let blinkTimer = 0;
function stopBlink() {
  clearTimeout(blinkTimer);
  blinkTimer = 0;
  gridCursorEl.style.opacity = "";
}
// blink per guicursor (blinkwait / blinkon / blinkoff, ms); restarts on move.
function startBlink() {
  stopBlink();
  const m = cursorStyleEnabled ? curMode : null;
  const on = (m && m.blinkon) | 0;
  const off = (m && m.blinkoff) | 0;
  if (!on || !off) return; // 0 in either -> steady cursor
  let visible = true;
  const step = () => {
    visible = !visible;
    gridCursorEl.style.opacity = visible ? "" : "0";
    blinkTimer = setTimeout(step, visible ? on : off);
  };
  blinkTimer = setTimeout(step, ((m && m.blinkwait) | 0) || on);
}

function placeGridCursor() {
  const g = grids.get(cursorGrid);
  const p = winPos.get(cursorGrid);
  if (!g || !g.cursor || !p || islandForGrid(cursorGrid)) {
    gridCursorEl.hidden = true;
    stopBlink();
    return;
  }
  const x = (p.scol + g.cursor.col) * cellW + originX;
  const y = (p.srow + g.cursor.row) * cellH;
  imeEl.style.left = `${x}px`; // anchor the IME candidate window at the cursor
  imeEl.style.top = `${y}px`;
  const m = cursorStyleEnabled ? curMode : null;
  const shape = (m && m.cursor_shape) || "block";
  const pct = m && m.cell_percentage ? m.cell_percentage / 100 : 1;
  gridCursorEl.hidden = false;
  gridCursorEl.dataset.shape = shape;
  gridCursorEl.style.zIndex = (p.zindex ?? 1) + 1; // ride above the focused float
  if (shape === "vertical") {
    gridCursorEl.style.left = `${x}px`;
    gridCursorEl.style.top = `${y}px`;
    gridCursorEl.style.width = `${Math.max(1, cellW * pct)}px`;
    gridCursorEl.style.height = `${cellH}px`;
  } else if (shape === "horizontal") {
    const h = Math.max(1, cellH * pct);
    gridCursorEl.style.left = `${x}px`;
    gridCursorEl.style.top = `${y + cellH - h}px`;
    gridCursorEl.style.width = `${cellW}px`;
    gridCursorEl.style.height = `${h}px`;
  } else {
    gridCursorEl.style.left = `${x}px`;
    gridCursorEl.style.top = `${y}px`;
    gridCursorEl.style.width = `${cellW}px`;
    gridCursorEl.style.height = `${cellH}px`;
  }
  // block cursor uses the CSS white+difference invert; bars get the Cursor
  // highlight's colour, or the theme foreground
  const attr = m && m.attr_id != null ? hlAttrs.get(m.attr_id) : null;
  gridCursorEl.style.background =
    shape === "block" ? "" : (attr && hex(attr.background)) || "var(--fg)";
  startBlink();
}

const fromNvim = Annotation.define();
const setNvimCursor = StateEffect.define();

class BlockCursor extends WidgetType {
  toDOM() {
    const s = document.createElement("span");
    s.className = "nvim-cursor nvim-cursor-block nvim-cursor-eol";
    s.textContent = " ";
    return s;
  }
}
function cursorDeco(state, pos) {
  if (!pos || pos.mode[0] === "i") return Decoration.none;
  const doc = state.doc;
  const line = doc.line(Math.min(pos.row + 1, doc.lines));
  const from = Math.min(line.from + pos.col, line.to);
  const to = Math.min(from + 1, line.to);
  return from === to
    ? Decoration.set([
        Decoration.widget({ widget: new BlockCursor(), side: 1 }).range(from),
      ])
    : Decoration.set([
        Decoration.mark({ class: "nvim-cursor nvim-cursor-block" }).range(from, to),
      ]);
}
const nvimCursorField = StateField.define({
  create: () => ({ deco: Decoration.none, pos: null }),
  update(v, tr) {
    let pos = v.pos;
    for (const e of tr.effects) if (e.is(setNvimCursor)) pos = e.value;
    return { deco: cursorDeco(tr.state, pos), pos };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

// The run of text present in `b` but not `a` (common prefix + suffix removed).
function diffInserted(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (
    s < a.length - p &&
    s < b.length - p &&
    a[a.length - 1 - s] === b[b.length - 1 - s]
  )
    s++;
  return b.slice(p, b.length - s);
}

// Non-editable content is not focusable on its own; the tabindex keeps it the
// keyboard's target so keydown still reaches the global nvim_input path.
const EDITABLE_ON = EditorView.editable.of(true);
const EDITABLE_OFF = [
  EditorView.editable.of(false),
  EditorView.contentAttributes.of({ tabindex: "0" }),
];

// One CodeMirror instance bound to one markdown window and its buffer.
class Island {
  constructor(winId) {
    this.winId = winId;
    this.bufnr = null;
    this.mode = "n";
    this.editableComp = new Compartment();
    this.editable = true;
    this.el = document.createElement("div");
    this.el.className = "island";
    this.el.hidden = true;
    viewportEl.append(this.el);
    this.compose = null; // { text, sel } snapshot while an IME composition runs
    this.view = new EditorView({
      doc: "",
      extensions: [
        basicSetup,
        markdown(),
        EditorView.lineWrapping,
        nvimCursorField,
        this.editableComp.of(EDITABLE_ON),
        EditorView.updateListener.of((u) => this.onUpdate(u)),
        EditorView.domEventHandlers({
          mousedown: (ev, v) => this.onMousedown(ev, v),
        }),
      ],
      parent: this.el,
    });
    // The OS IME composes into .cm-content; on commit we hand the text to nvim
    // via nvim_input (so nvim inserts it AND moves the cursor), then revert the
    // local composition so nvim's buffer echo is the single source of truth.
    const cd = this.view.contentDOM;
    cd.addEventListener("compositionstart", () => {
      this.compose = {
        text: this.view.state.doc.toString(),
        sel: this.view.state.selection.main.head,
      };
    });
    cd.addEventListener("compositionend", (e) => this.onComposeEnd(e));
  }
  tx(spec) {
    this.view.dispatch({ ...spec, annotations: fromNvim.of(true) });
  }
  // Keep the OS input method off the island outside insert/replace mode: an IME
  // only engages on a contenteditable surface, so a keypress in normal mode
  // (e.g. `j` with a CJK IME) reaches nvim as a key instead of composing a
  // glyph into the buffer. readOnly is untouched, so nvim's own edits still
  // render. See ZenNotes ca2e18d.
  setEditable(on) {
    if (on === this.editable) return;
    this.editable = on;
    this.view.dispatch({
      effects: this.editableComp.reconfigure(on ? EDITABLE_ON : EDITABLE_OFF),
    });
    // Insert mode needs the .cm-content focused so the OS IME composes into it;
    // in normal mode we do not (keys are global), so leave focus alone.
    if (on) this.view.focus();
  }
  destroy() {
    this.view.destroy();
    this.el.remove();
  }
  onUpdate(u) {
    if (!u.docChanged) return;
    if (!u.transactions.some((tr) => !tr.annotation(fromNvim))) return;
    // leave IME composition alone: forwarding it (and the buffer echo bouncing
    // back) aborts the composition. onComposeEnd handles the committed text.
    if (
      this.compose ||
      u.transactions.some((tr) => tr.isUserEvent("input.type.compose"))
    )
      return;
    const oldDoc = u.startState.doc;
    const regions = [];
    u.changes.iterChanges((fromA, toA, _b, _c, inserted) => {
      const s = oldDoc.lineAt(fromA);
      const e = oldDoc.lineAt(toA);
      regions.push({
        startRow: s.number - 1,
        startCol: byteLen(s.text.slice(0, fromA - s.from)),
        endRow: e.number - 1,
        endCol: byteLen(e.text.slice(0, toA - e.from)),
        replacement: inserted.toJSON(),
      });
    });
    regions.reverse();
    if (this.bufnr != null) invoke("nvim_edit", { buf: this.bufnr, regions });
  }
  onComposeEnd(e) {
    const snap = this.compose;
    this.compose = null;
    if (!snap) return;
    const now = this.view.state.doc.toString();
    const text = e.data || diffInserted(snap.text, now);
    // revert the local composition; nvim's echo of nvim_input will re-add it
    if (now !== snap.text) {
      this.tx({
        changes: { from: 0, to: now.length, insert: snap.text },
        selection: { anchor: Math.min(snap.sel, snap.text.length) },
      });
    }
    if (text) invoke("nvim_input", { keys: text.replace(/</g, "<lt>") });
  }
  onMousedown(ev, v) {
    const pos = v.posAtCoords({ x: ev.clientX, y: ev.clientY });
    if (pos == null) return false;
    const line = v.state.doc.lineAt(pos);
    invoke("nvim_cursor_set", {
      win: this.winId,
      row: line.number - 1,
      col: byteLen(line.text.slice(0, pos - line.from)),
    }).catch(() => {});
    return false;
  }
  applyBufLines(a, lastline, linedata) {
    const doc = this.view.state.doc;
    const L = doc.lines;
    const b = lastline < 0 ? L : lastline;
    let from;
    let to;
    let insert;
    if (a >= L) {
      from = doc.length;
      to = doc.length;
      insert = linedata.map((l) => "\n" + l).join("");
    } else if (b >= L) {
      if (a === 0) {
        from = 0;
        to = doc.length;
        insert = linedata.join("\n");
      } else {
        from = doc.line(a).to;
        to = doc.length;
        insert = linedata.length ? "\n" + linedata.join("\n") : "";
      }
    } else {
      from = doc.line(a + 1).from;
      to = doc.line(b + 1).from;
      insert = linedata.map((l) => l + "\n").join("");
    }
    try {
      this.tx({ changes: { from, to, insert } });
    } catch (err) {
      jlog("island desync " + err);
      reconcileIslands(true);
    }
  }
  applyCursor(row, col, mode) {
    this.mode = mode;
    // if this island holds the cursor, keep its .cm-content focused so hasFocus
    // is reliable (needed for the insert-mode IME carve-out), in every mode
    if (gridToWin.get(cursorGrid) === this.winId && !this.view.hasFocus)
      this.view.focus();
    // editable only in insert / replace / select mode, unless the guard is off
    this.setEditable(!blockImeInNormalMode || /^[iRsS\x13]/.test(mode));
    const doc = this.view.state.doc;
    const line = doc.line(Math.min(row + 1, doc.lines));
    const pos = Math.min(line.from + col, line.to);
    this.tx({
      selection: { anchor: pos },
      effects: setNvimCursor.of({ row, col, mode }),
    });
    this.el.dataset.mode = mode;
  }
  clearCursor() {
    this.tx({ effects: setNvimCursor.of(null) });
    // cursor left this island; drop focus so keys go to the global path
    if (this.view.hasFocus) this.view.contentDOM.blur();
    updateImeFocus();
  }
  applyReset(m) {
    this.tx({
      changes: { from: 0, to: this.view.state.doc.length, insert: m.lines.join("\n") },
    });
    this.applyCursor(m.row, m.col, m.mode);
  }
  scrollTo(topline) {
    const doc = this.view.state.doc;
    const l = Math.min(Math.max(topline, 0), doc.lines - 1);
    this.view.dispatch({
      effects: EditorView.scrollIntoView(doc.line(l + 1).from, { y: "start" }),
      annotations: fromNvim.of(true),
    });
  }
}

// ---------------------------------------------------------------------------
// grid op stream
// ---------------------------------------------------------------------------
function applyGridBatch(ops) {
  let dirty = new Set();
  let layoutDirty = false;
  for (const o of ops) {
    switch (o.op) {
      case "resize":
        gw(o.grid).resize(o.w, o.h);
        dirty.add(o.grid);
        break;
      case "clear":
        gw(o.grid).clear();
        dirty.add(o.grid);
        break;
      case "destroy": {
        const g = grids.get(o.grid);
        if (g) g.el.remove();
        grids.delete(o.grid);
        winPos.delete(o.grid);
        gridToWin.delete(o.grid);
        layoutDirty = true;
        break;
      }
      case "line":
        gw(o.grid).line(o.row, o.col, o.cells);
        dirty.add(o.grid);
        break;
      case "scroll":
        gw(o.grid).scroll(o);
        dirty.add(o.grid);
        break;
      case "cursor":
        gw(o.grid).cursor = { row: o.row, col: o.col };
        if (o.grid !== cursorGrid) {
          const prev = islandForGrid(cursorGrid);
          cursorGrid = o.grid;
          // focus left an island: drop its now-stale block cursor decoration
          if (prev && prev !== islandForGrid(o.grid)) prev.clearCursor();
        }
        break;
      case "win_pos":
        winPos.set(o.grid, { srow: o.srow, scol: o.scol, w: o.w, h: o.h });
        if (o.win != null) gridToWin.set(o.grid, o.win);
        layoutDirty = true;
        break;
      case "win_float": {
        const fg = grids.get(o.grid) || {};
        const w = fg.cols || 20;
        const h = fg.rows || 5;
        // position is relative to anchor_grid (grid 1 = whole screen, at 0,0)
        const ap =
          o.agrid != null && o.agrid !== 1 ? winPos.get(o.agrid) : null;
        let srow = (ap ? ap.srow : 0) + (o.arow ?? 0);
        let scol = (ap ? ap.scol : 0) + (o.acol ?? 0);
        const anchor = o.anchor || "NW"; // which float corner sits at (row,col)
        if (anchor[0] === "S") srow -= h;
        if (anchor[1] === "E") scol -= w;
        winPos.set(o.grid, {
          srow: Math.round(srow),
          scol: Math.round(scol),
          w,
          h,
          float: true,
          zindex: o.zindex ?? 50,
        });
        if (o.win != null) gridToWin.set(o.grid, o.win);
        layoutDirty = true;
        break;
      }
      case "win_hide":
      case "win_close": {
        const g = grids.get(o.grid);
        if (g) g.el.hidden = true;
        winPos.delete(o.grid);
        layoutDirty = true;
        break;
      }
      case "msg_pos": {
        const mg = grids.get(o.grid) || {};
        winPos.set(o.grid, {
          srow: o.row,
          scol: 0,
          w: mg.cols || (grids.get(1) || {}).cols || 200,
          h: mg.rows || 1,
          zindex: 250, // messages ride above floats
        });
        layoutDirty = true;
        break;
      }
      case "viewport": {
        const isl = islandForGrid(o.grid);
        if (isl) {
          isl.scrollTo(o.topline);
          // re-seat the island cursor after a bare window switch (no CursorMoved)
          if (cursorGrid === o.grid && o.curline != null)
            isl.applyCursor(o.curline, o.curcol ?? 0, isl.mode);
        }
        break;
      }
      case "colors":
        // default_colors_set carries the Normal group's fg/bg/sp; it re-fires on
        // every :colorscheme and :set background. Honor it. The hardcoded values
        // are only a fallback for when nvim sends -1 (no Normal colors).
        defColors = {
          fg: hex(o.fg) ?? defColors.fg,
          bg: hex(o.bg) ?? defColors.bg,
          sp: hex(o.sp) ?? defColors.sp,
        };
        applyTheme();
        dirty = new Set(grids.keys());
        break;
      case "hl":
        hlAttrs.set(o.id, o.attr || {});
        break;
      case "mode":
        modeName_ = o.name || modeName_;
        curMode = o.idx != null ? modeInfo[o.idx] ?? null : curMode;
        break;
      case "mode_info":
        cursorStyleEnabled = !!o.enabled;
        modeInfo = o.modes || [];
        break;
      case "title":
        currentWin.setTitle(o.title || "gneovim").catch(() => {});
        break;
      case "flush":
        break;
    }
  }
  if (layoutDirty) reconcileIslands();
  for (const id of dirty) {
    const g = grids.get(id);
    if (g && !islandGridIds.has(id)) {
      g.repaint();
      // WKWebView will not composite a freshly rebuilt absolutely-positioned
      // subtree until an unrelated event (scroll/resize). Force a reflow.
      forceRepaint(g.el);
    }
  }
  placeGridCursor();
  updateImeFocus();
}

function forceRepaint(el) {
  const prev = el.style.display;
  el.style.display = "none";
  void el.offsetHeight; // reflow
  el.style.display = prev;
}

// nvim's process exited / the pipe dropped: freeze with a message.
function showGone(reason) {
  jlog("nvim gone: " + reason);
  if (document.getElementById("gone")) return;
  const el = document.createElement("div");
  el.id = "gone";
  el.textContent = `${reason || "Neovim exited"} — close this window.`;
  document.body.append(el);
}

// On WindowEvent::Focused, Rust emits gnv://<label>/focus; rebuild every grid as
// cheap insurance against a stale WKWebView surface after a tab/window reveal.
function repaintNow() {
  for (const [id, g] of grids) if (!islandGridIds.has(id)) g.repaint();
  for (const isl of islands.values()) isl.view.requestMeasure();
  layout();
  placeGridCursor();
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------
const MIN_PAD_X = 4; // minimum left/right breathing room, px
// Fit an integer cell grid in the viewport and letterbox it: the sub-cell
// horizontal remainder is split evenly so left and right margins match.
// originX is the left margin; every grid is placed at scol*cellW + originX.
function screenMetrics() {
  const r = viewportEl.getBoundingClientRect();
  const cols = Math.max(20, Math.floor((r.width - 2 * MIN_PAD_X) / cellW));
  const rows = Math.max(4, Math.floor(r.height / cellH));
  const padX = Math.max(MIN_PAD_X, Math.round((r.width - cols * cellW) / 2));
  return { cols, rows, padX };
}
function applyScreen(m) {
  originX = m.padX;
  layout();
  placeGridCursor();
}
let lastSize = { cols: 0, rows: 0 };
let resizeTimer = 0;
function pushSize() {
  applyScreen(screenMetrics()); // margins follow the frame immediately
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const m = screenMetrics();
    if (m.cols === lastSize.cols && m.rows === lastSize.rows) return;
    lastSize = { cols: m.cols, rows: m.rows };
    invoke("nvim_resize", { cols: m.cols, rows: m.rows }).catch(() => {});
  }, 40); // coalesce a live drag into one nvim resize per frame-ish
}

// surface any uncaught error as visible text (webview has no visible console)
addEventListener("error", (e) => {
  const pre = document.createElement("pre");
  pre.style.cssText =
    "position:fixed;inset:0;margin:0;padding:1rem;background:#300;color:#fdd;white-space:pre-wrap;z-index:999;font:12px monospace";
  pre.textContent = `${e.message}\n${e.filename}:${e.lineno}\n${e.error?.stack || ""}`;
  document.body.append(pre);
});

(async function boot() {
  try {
    const cfg = await invoke("gnv_config");
    optionIsMeta = cfg?.input?.option_is_meta ?? true;
    blockImeInNormalMode = cfg?.input?.block_ime_in_normal_mode ?? true;
    forwardCmdKeys = cfg?.input?.forward_cmd_keys ?? false;
    if (matchMedia?.("(pointer: coarse)")?.matches) blockImeInNormalMode = false;
    jlog(
      `config: option_is_meta=${optionIsMeta} block_ime=${blockImeInNormalMode} ` +
        `forward_cmd=${forwardCmdKeys}`,
    );
  } catch (e) {
    jlog("gnv_config failed: " + e);
  }

  // measure the grid cell only once fonts + stylesheet are actually applied,
  // otherwise the probe reports the UA proportional default (~14x18)
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  measureCell();
  if (cellW > 11) {
    // still looks proportional; give styles one more frame and retry
    await new Promise((r) => requestAnimationFrame(r));
    measureCell();
  }

  // register every listener BEFORE anything can trigger a redraw
  await Promise.all([
    listen(ev("grid"), (e) => applyGridBatch(e.payload)),
    listen(ev("winft"), (e) => {
      winFt.set(e.payload.win, e.payload.ft || "");
      if (e.payload.buf != null) winBuf.set(e.payload.win, e.payload.buf);
      reconcileIslands();
    }),
    listen(ev("reset"), (e) => {
      for (const isl of islands.values())
        if (isl.bufnr === e.payload.buf) isl.applyReset(e.payload);
    }),
    listen(ev("lines"), (e) => {
      const { buf, firstline, lastline, linedata } = e.payload;
      for (const isl of islands.values())
        if (isl.bufnr === buf) isl.applyBufLines(firstline, lastline, linedata);
    }),
    listen(ev("cursor"), (e) => {
      // CursorMoved reports the *global* cursor wherever focus is; route it to
      // the island that owns the focused grid, if any.
      const isl = islandForGrid(cursorGrid);
      if (isl) isl.applyCursor(e.payload.row, e.payload.col, e.payload.mode);
    }),
    listen(ev("cmdline"), () => {}),
    listen(ev("cmdline_hide"), () => {}),
    listen(ev("focus"), () => repaintNow()),
    listen(ev("guiopt"), (e) => applyGuiOpt(e.payload.name, e.payload.value)),
    listen(ev("gone"), (e) => showGone(e.payload)),
  ]);

  jlog(`listeners ready; cellW=${cellW.toFixed(2)} cellH=${cellH.toFixed(2)}`);

  // Now that grid/winft listeners are live, attach the Neovim UI. The first
  // redraw (every window's grid_line) is emitted only after this point, so
  // nothing is lost and no redraw-replay hack is needed.
  const m0 = screenMetrics();
  applyScreen(m0);
  for (let i = 0; i < 100; i++) {
    try {
      await invoke("nvim_ui_start", { cols: m0.cols, rows: m0.rows });
      jlog(`ui_start ok ${m0.cols}x${m0.rows} pad=${m0.padX}`);
      break;
    } catch (e) {
      if (i === 20) jlog("ui_start still failing: " + e);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // winft events fired before we were listening; replay them. reconcileIslands()
  // then mounts an island on every markdown window that exists.
  try {
    for (const [win, buf, ft] of await invoke("nvim_winfts")) {
      winFt.set(win, ft || "");
      if (buf != null) winBuf.set(win, buf);
    }
    reconcileIslands();
    jlog(`winfts replayed: ${JSON.stringify([...winFt])}`);
  } catch (e) {
    jlog("winfts failed: " + e);
  }

  // GUI options (guifont / linespace) set before we were listening
  try {
    let changed = false;
    for (const [name, value] of await invoke("nvim_guiopts")) {
      applyGuiOptRaw(name, value);
      if (value) changed = true;
    }
    if (changed) relayoutForFont();
  } catch (e) {
    jlog("guiopts failed: " + e);
  }

  lastSize = { cols: m0.cols, rows: m0.rows };
  new ResizeObserver(() => pushSize()).observe(viewportEl);
  setTimeout(
    () =>
      jlog(
        `state: grids=${grids.size} winPos=${winPos.size} ` +
          `islands=${islands.size} winFt=${JSON.stringify([...winFt])}`,
      ),
    800,
  );
})();

// ---------------------------------------------------------------------------
// keyboard -> nvim_input
// ---------------------------------------------------------------------------
const NAMED = {
  Enter: "CR",
  Backspace: "BS",
  Tab: "Tab",
  Escape: "Esc",
  Delete: "Del",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
  " ": "Space",
  Help: "Help",
  Undo: "Undo",
};
const MOD_ONLY = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "Dead",
  "Unidentified",
  "Process",
  "AltGraph",
  "Fn",
  "FnLock",
]);

// from config [input] option_is_meta; Option+<key> -> <M-...> instead of é/•/…
let optionIsMeta = true;
// from config [input] block_ime_in_normal_mode; islands go non-editable outside
// insert mode so a CJK IME cannot hijack normal-mode keys
let blockImeInNormalMode = true;
// from config [input] forward_cmd_keys; send Cmd+<key> to nvim as <D-...>
let forwardCmdKeys = false;

// physical-key -> character, to recover the key when Option composed it away
const CODE_CHAR = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Space: " ",
};
function baseFromCode(e) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(e.code))) return m[1].toLowerCase();
  if ((m = /^(?:Digit|Numpad)([0-9])$/.exec(e.code))) return m[1];
  return CODE_CHAR[e.code] ?? null;
}

function keyToNvim(e) {
  if (e.isComposing || e.keyCode === 229) return null; // mid-IME composition
  // Cmd is the macOS app/menu modifier; only forward it if asked.
  if (e.metaKey && !forwardCmdKeys) return null;
  const k = e.key;
  const isF = /^F([1-9]|1\d|2[0-4])$/.test(k);

  // Option-as-Meta: on macOS Option+<key> is a dead key at the OS level, so
  // e.key is "Dead" or a composed glyph. Recover the real key from e.code.
  if (optionIsMeta && e.altKey && !e.ctrlKey && !e.metaKey) {
    if (e.code === "AltLeft" || e.code === "AltRight") return null;
    const bc = baseFromCode(e);
    let base =
      NAMED[k] ??
      (isF ? k : undefined) ??
      NAMED[bc] ??
      bc ??
      (k.length === 1 && k.charCodeAt(0) < 0x80 ? k : undefined);
    if (base == null) return null;
    return `<M-${e.shiftKey ? "S-" : ""}${base === "<" ? "lt" : base}>`;
  }

  if (MOD_ONLY.has(k)) return null;

  let base = NAMED[k];
  let named = base !== undefined;
  if (!named && isF) {
    base = k;
    named = true;
  }
  if (!named) {
    if (k.length !== 1) return null;
    // Option composed a character (option_is_meta off): send it literally
    if (e.altKey && !e.ctrlKey && !e.metaKey && k.charCodeAt(0) > 0x7f) return k;
    base = k === "<" ? "lt" : k;
    if (/[A-Za-z]/.test(base) && (e.ctrlKey || e.metaKey || e.altKey)) {
      base = base.toLowerCase();
    }
  }

  let mods = "";
  if (e.metaKey) mods += "D-";
  if (e.ctrlKey) mods += "C-";
  if (e.altKey) mods += "M-";
  if (e.shiftKey && (named || mods)) mods += "S-";

  if (mods || named || base === "lt") return `<${mods}${base}>`;
  return base;
}

addEventListener("keydown", (e) => {
  if (imeComposing) return; // IME is mid-composition; let #ime + the OS handle it
  const keys = keyToNvim(e);
  if (keys === null) return; // mid-composition / lone modifier
  // grid window in insert mode: plain text goes into the #ime textarea for the
  // OS IME; its input / compositionend forward to nvim. Control keys pass here.
  if (
    gridInsertActive() &&
    document.activeElement === imeEl &&
    !keys.startsWith("<")
  )
    return;
  e.preventDefault();
  invoke("nvim_input", { keys });
});

// ---------------------------------------------------------------------------
// mouse -> nvim_input_mouse. With `mouse=a`, nvim does all the hit-testing:
// window focus, cursor placement, drag-select, split-resize on a border drag,
// statusline %@ / fold / sign clicks, multi-click word/line select.
// ---------------------------------------------------------------------------
const MOUSE_BTN = ["left", "middle", "right"];
const overIsland = (e) => e.target?.closest?.(".island, #ime");
function mouseCell(e) {
  return {
    row: Math.max(0, Math.floor(e.clientY / cellH)),
    col: Math.max(0, Math.floor((e.clientX - originX) / cellW)),
  };
}
function mouseMods(e) {
  return (
    (e.ctrlKey ? "C-" : "") +
    (e.shiftKey ? "S-" : "") +
    (e.altKey ? "M-" : "") +
    (e.metaKey ? "D-" : "")
  );
}
const nvimMouse = (button, action, e, cell) =>
  invoke("nvim_mouse", {
    button,
    action,
    modifier: mouseMods(e),
    row: cell.row,
    col: cell.col,
  }).catch(() => {});

let drag = null; // { button, row, col }
viewportEl.addEventListener("mousedown", (e) => {
  const button = MOUSE_BTN[e.button];
  if (!button || overIsland(e)) return;
  e.preventDefault(); // keep DOM focus on #ime; no text selection on the grid
  const cell = mouseCell(e);
  drag = { button, ...cell };
  nvimMouse(button, "press", e, cell);
});
addEventListener("mousemove", (e) => {
  if (!drag) return;
  const cell = mouseCell(e);
  if (cell.row === drag.row && cell.col === drag.col) return;
  drag.row = cell.row;
  drag.col = cell.col;
  nvimMouse(drag.button, "drag", e, cell);
});
addEventListener("mouseup", (e) => {
  if (!drag) return;
  nvimMouse(drag.button, "release", e, mouseCell(e));
  drag = null;
});
viewportEl.addEventListener("contextmenu", (e) => {
  if (!overIsland(e)) e.preventDefault();
});

let wheelY = 0;
let wheelX = 0;
const WHEEL_STEP = 40; // px of gesture per nvim wheel notch
viewportEl.addEventListener(
  "wheel",
  (e) => {
    if (overIsland(e)) return;
    e.preventDefault();
    const k =
      e.deltaMode === 1 ? cellH * 3 : e.deltaMode === 2 ? viewportEl.clientHeight : 1;
    wheelY += e.deltaY * k;
    wheelX += e.deltaX * k;
    const cell = mouseCell(e);
    while (wheelY >= WHEEL_STEP) (wheelY -= WHEEL_STEP), nvimMouse("wheel", "down", e, cell);
    while (wheelY <= -WHEEL_STEP) (wheelY += WHEEL_STEP), nvimMouse("wheel", "up", e, cell);
    while (wheelX >= WHEEL_STEP) (wheelX -= WHEEL_STEP), nvimMouse("wheel", "right", e, cell);
    while (wheelX <= -WHEEL_STEP) (wheelX += WHEEL_STEP), nvimMouse("wheel", "left", e, cell);
  },
  { passive: false },
);
