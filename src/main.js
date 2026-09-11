// gneovim frontend: an ext_multigrid grid renderer for non-markdown windows,
// a CodeMirror island for each markdown window, one nvim driving both.

import "../styles.css";
import { EditorView, Decoration, WidgetType, lineNumbers } from "@codemirror/view";
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
// Inverse of byteLen: the UTF-16 offset into `s` at byte column `byte`. Neovim
// extmark / cursor columns are byte offsets; CodeMirror positions are UTF-16.
function byteToCol(s, byte) {
  let b = 0;
  for (let i = 0; i < s.length; i++) {
    if (b >= byte) return i;
    const c = s.codePointAt(i);
    b += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    if (c >= 0x10000) i++; // surrogate pair: skip the low surrogate
  }
  return s.length;
}

// mirror the webview console into the app log (the webview has no visible one)
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

// blend (0-100, from hl_attr_define) is the cell's transparency: 0 opaque,
// 100 invisible. Append an alpha byte so the cell composites over whatever the
// grid element's background is (floats/pum with winblend/pumblend).
const withAlpha = (css, blend) =>
  blend && /^#[0-9a-f]{6}$/i.test(css)
    ? css +
      Math.round((100 - blend) * 2.55)
        .toString(16)
        .padStart(2, "0")
    : css;

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
  // Neovim's default DiagnosticUnderline* groups (and themes copying them) set
  // fg == bg on purpose: the glyph is meant to be invisible so only the
  // undercurl / underline in `sp` shows. Rendered literally that is a solid
  // block of unreadable text. Drop both colours so the run inherits Normal
  // fg/bg; the text-decoration below still draws the squiggle.
  const camouflage = bg && fg.toLowerCase() === bg.toLowerCase();
  const blend = a.blend | 0;
  let s = camouflage ? "" : `color:${withAlpha(fg, blend)};`;
  if (bg && !camouflage) s += `background:${withAlpha(bg, blend)};`;
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
    // row-level repaint: one reused <div class="grid-row"> per row, and the set
    // of rows whose cells changed since the last repaint. `fullDirty` forces a
    // rebuild of every row (resize, clear, colour change, stale-surface repaint).
    this.rowEls = [];
    this.dirtyRows = new Set();
    this.fullDirty = true;
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
    this.fullDirty = true; // row count / width changed: rebuild all rows
  }
  clear() {
    this.cells = Array.from({ length: this.rows }, () =>
      Array.from({ length: this.cols }, () => [" ", 0]),
    );
    this.fullDirty = true;
  }
  line(row, col, cells) {
    const r = this.cells[row];
    if (!r) return;
    this.dirtyRows.add(row);
    let hl = 0;
    let c = col;
    for (const [text, cellHl, repeat] of cells) {
      if (cellHl != null) hl = cellHl;
      const n = repeat ?? 1;
      for (let k = 0; k < n && c < this.cols; k++) r[c++] = [text, hl];
    }
  }
  scroll({ top, bot, left, right, rows }) {
    if (!rows || bot <= top) return;
    const move = (from, to) => {
      for (let c = left; c < right; c++) this.cells[to][c] = this.cells[from][c];
    };
    if (rows > 0) {
      for (let r = top + rows; r < bot; r++) move(r, r - rows);
    } else {
      for (let r = bot - 1 + rows; r >= top; r--) move(r, r - rows);
    }
    // Full-width scroll: move the row nodes to match the cell shift so the
    // scrolled text is never re-serialized. Only the vacated band needs
    // repainting (Neovim's following grid_line fills it; mark it dirty so a
    // blank scroll-in still paints). A sub-column region (left/right) is rare
    // and can't move whole nodes, so fall back to repainting the band.
    const region = bot - top;
    if (left === 0 && right === this.cols && this.rowEls.length === this.rows) {
      const seg = this.rowEls.slice(top, bot);
      const k = ((rows % region) + region) % region; // left-rotate amount
      const rotated = seg.slice(k).concat(seg.slice(0, k));
      for (let i = 0; i < region; i++) this.rowEls[top + i] = rotated[i];
      const anchor = this.rowEls[bot] || null;
      for (let i = top; i < bot; i++)
        this.el.insertBefore(this.rowEls[i], anchor);
      if (rows > 0) for (let r = bot - rows; r < bot; r++) this.dirtyRows.add(r);
      else for (let r = top; r < top - rows; r++) this.dirtyRows.add(r);
    } else {
      for (let r = top; r < bot; r++) this.dirtyRows.add(r);
    }
  }
  paintRow(r) {
    const rowEl = this.rowEls[r];
    const row = this.cells[r];
    const frag = document.createDocumentFragment();
    let run = "";
    let runHl = row.length ? row[0][1] : 0;
    const flush = () => {
      if (!run) return;
      const sp = document.createElement("span");
      sp.style.cssText = hlCss(runHl);
      sp.textContent = run;
      frag.append(sp);
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
        frag.append(sp);
      } else {
        run += ch;
      }
    }
    flush();
    rowEl.replaceChildren(frag);
  }
  repaint() {
    if (this.fullDirty || this.rowEls.length !== this.rows) {
      this.rowEls = Array.from({ length: this.rows }, () => {
        const d = document.createElement("div");
        d.className = "grid-row";
        return d;
      });
      this.el.replaceChildren(...this.rowEls);
      for (let r = 0; r < this.rows; r++) this.paintRow(r);
    } else {
      for (const r of this.dirtyRows) if (r < this.rows) this.paintRow(r);
    }
    this.fullDirty = false;
    this.dirtyRows.clear();
  }
}

