// Spike: ext_multigrid grid renderer for non-markdown windows, CodeMirror
// island for the markdown window, one nvim driving both.

import { EditorView, basicSetup } from "codemirror";
import { Decoration, WidgetType } from "@codemirror/view";
import { Annotation, StateEffect, StateField } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const viewportEl = document.getElementById("viewport");
const te = new TextEncoder();
const byteLen = (s) => te.encode(s).length;

// ---------------------------------------------------------------------------
// cell metrics (monospace grid)
// ---------------------------------------------------------------------------
let cellW = 8.4;
let cellH = 17;
function measureCell() {
  const probe = document.createElement("div");
  probe.className = "grid";
  probe.style.cssText = "position:absolute;visibility:hidden;left:-9999px";
  probe.textContent = "M".repeat(50);
  viewportEl.append(probe);
  const r = probe.getBoundingClientRect();
  cellW = r.width / 50;
  cellH = probe.offsetHeight || 17;
  probe.remove();
}

// ---------------------------------------------------------------------------
// highlight table
// ---------------------------------------------------------------------------
const hlAttrs = new Map(); // id -> {fg,bg,bold,italic,underline,reverse}
let defColors = { fg: "#e0e0ea", bg: "#14141b", sp: "#ff5555" };
const hex = (n) =>
  n == null || n < 0 ? null : "#" + n.toString(16).padStart(6, "0");