const grids = new Map(); // gridId -> GridWin
const winPos = new Map(); // gridId -> {srow,scol,w,h,float,zindex}
const gridToWin = new Map(); // gridId -> winId
const winFt = new Map(); // winId -> filetype
const winBuf = new Map(); // winId -> bufnr
const islands = new Map(); // winId -> Island (one CM instance per markdown window)
let islandGridIds = new Set(); // gridIds currently rendered as an island
// winId -> bool: markdown-live-preview flag, from runtime/md_preview.lua's
// `w:gnv_md_preview` (gnv://<label>/md_preview events + the winfts replay).
// Absent -> fall back to livePreviewDefault.
const previewWins = new Map();
// winId -> { number, relativenumber, numberwidth, signcolumn, foldcolumn }, the
// window's gutter options mirrored from Neovim (runtime/md_preview.lua feed +
// the nvim_wingutters replay). Applied to the island's gutter compartment.
const winGutter = new Map();
let livePreviewDefault = true; // from gnv_config [markdown] live_preview_default
let modeName_ = "n";

// ---------------------------------------------------------------------------
// island highlight groups: Neovim resolves every treesitter capture / hl_group
// to concrete attrs (md_decor.lua `hl.defs`); we turn each into one CSS rule in
// a shared <style>, and mark the runs with the matching class. Names -> a short
// stable class, so `@markup.strong.markdown_inline` does not go in the DOM.
// ---------------------------------------------------------------------------
const hlClassBy = new Map(); // group name -> "cm-h-<n>"
const hlDefs = new Map(); // group name -> attrs (accumulated across payloads)
let hlStyleEl = null;
function hlClass(group) {
  let c = hlClassBy.get(group);
  if (!c) {
    c = "cm-h-" + hlClassBy.size;
    hlClassBy.set(group, c);
  }
  return c;
}
function rebuildHlStyle() {
  let css = "";
  // Lowest priority first, so a higher layer's rule is written *later* in the
  // stylesheet: when two decorations cover the same character (a "shade" mark
  // spanning a whole line under a brighter "target" mark on one letter of it,
  // easymotion's own pattern) they land on the same flattened element client
  // side, and CSS gives the later same-specificity rule the win. Map
  // iteration order is otherwise just payload arrival order, which does not
  // reflect which layer should show through.
  const sorted = [...hlDefs].sort(
    (a, b) => (a[1].priority ?? 0) - (b[1].priority ?? 0),
  );
  for (const [group, a] of sorted) {
    let fg = a.fg;
    let bg = a.bg;
    if (a.reverse) [fg, bg] = [bg || "var(--bg)", fg || "var(--fg)"];
    // fg == bg is deliberate camouflage (diagnostic underline groups): drop
    // both so only the squiggle shows, matching the grid renderer's hlCss.
    if (fg && fg === bg) fg = bg = null;
    const p = [];
    if (fg) p.push(`color:${fg}`);
    if (bg) p.push(`background-color:${bg}`);
    if (a.bold) p.push("font-weight:700");
    if (a.italic) p.push("font-style:italic");
    const dec = [];
    if (a.underline) dec.push("underline");
    if (a.undercurl) dec.push("underline wavy");
    if (a.strikethrough) dec.push("line-through");
    if (dec.length) {
      p.push(`text-decoration:${dec.join(" ")}`);
      if (a.sp) p.push(`text-decoration-color:${a.sp}`);
    }
    if (p.length) css += `.island .${hlClass(group)}{${p.join(";")}}\n`;
  }
  if (!hlStyleEl) {
    hlStyleEl = document.createElement("style");
    document.head.append(hlStyleEl);
  }
  hlStyleEl.textContent = css;
}
function mergeHlDefs(defs) {
  // a group's attrs only change on ColorScheme, which clears hlDefs and the
  // <style>; so only a genuinely new group needs a rebuild. Comparing attrs
  // every push (and regenerating the whole <style>) forced a document-wide
  // style recalc on every keystroke.
  let added = false;
  for (const [group, a] of Object.entries(defs)) {
    if (!hlDefs.has(group)) {
      hlDefs.set(group, a);
      added = true;
    }
  }
  if (added) rebuildHlStyle();
}

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
// A window gets a CM island only if it is markdown AND its live-preview flag is
// on (explicit per-window value, else the configured default). Turning it off
// drops the window back to plain grid rendering like every other window.
const wantIsland = (wid) =>
  isMarkdown(wid) &&
  (previewWins.has(wid) ? previewWins.get(wid) : livePreviewDefault);

// Mount an Island over every previewed markdown window, unmount the rest,
// re-point any whose buffer changed. `force` re-attaches every island.
function reconcileIslands(force = false) {
  const desired = new Map(); // winId -> gridId
  for (const [gid, wid] of gridToWin) if (wantIsland(wid)) desired.set(wid, gid);

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
      if (winGutter.has(wid)) isl.setGutter(winGutter.get(wid));
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
      // no md_decor trigger event has fired for this window yet; pull once.
      invoke("nvim_md_decor").catch(() => {});
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
    // normal split grids sit at the base layer; a grid with an explicit zindex
    // (the message / cmdline grid) keeps the value place() just set.
    if (!p.float && p.zindex == null) g.el.style.zIndex = 1;
  }
}

// one block cursor for whichever grid window has focus
const gridCursorEl = document.createElement("div");
gridCursorEl.id = "grid-cursor";
gridCursorEl.hidden = true;
viewportEl.append(gridCursorEl);
let cursorGrid = 1;
// Last gnv_cursor payload (buffer row/col/mode), kept even while cursorGrid
// points elsewhere. gnv_cursor (the buffer position feed) and grid_cursor_goto
// (which grid owns it) are two independent streams; if a grid_cursor_goto that
// hands the island back its grid arrives *after* the gnv_cursor event for the
// same move (a message/prompt grid can transiently own grid_cursor_goto during
// a blocking getchar(), e.g. easymotion's "Target key:" prompt), the island
// misses the update and its cursor stays hidden until an unrelated move
// re-fires both. Re-applying the cached payload when the island regains its
// grid closes that gap without depending on event arrival order.
let lastCursorPayload = null;
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
// The insert-mode caret. Its own widget, not CodeMirror's, so the buffer echo
// (a whole-line replace on every keystroke) can never map it to the line start.
class BarCursor extends WidgetType {
  toDOM() {
    const s = document.createElement("span");
    s.className = "nvim-cursor nvim-cursor-bar";
    return s;
  }
}
// Replacement glyph for an extmark conceal at conceallevel 1 (the `cchar`).
// conceallevel >= 2 sends an empty string and gets a plain Decoration.replace.
class ConcealWidget extends WidgetType {
  constructor(text) {
    super();
    this.text = text;
  }
  eq(o) {
    return o.text === this.text;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-concealed";
    s.textContent = this.text;
    return s;
  }
}
// Replaces a concealed ATX "#.. " run on an H1-H3 line. Not a Neovim conceal:
// the island hides these itself, independent of conceallevel, as part of the
// heading size / icon styling (see applyDecor). H4-H6 just hide, no icon.
class HeadingIconWidget extends WidgetType {
  constructor(level) {
    super();
    this.level = level;
  }
  eq(o) {
    return o.level === this.level;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = `cm-heading-icon cm-heading-icon-${this.level}`;
    return s;
  }
}
// An overlay virt_text extmark (hop.nvim's jump-target letters and similar):
// new content drawn in place of the buffer text it covers, not a recolouring
// of it. Each segment gets the same hlClass() as any other highlight group.
class OverlayWidget extends WidgetType {
  constructor(segs) {
    super();
    this.segs = segs;
  }
  eq(o) {
    return (
      o.segs.length === this.segs.length &&
      o.segs.every(([t, g], i) => t === this.segs[i][0] && g === this.segs[i][1])
    );
  }
  toDOM() {
    const s = document.createElement("span");
    for (const [text, group] of this.segs) {
      const t = document.createElement("span");
      if (group) t.className = hlClass(group);
      t.textContent = text;
      s.append(t);
    }
    return s;
  }
}
// A plain hidden run with no replacement text: blockquote "> " markers (the
// cm-blockquote line decoration already draws the bar) and H4-H6 markers.
// One shared instance; identical specs compare equal so it never re-renders.
const CONCEAL_HIDE = Decoration.replace({});
// A closed Neovim fold: one placeholder line (foldtextresult) replacing the
// whole folded range. Display only; open the fold from Neovim (`zo`). A span,
// not a div: this is an inline (non-block) replace widget, CSS makes it a line.
class FoldWidget extends WidgetType {
  constructor(text) {
    super();
    this.text = text;
  }
  eq(o) {
    return o.text === this.text;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-nvim-fold";
    s.textContent = this.text || "···";
    return s;
  }
}
// Display-bridge decorations, in two fields.
//
// islandDecorField: conceal, highlights, visual range. Marks and short inline
// replaces. Mapped through edits (guarded) so they stay put between the ~20ms
// pushes without flashing on every keystroke.
//
// islandFoldField: closed-fold replaces only. A fold replace spans line breaks,
// and mapping one through certain edits corrupts the set so that every later
// `map(tr.changes)` throws, which aborts the transaction and freezes the island
// permanently (survives `:e`). So this field is NEVER mapped: it drops on any
// doc change and the next push rebuilds it. Folds are rare and big, so a
// one-cycle drop on edit is unnoticeable, unlike conceal.
//
// Both are defined before nvimCursorField so cursorDeco reads the current sets.
const VISUAL_MARK = Decoration.mark({ class: "cm-nvim-visual" });
// Structural styling (heading size, code fence, blockquote): Decoration.line
// per affected line, not a multi-line replace. Point decorations at line.from,
// so they map trivially and carry none of the fold class of risk (see the
// "Decoration safety rules" note in docs/markdown-island.md). One instance per
// class, reused, so pushes that touch the same lines diff to a no-op.
const lineDecoBy = new Map();
function lineDeco(cls) {
  let d = lineDecoBy.get(cls);
  if (!d) {
    d = Decoration.line({ attributes: { class: cls } });
    lineDecoBy.set(cls, d);
  }
  return d;
}
const setIslandDecor = StateEffect.define();
const islandDecorField = StateField.define({
  create: () => Decoration.none,
  update(v, tr) {
    if (tr.docChanged) {
      try {
        v = v.map(tr.changes);
      } catch (e) {
        jlog("island decor map failed, dropping: " + e);
        v = Decoration.none;
      }
    }
    for (const e of tr.effects) if (e.is(setIslandDecor)) v = e.value;
    return v;
  },
  provide: (f) => EditorView.decorations.from(f),
});
const setIslandFolds = StateEffect.define();
const islandFoldField = StateField.define({
  create: () => Decoration.none,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setIslandFolds)) v = e.value;
    if (tr.docChanged && v.size) {
      // Map per position, never RangeSet.map: mapping a multi-line replace set
      // that way corrupted it into a state where every later map threw and the
      // island froze for good. Here each fold's ends are mapped independently
      // (mapPos never throws); a fold whose content was entirely deleted
      // collapses to zero length and is dropped. Keeps folds collapsed through
      // an edit so the layout does not jump on every keystroke.
      const kept = [];
      v.between(0, tr.startState.doc.length, (from, to, deco) => {
        const nf = tr.changes.mapPos(from, 1);
        const nt = tr.changes.mapPos(to, -1);
        if (nf < nt) kept.push(deco.range(nf, nt));
      });
      try {
        v = Decoration.set(kept, true);
      } catch (e) {
        jlog("island fold remap failed: " + e);
        v = Decoration.none;
      }
    }
    return v;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function cursorDeco(state, pos) {
  if (!pos) return Decoration.none;
  const doc = state.doc;
  const line = doc.line(Math.min(pos.row + 1, doc.lines));
  let from = Math.min(line.from + pos.col, line.to);

  // A closed fold replaces its whole range with the FoldWidget; a cursor
  // decoration placed inside would be swallowed and the cursor vanishes. Snap
  // it to the fold's left edge and render it there with side -1 (before the
  // replaced content).
  let onFold = false;
  const folds = state.field(islandFoldField, false);
  if (folds) {
    folds.between(from, from, (dfrom, dto) => {
      if (dfrom < dto) {
        from = dfrom;
        onFold = true;
        return false;
      }
    });
  }
  if (onFold) {
    return Decoration.set([
      Decoration.widget({ widget: new BlockCursor(), side: -1 }).range(from),
    ]);
  }
  if (pos.mode[0] === "i") {
    return Decoration.set([
      Decoration.widget({ widget: new BarCursor(), side: 1 }).range(from),
    ]);
  }
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
    // recompute every transaction: a fold added by setIslandDecor (defined
    // above, so current here) changes where the cursor must render.
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
    this.gutterComp = new Compartment(); // number column, mirrored from Neovim
    this.gutter = null; // last { number, relativenumber, numberwidth, ... }
    this._gutterRaf = 0;
    this.decor = null; // last md_decor payload (parsed)
    this.el = document.createElement("div");
    this.el.className = "island";
    this.el.hidden = true;
    viewportEl.append(this.el);
    this.compose = null; // { text, sel } snapshot while an IME composition runs
    this.view = new EditorView({
      doc: "",
      // No basicSetup. Neovim is the sole editor for a focused island, so CM
      // carries no keymap and no self-editing extensions (defaultKeymap /
      // historyKeymap / history / closeBrackets / autocompletion /
      // indentOnInput). Every key routes through the global keydown handler to
      // nvim_input; CM only renders the buffer and reconciles the out-of-band
      // DOM mutations (Grammarly, autocorrect, IME commit) back via onUpdate.
      // Markdown styling is deliberately absent until the display bridge
      // mirrors Neovim's own highlights. The caret in every mode is our
      // nvimCursorField decoration (bar, block, or EOL block); CM's native
      // caret is hidden and drawSelection is unused, so no CM-derived caret
      // can lag a keystroke behind the buffer echo.
      extensions: [
        markdown(),
        EditorView.lineWrapping,
        nvimCursorField,
        islandDecorField,
        islandFoldField,
        this.gutterComp.of([]),
        this.editableComp.of(EDITABLE_ON),
        EditorView.updateListener.of((u) => this.onUpdate(u)),
        EditorView.updateListener.of((u) => {
          // relativenumber: repaint the number column when the cursor line
          // moves, even on a transaction that changed nothing else.
          if (!this.gutter?.relativenumber) return;
          const a = u.startState.field(nvimCursorField, false)?.pos?.row;
          const b = u.state.field(nvimCursorField, false)?.pos?.row;
          if (a !== b) this.scheduleGutterRefresh();
        }),
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
  // Mirror Neovim's number column. `o` is the window's gutter options; only
  // `number` / `relativenumber` / `numberwidth` are drawn for now (signcolumn
  // and foldcolumn ride along in `o` for a later pass).
  setGutter(o) {
    this.gutter = o;
    this.applyGutter();
  }
  applyGutter() {
    const g = this.gutter;
    const ext = [];
    if (g && (g.number || g.relativenumber)) {
      this.el.style.setProperty(
        "--gutter-numw",
        String(Math.max(g.numberwidth || 4, 2)),
      );
      ext.push(
        lineNumbers({
          formatNumber: (n, state) => {
            if (!g.relativenumber) return String(n);
            const cur = state.field(nvimCursorField, false)?.pos;
            const curLine = cur ? Math.min(cur.row + 1, state.doc.lines) : null;
            if (curLine == null) return String(n);
            if (n === curLine) return g.number ? String(n) : "0";
            return String(Math.abs(n - curLine));
          },
        }),
      );
    } else {
      this.el.style.removeProperty("--gutter-numw");
    }
    this.view.dispatch({ effects: this.gutterComp.reconfigure(ext) });
  }
  scheduleGutterRefresh() {
    if (this._gutterRaf) return;
    this._gutterRaf = requestAnimationFrame(() => {
      this._gutterRaf = 0;
      this.applyGutter();
    });
  }
  // Display bridge (runtime/md_decor.lua). `d` is the parsed payload:
  // { first, last, conceal: [[row, sByte, eByte, text], ...],
  //   visual: [[row, sByte, eByte], ...], folds: [[sRow, eRow, text], ...],
  //   hl: { runs: [[row, sByte, eByte, group], ...], defs: {...},
  //     codespans: [[row, sByte, eByte], ...],
  //     virt: [[row, col, hideBytes, [[text, group], ...]], ...] },
  //   heads: [[sRow, eRow, level], ...], codes: [[sRow, eRow], ...],
  //   quotes: [[sRow, eRow], ...], visual_hl } in absolute buffer coordinates.
  //   Decorations are view-only, so nothing here reaches nvim_edit. `hl.defs` is merged globally by the
  //   listener; this only consumes `hl.runs` / `hl.virt`.
  setDecor(d) {
    this.decor = d;
    if (d?.visual_hl) this.el.style.setProperty("--visual-bg", d.visual_hl);
    else this.el.style.removeProperty("--visual-bg");
    this.applyDecor();
  }
  // byte range [sc, ec) on buffer row `row` -> CM [from, to), or null.
  _range(row, sc, ec) {
    const doc = this.view.state.doc;
    if (row < 0 || row >= doc.lines) return null;
    const line = doc.line(row + 1);
    const from = line.from + byteToCol(line.text, sc);
    const to = Math.min(line.from + byteToCol(line.text, ec), line.to);
    return to > from ? { from, to } : null;
  }
  applyDecor() {
    const d = this.decor;
    const doc = this.view.state.doc;

    // folds first: a closed fold is one inline replace over the whole range.
    // Anything inside it (conceal, visual, hl) is dropped, a replace may not
    // nest. End at the last folded line's `.to` (before its newline) so the
    // range stays within the buffer and the trailing newline keeps the next
    // line flowing normally.
    const foldSpans = [];
    for (const [sr, er, text] of d?.folds ?? []) {
      if (sr < 0 || sr >= doc.lines) continue;
      const from = doc.line(sr + 1).from;
      const to = doc.line(Math.min(er + 1, doc.lines)).to;
      if (to > from) foldSpans.push({ from, to, text });
    }
    const inFold = (a, b) =>
      foldSpans.some((f) => a < f.to && b > f.from);

    // conceal: inline replace decorations, which may not overlap each other.
    // Neovim's own conceal, our heading-marker icon, and our blockquote-marker
    // hiding all go through one dedup pass. Ours are pushed first so they win
    // a tie (stable sort) if Neovim also happens to conceal the same run.
    // Both skip guardRow, the same row real conceal is guarded against server
    // side (md_decor.lua's conceal_guard_row): -1 when 'concealcursor' names
    // the current mode, meaning nothing is guarded and even the cursor line
    // conceals normally, otherwise the cursor's row. Neither marker hiding is
    // real conceal, so without reading this they would always reveal the
    // cursor line regardless of concealcursor, ignoring the option entirely.
    const guardRow = d?.guard_row ?? -1;
    const spans = [];
    for (const [sr, , level] of d?.heads ?? []) {
      if (sr < 0 || sr >= doc.lines || sr === guardRow) continue;
      const line = doc.line(sr + 1);
      const m = /^(#{1,6})(\s+)/.exec(line.text); // setext headings have no marker on this line
      if (!m) continue;
      const from = line.from;
      const to = from + m[0].length;
      if (inFold(from, to)) continue;
      const lvl = Math.min(Math.max(level, 1), 6);
      spans.push({
        from,
        to,
        deco:
          lvl <= 3
            ? Decoration.replace({ widget: new HeadingIconWidget(lvl) })
            : CONCEAL_HIDE,
      });
    }
    for (const [sr, er] of d?.quotes ?? []) {
      const s = Math.max(sr, 0);
      const e = Math.min(er, doc.lines - 1);
      for (let r = s; r <= e; r++) {
        if (r === guardRow) continue;
        const line = doc.line(r + 1);
        const m = /^(?:[ \t]*>[ \t]?)+/.exec(line.text);
        if (!m || !m[0]) continue;
        const from = line.from;
        const to = from + m[0].length;
        if (inFold(from, to)) continue;
        spans.push({ from, to, deco: CONCEAL_HIDE });
      }
    }
    // overlay virt_text (hop.nvim's jump letters, etc): pushed ahead of plain
    // conceal so an interactive overlay wins a tie over Neovim's own conceal.
    for (const [row, col, hide, segs] of d?.hl?.virt ?? []) {
      const r = this._range(row, col, col + hide);
      if (r && !inFold(r.from, r.to))
        spans.push({ ...r, deco: Decoration.replace({ widget: new OverlayWidget(segs) }) });
    }
    for (const [row, sc, ec, text] of d?.conceal ?? []) {
      const r = this._range(row, sc, ec);
      if (r && !inFold(r.from, r.to))
        spans.push({
          ...r,
          deco: text ? Decoration.replace({ widget: new ConcealWidget(text) }) : CONCEAL_HIDE,
        });
    }
    spans.sort((a, b) => a.from - b.from || a.to - b.to);
    const ranges = [];
    let end = -1;
    for (const s of spans) {
      if (s.from < end) continue; // drop an overlap (two sources, same run)
      end = s.to;
      ranges.push(s.deco.range(s.from, s.to));
    }
    // inline `code`: monospace, no Neovim highlight attribute carries font.
    for (const [row, sc, ec] of d?.hl?.codespans ?? []) {
      const r = this._range(row, sc, ec);
      if (r && !inFold(r.from, r.to))
        ranges.push(Decoration.mark({ class: "cm-inline-code" }).range(r.from, r.to));
    }
    // highlights: one mark per treesitter capture / hl_group extmark run. They
    // overlap freely; CM nests the spans and CSS resolves, like a browser.
    for (const [row, sc, ec, group] of d?.hl?.runs ?? []) {
      const r = this._range(row, sc, ec);
      if (r && !inFold(r.from, r.to)) {
        ranges.push(Decoration.mark({ class: hlClass(group) }).range(r.from, r.to));
      }
    }
    // visual/select range: a background mark, may overlap anything.
    for (const [row, sc, ec] of d?.visual ?? []) {
      const r = this._range(row, sc, ec);
      if (r && !inFold(r.from, r.to)) ranges.push(VISUAL_MARK.range(r.from, r.to));
    }
    // structure: heading size / code fence / blockquote, one Decoration.line
    // per affected line (see lineDeco above for why not a multi-line replace).
    const addLines = (sr, er, cls) => {
      const s = Math.max(sr, 0);
      const e = Math.min(er, doc.lines - 1);
      const deco = lineDeco(cls);
      for (let r = s; r <= e; r++) {
        const lf = doc.line(r + 1).from;
        if (!inFold(lf, lf + 1)) ranges.push(deco.range(lf));
      }
    };
    for (const [sr, er, level] of d?.heads ?? [])
      addLines(sr, er, `cm-h${Math.min(Math.max(level, 1), 6)}`);
    for (const [sr, er] of d?.codes ?? []) addLines(sr, er, "cm-code-block");
    for (const [sr, er] of d?.quotes ?? []) addLines(sr, er, "cm-blockquote");
    // folds go in their own never-mapped field (see islandFoldField).
    const foldSet = Decoration.set(
      foldSpans.map((f) =>
        Decoration.replace({ widget: new FoldWidget(f.text) }).range(f.from, f.to),
      ),
    );

    const st = this.view.state;
    const noConcealChange =
      !ranges.length && !st.field(islandDecorField).size;
    const noFoldChange = !foldSpans.length && !st.field(islandFoldField).size;
    if (noConcealChange && noFoldChange) return;

    const effects = [];
    if (!noConcealChange) {
      try {
        effects.push(setIslandDecor.of(Decoration.set(ranges, true)));
      } catch (e) {
        jlog("island decor build failed: " + e);
      }
    }
    if (!noFoldChange) effects.push(setIslandFolds.of(foldSet));
    if (effects.length) {
      this.view.dispatch({ effects });
      // WKWebView will not composite a freshly updated absolutely-positioned
      // subtree until an unrelated event (scroll/resize) nudges it; the grid
      // renderer hits the same thing (see forceRepaint's other call site).
      // Usually masked because typing/scrolling keeps the compositor busy,
      // but a decoration that arrives after the webview has gone idle (hop.nvim:
      // type the search string, hit Enter, the hint letters push lands after
      // that, nothing else touches the page) can sit applied-but-unpainted
      // until something else forces a reflow, e.g. opening devtools.
      // forceRepaint toggles display:none, which would blur .cm-content (an
      // island descendant) if it currently holds focus; restore it right after
      // so the toggle costs nothing even mid insert-mode typing or IME.
      const hadFocus = this.view.hasFocus;
      forceRepaint(this.el);
      if (hadFocus) this.view.focus();
    }
  }
  destroy() {
    if (this._gutterRaf) cancelAnimationFrame(this._gutterRaf);
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
    // `nvim_buf_attach` reports at line granularity, so the block above replaces
    // whole lines even for a one-character keystroke. Shrink to the minimal
    // edit (common prefix + suffix removed) so decorations outside the actual
    // change map through untouched and do not flash / reflow the line.
    const cur = doc.sliceString(from, to);
    let p = 0;
    const mp = Math.min(cur.length, insert.length);
    while (p < mp && cur.charCodeAt(p) === insert.charCodeAt(p)) p++;
    let s = 0;
    const ms = Math.min(cur.length - p, insert.length - p);
    while (
      s < ms &&
      cur.charCodeAt(cur.length - 1 - s) === insert.charCodeAt(insert.length - 1 - s)
    )
      s++;
    from += p;
    to -= s;
    insert = insert.slice(p, insert.length - s);
    try {
      if (from !== to || insert) this.tx({ changes: { from, to, insert } });
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
    // clear decorations before the full-doc replace: if a stale set is what is
    // making dispatches throw, mapping it through this huge change would keep
    // the island wedged even across `:e` / a forced re-attach.
    this.view.dispatch({
      effects: [
        setIslandDecor.of(Decoration.none),
        setIslandFolds.of(Decoration.none),
      ],
    });
    this.tx({
      changes: { from: 0, to: this.view.state.doc.length, insert: m.lines.join("\n") },
    });
    this.applyCursor(m.row, m.col, m.mode);
  }
  scrollTo(topline, botline, linecount) {
    const doc = this.view.state.doc;
    // Neovim scrolled for a monospace window `p.h` rows tall, but our box is
    // that many *monospace cells* tall and CM lines are taller, so it fits
    // fewer lines. When Neovim is already showing the end of the buffer,
    // pinning `topline` to the top clips the trailing lines with no way to
    // reach them (Neovim will not scroll further). Sit the last line on the
    // box bottom instead and show as many trailing lines as fit.
    if (linecount != null && botline != null && botline >= linecount) {
      this.view.dispatch({
        effects: EditorView.scrollIntoView(doc.length, { y: "end" }),
        annotations: fromNvim.of(true),
      });
      return;
    }
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
// Coalesce redraw batches to one paint per animation frame. Neovim can flush
// faster than the display refreshes (held `j`, `:%s`, a big paste); painting
// every flush wastes DOM work and a forced reflow each time. Ops keep their
// arrival order, so a later frame's cursor / colour / layout op still wins.
let pendingOps = [];
let rafScheduled = 0;
function applyGridBatch(ops) {
  for (let i = 0; i < ops.length; i++) pendingOps.push(ops[i]);
  if (!rafScheduled) rafScheduled = requestAnimationFrame(flushGridOps);
}
function flushGridOps() {
  rafScheduled = 0;
  const ops = pendingOps;
  pendingOps = [];
  renderGridOps(ops);
}

function renderGridOps(ops) {
  let dirty = new Set();
  let layoutDirty = false;
  for (const o of ops) {
    switch (o.op) {
      case "resize": {
        gw(o.grid).resize(o.w, o.h);
        dirty.add(o.grid);
        // A float can shrink or grow via grid_resize alone, with no fresh
        // win_float_pos. Keep the placed element's size in step or its old
        // height lingers as a blank band below the real rows.
        const wp = winPos.get(o.grid);
        if (wp && (wp.w !== o.w || wp.h !== o.h)) {
          wp.w = o.w;
          wp.h = o.h;
          layoutDirty = true;
        }
        break;
      }
      case "clear":
        gw(o.grid).clear();
        dirty.add(o.grid);
        break;
      case "destroy": {
        const g = grids.get(o.grid);
        if (g) g.el.remove();
        grids.delete(o.grid);
        winPos.delete(o.grid);
        const goneWin = gridToWin.get(o.grid);
        gridToWin.delete(o.grid);
        // window ids are reused; drop its stale preview flag
        if (goneWin != null && ![...gridToWin.values()].includes(goneWin))
          previewWins.delete(goneWin);
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
          const next = islandForGrid(o.grid);
          // focus left an island: drop its now-stale block cursor decoration
          if (prev && prev !== next) prev.clearCursor();
          // (re)gained an island's grid: replay the last known buffer
          // position immediately rather than waiting for a fresh gnv_cursor
          // event, which may not come if Neovim sees nothing further changed
          if (next && next !== prev && lastCursorPayload)
            next.applyCursor(
              lastCursorPayload.row,
              lastCursorPayload.col,
              lastCursorPayload.mode,
            );
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
          // Neovim special-cases the message / cmdline grid above every float;
          // a big zindex reproduces that. Without it a completion popup that
          // sits directly over the cmdline row (blink.cmp, nvim-cmp, wild pum)
          // paints its blank tail over the command line text.
          zindex: 1_000_000,
        });
        layoutDirty = true;
        break;
      }
      case "viewport": {
        const isl = islandForGrid(o.grid);
        if (isl) {
          isl.scrollTo(o.topline, o.botline, o.linecount);
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
        // every cell's colour may have changed: rebuild all rows of every grid
        for (const g of grids.values()) g.fullDirty = true;
        dirty = new Set(grids.keys());
        // island highlight groups are stale too; md_decor.lua re-resolves and
        // re-pushes on ColorScheme, drop what we have so the merge takes.
        hlDefs.clear();
        if (hlStyleEl) hlStyleEl.textContent = "";
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
  for (const [id, g] of grids)
    if (!islandGridIds.has(id)) {
      g.fullDirty = true; // stale WKWebView surface: force a full row rebuild
      g.repaint();
    }
  for (const isl of islands.values()) isl.view.requestMeasure();
  layout();
  placeGridCursor();
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------
const MIN_PAD_X = 4; // minimum left/right breathing room, px
// Fit an integer cell grid in the window and letterbox it: the sub-cell
// horizontal remainder is split evenly so left and right margins match.
// originX is the left margin; every grid is placed at scol*cellW + originX.
function screenMetrics() {
  const el = document.documentElement;
  const availW = el.clientWidth;
  const availH = el.clientHeight;
  const cols = Math.max(20, Math.floor((availW - 2 * MIN_PAD_X) / cellW));
  const rows = Math.max(4, Math.floor(availH / cellH));
  const padX = Math.max(MIN_PAD_X, Math.round((availW - cols * cellW) / 2));
  return { cols, rows, padX };
}
function applyScreen(m) {
  originX = m.padX;
  // Clip the viewport to Neovim's exact screen height. The window is rarely an
  // integer number of cells tall; without this the sub-cell remainder at the
  // bottom shows a sliver of whatever grid 3 (messages) last held below the row
  // Neovim considers off screen (a stale line after dismissing a multi-line
  // :echo). The leftover strip doubles as a small bottom margin.
  viewportEl.style.bottom = "auto";
  viewportEl.style.height = m.rows * cellH + "px";
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
    livePreviewDefault = cfg?.markdown?.live_preview_default ?? true;
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
      // the island that owns the focused grid, if any. Cache it regardless, so
      // a grid_cursor_goto that hands the island its grid back *after* this
      // event can replay it (see lastCursorPayload).
      lastCursorPayload = e.payload;
      const isl = islandForGrid(cursorGrid);
      if (isl) isl.applyCursor(e.payload.row, e.payload.col, e.payload.mode);
    }),
    listen(ev("cmdline"), () => {}),
    listen(ev("cmdline_hide"), () => {}),
    listen(ev("focus"), () => repaintNow()),
    listen(ev("guiopt"), (e) => applyGuiOpt(e.payload.name, e.payload.value)),
    listen(ev("md_preview"), (e) => {
      const { win, state } = e.payload;
      if (state === -1) previewWins.delete(win);
      else previewWins.set(win, state === 1);
      reconcileIslands();
    }),
    listen(ev("win_gutter"), (e) => {
      winGutter.set(e.payload.win, e.payload);
      islands.get(e.payload.win)?.setGutter(e.payload);
    }),
    listen(ev("md_decor"), (e) => {
      const d = JSON.parse(e.payload.json);
      if (d.hl?.defs) mergeHlDefs(d.hl.defs);
      const isl = islands.get(e.payload.win);
      if (isl) isl.setDecor(d);
    }),
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

  // winft events fired before we were listening; replay them (with the
  // per-window live-preview flag). reconcileIslands() then mounts an island on
  // every previewed markdown window.
  try {
    for (const [win, buf, ft, mdp] of await invoke("nvim_winfts")) {
      winFt.set(win, ft || "");
      if (buf != null) winBuf.set(win, buf);
      if (mdp === 0 || mdp === 1) previewWins.set(win, mdp === 1);
    }
    reconcileIslands();
    jlog(`winfts replayed: ${JSON.stringify([...winFt])}`);
  } catch (e) {
    jlog("winfts failed: " + e);
  }

  // gutter-option feed (md_preview.lua) also fires before we listen; pull it.
  try {
    for (const [
      win,
      number,
      relativenumber,
      numberwidth,
      signcolumn,
      foldcolumn,
    ] of await invoke("nvim_wingutters")) {
      const g = { win, number, relativenumber, numberwidth, signcolumn, foldcolumn };
      winGutter.set(win, g);
      islands.get(win)?.setGutter(g);
    }
  } catch (e) {
    jlog("wingutters failed: " + e);
  }

  // display-bridge payloads also fire before we listen; nudge a re-push.
  invoke("nvim_md_decor").catch((e) => jlog("md_decor failed: " + e));

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
  // Observe the document element, not #viewport: applyScreen resizes #viewport
  // itself, which would feed back into the observer.
  new ResizeObserver(() => pushSize()).observe(document.documentElement);
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