function hlCss(id) {
  const a = hlAttrs.get(id) || {};
  let fg = hex(a.foreground) ?? defColors.fg;
  let bg = hex(a.background) ?? null;
  if (a.reverse) {
    const t = fg;
    fg = bg ?? defColors.bg;
    bg = t;
  }
  let s = `color:${fg};`;
  if (bg) s += `background:${bg};`;
  if (a.bold) s += "font-weight:700;";
  if (a.italic) s += "font-style:italic;";
  if (a.underline || a.undercurl) s += "text-decoration:underline;";
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
    this.cols = w;
    this.rows = h;
    this.cells = Array.from({ length: h }, () =>
      Array.from({ length: w }, () => [" ", 0]),
    );
  }
  clear() {
    for (const row of this.cells) row.fill(0).forEach; // noop guard
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
        if (hl !== runHl) {
          flush();
          runHl = hl;
        }
        run += ch === "" ? " " : ch;
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
let islandGrid = null;
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

function recomputeIsland() {
  let found = null;
  for (const [gid, wid] of gridToWin) {
    if ((winFt.get(wid) || "").includes("markdown")) found = gid;
  }
  if (found !== islandGrid) {
    islandGrid = found;
    layout();
  }
}

function place(el, p) {
  el.style.left = `${p.scol * cellW}px`;
  el.style.top = `${p.srow * cellH}px`;
  el.style.width = `${p.w * cellW}px`;
  el.style.height = `${p.h * cellH}px`;
  if (p.zindex != null) el.style.zIndex = p.zindex;
}

function layout() {
  for (const [gid, g] of grids) {
    if (gid === 1) {
      // outer grid: statuslines, separators, tabline, fills the viewport
      g.el.style.cssText =
        "position:absolute;left:0;top:0;right:0;bottom:0;z-index:0";
      g.el.hidden = false;
      continue;
    }
    const p = winPos.get(gid);
    if (gid === islandGrid) {
      g.el.hidden = true;
      if (p) {
        place(islandEl, p);
        islandEl.style.zIndex = 5;
        islandEl.hidden = false;
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
  if (islandGrid == null) islandEl.hidden = true;
}

// ---------------------------------------------------------------------------
// the markdown island: CodeMirror + buffer-sync
// ---------------------------------------------------------------------------
const islandEl = document.createElement("div");
islandEl.id = "island";
islandEl.hidden = true;
viewportEl.append(islandEl);

// one block cursor for whichever grid window has focus
const gridCursorEl = document.createElement("div");
gridCursorEl.id = "grid-cursor";
gridCursorEl.hidden = true;
viewportEl.append(gridCursorEl);
let cursorGrid = 1;
function placeGridCursor() {
  const g = grids.get(cursorGrid);
  const p = winPos.get(cursorGrid);
  if (!g || !g.cursor || !p || cursorGrid === islandGrid) {
    gridCursorEl.hidden = true;
    return;
  }
  gridCursorEl.hidden = false;
  gridCursorEl.style.left = `${(p.scol + g.cursor.col) * cellW}px`;
  gridCursorEl.style.top = `${(p.srow + g.cursor.row) * cellH}px`;
  gridCursorEl.style.width = `${cellW}px`;
  gridCursorEl.style.height = `${cellH}px`;
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

function forwardExternalEdit(u) {
  if (!u.docChanged) return;
  if (!u.transactions.some((tr) => !tr.annotation(fromNvim))) return;
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
  invoke("nvim_edit", { regions });
}

const view = new EditorView({
  doc: "",
  extensions: [
    basicSetup,
    markdown(),
    EditorView.lineWrapping,
    nvimCursorField,
    EditorView.updateListener.of(forwardExternalEdit),
    EditorView.domEventHandlers({
      mousedown(ev, v) {
        const pos = v.posAtCoords({ x: ev.clientX, y: ev.clientY });
        if (pos == null) return false;
        const line = v.state.doc.lineAt(pos);
        invoke("nvim_input", { keys: "<LeftMouse>" }).catch(() => {});
        invoke("nvim_cursor_set", {
          row: line.number - 1,
          col: byteLen(line.text.slice(0, pos - line.from)),
        });
        return false;
      },
    }),
  ],
  parent: islandEl,
});
const nvimTx = (spec) =>
  view.dispatch({ ...spec, annotations: fromNvim.of(true) });

function applyBufLines(a, lastline, linedata) {
  const doc = view.state.doc;
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
    nvimTx({ changes: { from, to, insert } });
  } catch (err) {
    console.warn("[applyBufLines] resync", err);
    invoke("nvim_resync").then(applyReset).catch(() => {});
  }
}
function applyCursor(row, col, mode) {
  modeName_ = mode;
  const doc = view.state.doc;
  const line = doc.line(Math.min(row + 1, doc.lines));
  const pos = Math.min(line.from + col, line.to);
  nvimTx({ selection: { anchor: pos }, effects: setNvimCursor.of({ row, col, mode }) });
  islandEl.dataset.mode = mode;
}
function applyReset(m) {
  nvimTx({
    changes: { from: 0, to: view.state.doc.length, insert: m.lines.join("\n") },
  });
  applyCursor(m.row, m.col, m.mode);
}
function islandScrollTo(topline) {
  const doc = view.state.doc;
  const l = Math.min(Math.max(topline, 0), doc.lines - 1);
  view.dispatch({
    effects: EditorView.scrollIntoView(doc.line(l + 1).from, { y: "start" }),
    annotations: fromNvim.of(true),
  });
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
        cursorGrid = o.grid;
        break;
      case "win_pos":
        winPos.set(o.grid, { srow: o.srow, scol: o.scol, w: o.w, h: o.h });
        if (o.win != null) gridToWin.set(o.grid, o.win);
        layoutDirty = true;
        break;
      case "win_float":
        winPos.set(o.grid, {
          srow: Math.round(o.arow ?? 0),
          scol: Math.round(o.acol ?? 0),
          w: (grids.get(o.grid) || {}).cols || 20,
          h: (grids.get(o.grid) || {}).rows || 5,
          float: true,
          zindex: o.zindex ?? 50,
        });
        if (o.win != null) gridToWin.set(o.grid, o.win);
        layoutDirty = true;
        break;
      case "win_hide":
      case "win_close": {
        const g = grids.get(o.grid);
        if (g) g.el.hidden = true;
        winPos.delete(o.grid);
        layoutDirty = true;
        break;
      }
      case "msg_pos":
        winPos.set(o.grid, {
          srow: o.row,
          scol: 0,
          w: (grids.get(1) || {}).cols || 200,
          h: (grids.get(o.grid) || {}).rows || 1,
          zindex: 40,
        });
        layoutDirty = true;
        break;
      case "viewport":
        if (o.grid === islandGrid) islandScrollTo(o.topline);
        break;
      case "colors":
        defColors = {
          fg: hex(o.fg) ?? defColors.fg,
          bg: hex(o.bg) ?? defColors.bg,
          sp: hex(o.sp) ?? defColors.sp,
        };
        document.body.style.background = defColors.bg;
        document.body.style.color = defColors.fg;
        dirty = new Set(grids.keys());
        break;
      case "hl":
        hlAttrs.set(o.id, o.attr || {});
        break;
      case "mode":
        modeName_ = o.name || modeName_;
        break;
      case "flush":
        break;
    }
  }
  if (layoutDirty) recomputeIsland(), layout();
  for (const id of dirty) {
    const g = grids.get(id);
    if (g && id !== islandGrid) g.repaint();
  }
  placeGridCursor();
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------
listen("gnv://grid", (e) => applyGridBatch(e.payload));
listen("gnv://winft", (e) => {
  const { win, ft } = e.payload;
  winFt.set(win, ft || "");
  recomputeIsland();
});
listen("gnv://reset", (e) => applyReset(e.payload));
listen("gnv://lines", (e) =>
  applyBufLines(e.payload.firstline, e.payload.lastline, e.payload.linedata),
);
listen("gnv://cursor", (e) => {
  if (islandGrid != null) applyCursor(e.payload.row, e.payload.col, e.payload.mode);
});
listen("gnv://cmdline", () => {});
listen("gnv://cmdline_hide", () => {});

function pushSize() {
  const r = viewportEl.getBoundingClientRect();
  const cols = Math.max(20, Math.floor(r.width / cellW));
  const rows = Math.max(4, Math.floor(r.height / cellH));
  invoke("nvim_resize", { cols, rows }).catch(() => {});
}

measureCell();
new ResizeObserver(() => pushSize()).observe(viewportEl);

(async function boot() {
  for (let i = 0; i < 100; i++) {
    try {
      pushSize();
      applyReset(await invoke("nvim_resync"));
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
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
};
function keyToNvim(e) {
  if (e.metaKey) return null;
  if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead"].includes(e.key))
    return null;
  let key = NAMED[e.key];
  const named = key !== undefined;
  if (!named) {
    if (e.key.length !== 1) return null;
    key = e.key === "<" ? "lt" : e.key;
  }
  const mods = (e.ctrlKey ? "C-" : "") + (e.altKey ? "M-" : "");
  if (mods || named || key === "lt") return `<${mods}${key}>`;
  return key;
}
addEventListener("keydown", (e) => {
  const keys = keyToNvim(e);
  if (keys === null) return;
  e.preventDefault();
  invoke("nvim_input", { keys });
});
