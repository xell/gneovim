// gneovim frontend: an ext_multigrid grid renderer for non-markdown windows,
// a CodeMirror island for each markdown window, one nvim driving both.

import "../styles.css";
import { EditorView, Decoration } from "@codemirror/view";
import { Annotation, StateEffect, Compartment } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { convertFileSrc, invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { NvimClient } from "./nvim-client.js";
import { SessionModel } from "./session-model.js";
import { GridView } from "./grid-view.js";
import { RedrawScheduler } from "./redraw-scheduler.js";
import { GridCoordinator } from "./grid-coordinator.js";
import { IslandManager } from "./island-manager.js";
import {
  HighlightRegistry,
  colorLuma,
  rgbHex,
} from "./highlight-registry.js";
import { byteLen, byteToCol } from "./pure/text-geometry.js";
import { parseGuifont } from "./pure/guifont.js";
import {
  keyToNvim as encodeKeyToNvim,
  normalModePunctuation,
} from "./pure/keymap.js";
import { screenMetrics as calculateScreenMetrics } from "./pure/layout.js";
import { bufferLineEdit } from "./pure/buffer-line-edit.js";
import { semanticWordTarget as findSemanticWordTarget } from "./pure/semantic-word.js";
import { CursorScroller } from "./cursor-scroller.js";
import { GutterController } from "./gutter-controller.js";
import { IslandInputQueue } from "./island-input-queue.js";
import { IslandInputController } from "./island-input-controller.js";
import { createIslandDecorationState } from "./island-decoration-state.js";
import { createMarkdownPresentation } from "./markdown-presentation.js";
import { IslandDisplayDecorations } from "./island-display-decorations.js";

// this webview's window label; event names are per-window (gnv://<label>/<kind>)
// because emit_to() broadcasts to every webview in this app.
const currentWin = getCurrentWebviewWindow();
const winLabel = currentWin.label;
const nvim = new NvimClient({ invoke: tauriInvoke, listen: tauriListen, windowLabel: winLabel });

const viewportEl = document.getElementById("viewport");
const highlights = new HighlightRegistry({ document });

// mirror the webview console into the app log (the webview has no visible one)
const jlog = (m) => nvim.log(m).catch(() => {});
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
const GUI_FONT_DEFAULT = 14;
const GRID_SIZE_FALLBACK = `${GUI_FONT_DEFAULT}px`;
const FONT_ZOOM_STEP = 1;
let guiFontBaseSize = GUI_FONT_DEFAULT;
let guiFontZoom = 0;
const effectiveGuiFontSize = () => Math.max(6, guiFontBaseSize + guiFontZoom);
function applyFontZoom() {
  const size = effectiveGuiFontSize();
  const root = document.documentElement.style;
  root.setProperty("--grid-font-size", `${size}px`);
  root.setProperty("--ui-font-size", `${size}px`);
  for (const island of islands.values()) island.applyFontZoom(size / guiFontBaseSize);
}
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

function applyGuiOptRaw(name, value) {
  const root = document.documentElement.style;
  if (name === "guifont") {
    const f = parseGuifont(value);
    if (f && f.family) {
      const fam = /[^\w-]/.test(f.family) ? `"${f.family}"` : f.family;
      root.setProperty("--grid-font-family", `${fam}, ${GRID_FONT_FALLBACK}`);
    } else root.removeProperty("--grid-font-family");
    guiFontBaseSize = f?.size || GUI_FONT_DEFAULT;
    applyFontZoom();
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
// Push Neovim's Normal colours into CSS custom properties so every surface
// (body, grid backgrounds, islands, cursors) tracks :colorscheme / :set bg.
function applyTheme() {
  const s = document.documentElement.style;
  s.setProperty("--fg", highlights.defaults.fg);
  s.setProperty("--bg", highlights.defaults.bg);
  s.setProperty("--sp", highlights.defaults.sp);
  s.colorScheme = colorLuma(highlights.defaults.bg) < 128 ? "dark" : "light";
}

const grids = new Map(); // gridId -> GridView
const session = new SessionModel();
const islandManager = new IslandManager({
  session,
  nvim,
  createIsland: (win) => new Island(win),
  layout,
  reportError: jlog,
  livePreviewDefault: () => livePreviewDefault,
});
const islands = islandManager.islands; // read-only access for rendering and events
// winId -> bool: markdown-live-preview flag, from runtime/md_preview.lua's
// `w:gnv_md_preview` (gnv://<label>/md_preview events + the winfts replay).
// Absent -> fall back to livePreviewDefault.
// winId -> { number, relativenumber, numberwidth, signcolumn, foldcolumn }, the
// window's gutter options mirrored from Neovim (runtime/md_preview.lua feed +
// the nvim_wingutters replay). Applied to the island's gutter compartment.
let livePreviewDefault = true; // from gnv_config [markdown] live_preview_default

// macOS Accessibility is the only channel an external client like Grammarly
// Desktop has into the webview. Publish the web content only while the cursor
// is in an island whose `:GrammarlyOn` flag (w:gnv_grammarly) is set; grid
// windows, the command line, and command-line windows stay withheld (lib.rs
// webview_accessibility), so Grammarly never attaches there. Sent only on
// change.
let accessibilityHidden = null; // null: not yet sent (a reload keeps native state)
function syncGrammarlyAccessibility() {
  const hidden = !session.accessibilityExposed((win) => islands.has(win));
  if (hidden === accessibilityHidden) return;
  accessibilityHidden = hidden;
  jlog(`grammarly: web content ${hidden ? "hidden from" : "exposed to"} accessibility`);
  nvim
    .setAccessibilityHidden(hidden)
    .catch((e) => jlog("set_accessibility_hidden failed: " + e));
}

function gw(id) {
  let g = grids.get(id);
  if (!g) {
    g = new GridView(id, {
      document,
      highlightCss: (id) => highlights.gridCss(id),
      cellWidth: () => cellW,
    });
    grids.set(id, g);
    viewportEl.append(g.el);
  }
  return g;
}

const islandForGrid = (gid) => islandManager.forGrid(gid);

function place(el, p) {
  el.style.left = `${p.scol * cellW + originX}px`;
  el.style.top = `${floatTopPx(p) ?? p.srow * cellH}px`;
  el.style.width = `${p.w * cellW}px`;
  el.style.height = `${p.h * cellH}px`;
  if (p.zindex != null) el.style.zIndex = p.zindex;
}

// Exact pixel top for a float anchored inside an island (see the "win_float"
// case: srow*cellH assumes every anchor-grid row is one uniform cellH tall,
// which islands actively defeat with heading/code-block reflow). Resolved
// here rather than eagerly when the win_float op arrives: that op lands
// interleaved with a burst of other ops for the same redraw (the popup's own
// grid gets built via a run of "line"/"resize" ops in the same batch, up to
// three win_float updates as it's sized). Reading layout there, mid-batch,
// forces the browser to lay out a subtree that isn't finished being written
// to yet -- verified live as a visible flicker of the word under the popup.
// place() already runs once per batch, after every op in it has landed, so
// resolving it here costs one read instead of interleaving several.
function floatTopPx(p) {
  const fa = p.floatAnchor;
  if (!fa) return null;
  // Two ways a completion/signature-help float reaches here:
  // - window-relative, nvim's own ins-completion pum: agrid is that window's
  //   own grid id, arow already in its row space.
  // - editor-relative, `nvim_open_win{relative='editor'}` (e.g. nvim-cmp):
  //   agrid is 1 (the whole screen) and arow is an absolute screen row, not
  //   any window's row space. Translate it through whichever window's
  //   rectangle it actually falls in -- in practice always the one holding
  //   the cursor, since that's who a completion float is anchored to
  //   regardless of how the plugin opened its window -- by subtracting that
  //   window's own on-screen top row.
  let agrid = fa.agrid;
  let arow = fa.arow;
  if (agrid === 1) {
    const wp = session.positionForGrid(session.cursorGrid);
    if (!wp || arow == null || arow < wp.srow || arow >= wp.srow + wp.h) return null;
    agrid = session.cursorGrid;
    arow = arow - wp.srow;
  }
  const aIsl = islandForGrid(agrid);
  const baseRow = (grids.get(agrid) || {}).cursor?.row;
  const delta = baseRow != null ? Math.round(arow ?? 0) - baseRow : null;
  if (!aIsl || (delta !== 0 && delta !== 1)) return null;
  const head = aIsl.view.state.selection.main.head;
  const coords = aIsl.view.coordsAtPos(head);
  if (!coords) return null;
  const vTop = viewportEl.getBoundingClientRect().top;
  const edge = (delta === 1 ? coords.bottom : coords.top) - vTop;
  return fa.anchorS ? edge - p.h * cellH : edge;
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
    const p = session.positionForGrid(gid);
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
// Last gnv_cursor payload (buffer row/col/mode), kept even while cursorGrid
// points elsewhere. gnv_cursor (the buffer position feed) and grid_cursor_goto
// (which grid owns it) are two independent streams; if a grid_cursor_goto that
// hands the island back its grid arrives *after* the gnv_cursor event for the
// same move (a message/prompt grid can transiently own grid_cursor_goto during
// a blocking getchar(), e.g. easymotion's "Target key:" prompt), the island
// misses the update and its cursor stays hidden until an unrelated move
// re-fires both. Re-applying the cached payload when the island regains its
// grid closes that gap without depending on event arrival order.
let cursorStyleEnabled = false;

// ---------------------------------------------------------------------------
// grid-window IME: a hidden contenteditable at the cursor is the composition
// surface (grid windows are plain divs). Its input / compositionend forward the
// committed text to nvim via nvim_input, which inserts it and moves the cursor.
// ---------------------------------------------------------------------------
let imeComposing = false;
// CmdlineEnter/Changed and CmdlineLeave notifications make command-line input
// another editable grid context. UI mode_change alone cannot identify it:
// Neovim draws the command line on a grid while its mode may still look normal.
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
  if (v && gridTextInputActive())
    nvim.input(v.replace(/</g, "<lt>")).catch((e) => jlog("IME input failed: " + e));
}
imeEl.addEventListener("compositionstart", () => {
  imeComposing = true;
});
imeEl.addEventListener("compositionend", () => {
  imeComposing = false;
  imeFlush(); // discards if we somehow composed outside an editable context
});
imeEl.addEventListener("input", () => {
  if (!imeComposing) imeFlush();
});

function gridInsertActive() {
  return (
    !islandForGrid(session.cursorGrid) &&
    /^(insert|replace)/.test(session.modeName)
  );
}
function gridTextInputActive() {
  return session.cmdlineActive || gridInsertActive();
}
// #ime stays FOCUSED whenever a grid window holds the cursor, in every mode, so
// macOS keeps the user's chosen input source. It is only contenteditable in
// insert/replace mode or while Neovim owns a command line; outside either, a
// focused-but-non-editable element gives the OS IME nothing to compose into, so
// normal-mode keys reach nvim untouched.
function updateImeFocus() {
  if (!session.cmdlineActive && islandForGrid(session.cursorGrid)) {
    if (document.activeElement === imeEl) imeEl.blur();
    return;
  }
  const ro = !gridTextInputActive();
  if (imeEl.readOnly !== ro) imeEl.readOnly = ro;
  if (ro && imeComposing) {
    imeComposing = false; // left insert mid-composition: drop it
    imeEl.value = "";
  }
  if (document.activeElement !== imeEl) imeEl.focus({ preventScroll: true });
}
addEventListener("focus", () => {
  updateImeFocus(); // regain focus after cmd-tab
  nvim.input("<FocusGained>").catch(() => {});
});
addEventListener("blur", () => {
  nvim.input("<FocusLost>").catch(() => {});
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
  const m = cursorStyleEnabled ? session.currentMode : null;
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
  const g = grids.get(session.cursorGrid);
  const p = session.positionForGrid(session.cursorGrid);
  if (!g || !g.cursor || !p || islandForGrid(session.cursorGrid)) {
    gridCursorEl.hidden = true;
    stopBlink();
    return;
  }
  const x = (p.scol + g.cursor.col) * cellW + originX;
  const y = (p.srow + g.cursor.row) * cellH;
  imeEl.style.left = `${x}px`; // anchor the IME candidate window at the cursor
  imeEl.style.top = `${y}px`;
  const m = cursorStyleEnabled ? session.currentMode : null;
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
  const attr = m && m.attr_id != null ? highlights.gridAttributesFor(m.attr_id) : null;
  gridCursorEl.style.background =
    shape === "block" ? "" : (attr && rgbHex(attr.background)) || "var(--fg)";
  startBlink();
}

const fromNvim = Annotation.define();
const islandDecorationState = createIslandDecorationState({
  document,
  log: jlog,
});
const {
  islandDecorField,
  islandFoldField,
  nvimCursorField,
  setIslandDecor,
  setIslandFolds,
  setNvimCursor,
} = islandDecorationState;
// `guard_row` is supplied by md_decor.lua after applying Neovim's
// 'concealcursor' rule. -1 means conceal remains active on the cursor line.
const setTableConcealGuard = StateEffect.define();
// Shared by markdownTableField and markdownImageField: both widgets replace
// real source text with their own DOM, so Search/IncSearch/EasyMotionTarget/
// HopPreview highlights on that text (an ordinary Decoration.mark elsewhere)
// need to be fed to them directly instead. See markdown-presentation.js.
const setInteractiveHighlights = StateEffect.define();
// Same reasoning, for hop.nvim's per-target hint letters: a virt_text overlay
// (Decoration.replace elsewhere) on text hidden behind the table's or the
// image caption's own Decoration.replace has nothing left to replace either.
const setInteractiveOverlays = StateEffect.define();
const setIslandImageBase = StateEffect.define();
const {
  markdownImageField,
  markdownTableField,
} = createMarkdownPresentation({
  document,
  textNodeType: Node.TEXT_NODE,
  highlights,
  convertFileSrc,
  setCursor: setNvimCursor,
  setImageBase: setIslandImageBase,
  setTableConcealGuard,
  setInteractiveHighlights,
  setInteractiveOverlays,
});
// Non-editable content is not focusable on its own; the tabindex keeps it the
// keyboard's target so keydown still reaches the global nvim_input path.
const EDITABLE_ON = EditorView.editable.of(true);
const EDITABLE_OFF = [
  EditorView.editable.of(false),
  EditorView.contentAttributes.of({ tabindex: "0" }),
];

// True when `pos` falls strictly inside a non-zero-width range of `ranges`
// (a RangeSet of Decoration.replace entries). The browser has no native DOM
// position for a byte hidden behind a replace widget (a rendered table, a
// concealed image source line, closed fold body, hidden conceal marker), so
// a position inside one is never something the live DOM selection can be
// trusted to track.
function rangeHidesPos(ranges, pos) {
  let hidden = false;
  ranges.between(pos, pos, (from, to) => {
    if (from <= pos && pos < to) {
      hidden = true;
      return false;
    }
  });
  return hidden;
}

// One CodeMirror instance bound to one markdown window and its buffer.
class Island {
  constructor(winId) {
    this.winId = winId;
    this.bufnr = null;
    this.mode = "n";
    this.fontZoom = 0;
    this.editableComp = new Compartment();
    this.editable = true;
    this._lastViewport = null; // last {topline,botline,linecount} scrollTo saw
    this.scrolloff = 0;
    // The DOM selection normally mirrors this Neovim cursor. External desktop
    // editors may move it through macOS Accessibility before posting their
    // correction keys, so serialize island cursor and key requests.
    this._nvimCursor = null; // { row, col }
    this.inputQueue = new IslandInputQueue({
      client: nvim,
      winId,
      log: jlog,
    });
    this.inputController = new IslandInputController({
      client: nvim,
      inputQueue: this.inputQueue,
      fromNvim,
      getBuffer: () => this.bufnr,
      getCursor: () => this._nvimCursor,
      getMode: () => this.mode,
      isCursorHidden: (cursor) => this.isCursorHidden(cursor),
      log: jlog,
      requestFrame: (callback) => requestAnimationFrame(callback),
      setTimer: (callback, delay) => setTimeout(callback, delay),
      syncSelectionToCursor: () => this.syncSelectionToCursor(),
      tx: (spec) => this.tx(spec),
    });
    this.el = document.createElement("div");
    this.el.className = "island";
    this.el.hidden = true;
    viewportEl.append(this.el);
    this.gutterController = new GutterController({
      element: this.el,
      compartment: new Compartment(),
      cursorField: nvimCursorField,
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (id) => cancelAnimationFrame(id),
    });
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
      //
      // markdown() defaults addKeymap to true, silently installing its own
      // Prec.high Enter/Backspace bindings (insertNewlineContinueMarkup /
      // deleteMarkupBackward) alongside CM's normal keydown handling on
      // contentDOM. Neovim's global keydown listener still also forwards
      // that same key (preventDefault doesn't stop propagation to window),
      // so a list-continuing Enter ran twice: once as CM's own local edit,
      // once as Neovim's formatoptions continuation landing on top of it,
      // producing a duplicated "- " line only in the island. addKeymap:
      // false keeps this the single no-keymap surface the rest of this
      // comment describes.
      extensions: [
        markdown({ addKeymap: false }),
        markdownTableField,
        markdownImageField,
        EditorView.lineWrapping,
        nvimCursorField,
        islandDecorField,
        islandFoldField,
        this.gutterController.extension(),
        this.editableComp.of(EDITABLE_ON),
        EditorView.updateListener.of((u) =>
          this.inputController.onDocumentUpdate(u),
        ),
        EditorView.updateListener.of((u) =>
          this.inputController.onSelectionUpdate(u),
        ),
        EditorView.updateListener.of((u) => this.gutterController.onUpdate(u)),
        EditorView.domEventHandlers({
          mousedown: (ev, v) => this.inputController.onMousedown(ev, v),
          compositionstart: () => this.inputController.onCompositionStart(),
          compositionend: (ev) =>
            this.inputController.onCompositionEnd(ev.data),
          beforeinput: (ev) => this.inputController.onBeforeInput(ev),
        }),
      ],
      parent: this.el,
    });
    this.inputController.attach(this.view);
    this.gutterController.attach(this.view);
    this.cursorScroller = new CursorScroller({
      view: this.view,
      isHidden: () => this.el.hidden,
      cellHeight: () => cellH,
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (id) => cancelAnimationFrame(id),
      setTimer: (callback, delay) => setTimeout(callback, delay),
      clearTimer: (id) => clearTimeout(id),
    });
    this.displayDecorations = new IslandDisplayDecorations({
      document,
      highlights,
      view: this.view,
      element: this.el,
      decorationState: islandDecorationState,
      setTableConcealGuard,
      setInteractiveHighlights,
      setInteractiveOverlays,
      getCursor: () => this._nvimCursor,
      getMode: () => this.mode,
      cancelPendingZeroScrolloff: () => {
        if (!this._pendingZeroScrolloff) return;
        clearTimeout(this._pendingZeroScrolloff);
        this._pendingZeroScrolloff = 0;
      },
      keepPositionInView: (position) =>
        this.keepPositionInView(position),
      keepCursorInView: () => this.keepCursorInView(),
      requestFrame: (callback) => requestAnimationFrame(callback),
      forceRepaint,
      log: jlog,
    });
    this.applyFontZoom(effectiveGuiFontSize() / guiFontBaseSize);
  }
  applyFontZoom(globalScale) {
    this.el.style.setProperty(
      "--island-font-size",
      `${Math.max(6, 16 * globalScale + this.fontZoom)}px`,
    );
    this.view.requestMeasure();
    this.keepCursorInView();
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
    this.gutterController.set(o);
  }
  // Display bridge (runtime/md_decor.lua). `d` is the parsed payload:
  // { first, last, conceal: [[row, sByte, eByte, text], ...],
  //   visual: [[row, sByte, eByte], ...], folds: [[sRow, eRow], ...],
  //   hl: { runs: [[row, sByte, eByte, group], ...], defs: {...},
  //     codespans: [[row, sByte, eByte], ...],
  //     virt: [[row, col, hideBytes, [[text, group], ...]], ...] },
  //   heads: [[sRow, eRow, level], ...], codes: [[sRow, eRow], ...],
  //   quotes: [[sRow, eRow], ...], incsearch: [row, endByte] | null,
  //   visual_hl, accent_fg } in absolute buffer coordinates.
  //   Decorations are view-only, so nothing here reaches nvim_edit. `hl.defs` is merged globally by the
  //   listener; this only consumes `hl.runs` / `hl.virt`.
  setDecor(d) {
    this.displayDecorations.set(d);
  }
  destroy() {
    this.gutterController.destroy();
    this.cursorScroller.destroy();
    this.view.destroy();
    this.el.remove();
  }
  queueNvimCursor(row, col) {
    this.inputQueue.cursor(row, col);
  }
  queueNvimInput(keys) {
    this.inputQueue.input(keys);
  }
  queueNvimKey(keys, event) {
    if (this.inputController.syncSelectionBeforeInput(event, keys))
      this.inputQueue.input(keys);
  }
  // True when `cursor` sits behind a rendered table, a concealed image
  // source line, a closed fold's hidden body, or a conceal-hidden marker:
  // every source besides the visible caret that can hide real buffer bytes
  // behind a non-editable replace widget the DOM selection cannot enter.
  isCursorHidden(cursor) {
    if (!cursor) return false;
    const doc = this.view.state.doc;
    const line = doc.line(Math.min(cursor.row + 1, doc.lines));
    const pos = Math.min(line.from + byteToCol(line.text, cursor.col), line.to);
    const state = this.view.state;
    return (
      rangeHidesPos(state.field(islandDecorField), pos) ||
      rangeHidesPos(state.field(islandFoldField), pos) ||
      rangeHidesPos(state.field(markdownTableField).deco, pos) ||
      rangeHidesPos(state.field(markdownImageField).deco, pos)
    );
  }
  semanticWordTarget() {
    return findSemanticWordTarget(this.view.state.doc, this._nvimCursor);
  }
  applyBufLines(a, lastline, linedata) {
    const doc = this.view.state.doc;
    // `nvim_buf_attach` reports at line granularity, so its range replaces whole
    // lines even for a one-character keystroke. Shrink to the minimal
    // edit (common prefix + suffix removed) so decorations outside the actual
    // change map through untouched and do not flash / reflow the line.
    const edit = bufferLineEdit(doc, a, lastline, linedata);
    try {
      if (edit) this.tx({ changes: edit });
      // Cursor and buffer notifications are independent. A multibyte cursor can
      // arrive while CM still has the old line and be clamped to its old end.
      // Re-seat from the authoritative byte position after every line echo so
      // WebKit starts the next inline composition at the visible nvim cursor.
      this.syncSelectionToCursor();
      this.inputController.settleComposition();
    } catch (err) {
      jlog("island desync " + err);
      islandManager.reconcile(true);
    }
  }
  applyCursor(row, col, mode, scrolloff = this.scrolloff) {
    this.mode = mode;
    const nextScrolloff = Math.max(0, scrolloff);
    const scrolloffChanged = this.scrolloff !== nextScrolloff;
    // EasyMotion's marker prompt temporarily sets its window's 'scrolloff' to
    // zero, then restores it after the hint is chosen. It never moved the
    // cursor, so feeding that short-lived zero to the pixel scrolloff code
    // causes the distracting out-and-back jump. Wait long enough for the
    // display bridge to identify the EasyMotion matches. A real :set
    // scrolloff=0 has no such overlay and still applies normally.
    if (
      scrolloffChanged &&
      nextScrolloff === 0 &&
      !this.displayDecorations.easyMotionOverlay
    ) {
      clearTimeout(this._pendingZeroScrolloff);
      this._pendingZeroScrolloff = setTimeout(() => {
        this._pendingZeroScrolloff = 0;
        if (!this.displayDecorations.easyMotionOverlay) {
          this.applyCursor(row, col, mode, 0);
        }
      }, 80);
      return;
    }
    if (scrolloffChanged) clearTimeout(this._pendingZeroScrolloff);
    this._pendingZeroScrolloff = 0;
    this.scrolloff = nextScrolloff;
    // if this island holds the cursor, keep its .cm-content focused so hasFocus
    // is reliable (needed for the insert-mode IME carve-out), in every mode
    if (
      session.windowForGrid(session.cursorGrid) === this.winId &&
      !this.view.hasFocus
    )
      this.view.focus();
    // editable only in insert / replace / select mode, unless the guard is off
    this.setEditable(!blockImeInNormalMode || /^[iRsS\x13]/.test(mode));
    const doc = this.view.state.doc;
    const line = doc.line(Math.min(row + 1, doc.lines));
    const pos = Math.min(line.from + byteToCol(line.text, col), line.to);
    const cursorChanged =
      this._nvimCursor == null ||
      this._nvimCursor.row !== row ||
      this._nvimCursor.col !== col;
    this._nvimCursor = { row, col };
    this.inputController.onNvimCursor(row, col);
    this.tx({
      ...(cursorChanged ? { selection: { anchor: pos } } : {}),
      effects: setNvimCursor.of({ row, col, mode }),
    });
    if (cursorChanged || scrolloffChanged) this.keepCursorInView();
    this.el.dataset.mode = mode;
  }
  syncSelectionToCursor() {
    const cursor = this._nvimCursor;
    if (!cursor || this.inputController.isComposing()) return;
    const doc = this.view.state.doc;
    const line = doc.line(Math.min(cursor.row + 1, doc.lines));
    const anchor = Math.min(
      line.from + byteToCol(line.text, cursor.col),
      line.to,
    );
    this.tx({ selection: { anchor } });
  }
  keepCursorInView() {
    this.keepPositionInView(this._nvimCursor);
  }
  keepPositionInView(position) {
    this.cursorScroller.keepInView(position, this.scrolloff);
  }
  // `zz`: Neovim's own topline is irrelevant to the island (the preview owns
  // its own pixel scroll, see keepPositionInView), so `zz` is otherwise a
  // silent no-op here even though it is still forwarded to Neovim like any
  // other key.
  centerCursor() {
    this.cursorScroller.center(this._nvimCursor, this.scrolloff);
  }
  clearCursor() {
    this.tx({ effects: setNvimCursor.of(null) });
    // cursor left this island; drop focus so keys go to the global path
    if (this.view.hasFocus) this.view.contentDOM.blur();
    updateImeFocus();
  }
  applyReset(m) {
    // A reset can reuse this same Island for a new buffer (IslandManager
    // re-attaching on a buffer switch); the new buffer's first scrollTo must
    // not be skipped just because its topline/botline/linecount happen to
    // match whatever the old buffer last scrolled to.
    this._lastViewport = null;
    this._nvimCursor = null;
    this.inputController.reset();
    // clear decorations before the full-doc replace: if a stale set is what is
    // making dispatches throw, mapping it through this huge change would keep
    // the island wedged even across `:e` / a forced re-attach.
    this.view.dispatch({
      effects: [
        setIslandDecor.of(Decoration.none),
        setIslandFolds.of(Decoration.none),
        setIslandImageBase.of(m.name || ""),
      ],
    });
    this.tx({
      changes: { from: 0, to: this.view.state.doc.length, insert: m.lines.join("\n") },
    });
    this.applyCursor(m.row, m.col, m.mode, m.scrolloff);
  }
  scrollTo(topline, botline, linecount) {
    // Neovim's viewport is based on grid rows and keeps whole wrapped buffer
    // lines visible. The preview owns visual scrolling instead: it uses the
    // measured cursor rectangle in keepCursorInView, so prose may scroll
    // through a wrapped line and honor scrolloff in actual pixels. Retain the
    // dedupe state because win_viewport is still a useful model-level signal
    // and must never grow into an unconditional scrollIntoView call again.
    const key = `${topline}/${botline}/${linecount}`;
    if (this._lastViewport === key) return;
    this._lastViewport = key;
  }
}

// ---------------------------------------------------------------------------
// grid op stream
// ---------------------------------------------------------------------------
// Coalesce redraw batches to one paint per animation frame. Neovim can flush
// faster than the display refreshes (held `j`, `:%s`, a big paste); painting
// every flush wastes DOM work and a forced reflow each time. Ops keep their
// arrival order, so a later frame's cursor / colour / layout op still wins.
const gridCoordinator = new GridCoordinator({
  session,
  grids,
  gridFor: gw,
  islandForGrid,
  reconcileIslands: () => islandManager.reconcile(),
  isIslandGrid: (id) => islandManager.gridIds.has(id),
  onColors: applyDefaultColors,
  onHighlight: (id, attr) => highlights.setGrid(id, attr),
  onModeInfo: (enabled) => {
    cursorStyleEnabled = enabled;
  },
  onTitle: (title) => currentWin.setTitle(title).catch(() => {}),
  forceRepaint,
  placeGridCursor,
  updateInputFocus: updateImeFocus,
});
const redrawScheduler = new RedrawScheduler({
  requestFrame: (callback) => requestAnimationFrame(callback),
  render: (ops) => {
    gridCoordinator.render(ops);
    // grid_cursor_goto may hand the cursor to or from an opted-out island
    // without any gnv_cursor notification (e.g. leaving the command line).
    syncGrammarlyAccessibility();
  },
});
function applyGridBatch(ops) {
  redrawScheduler.enqueue(ops);
}

function applyDefaultColors(op) {
  highlights.setDefaults(op);
  applyTheme();
  for (const grid of grids.values()) grid.fullDirty = true;
  highlights.resetIslandDefinitions();
  return grids.keys();
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
    if (!islandManager.gridIds.has(id)) {
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
  return calculateScreenMetrics(el.clientWidth, el.clientHeight, cellW, cellH, MIN_PAD_X);
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
  for (const isl of islands.values()) isl.keepCursorInView();
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
    nvim
      .resize(m.cols, m.rows)
      .then(() => {
        lastSize = { cols: m.cols, rows: m.rows };
      })
      .catch((e) => jlog("resize failed: " + e));
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
    const cfg = await nvim.config();
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
    nvim.on("grid", (e) => applyGridBatch(e.payload)),
    nvim.on("winft", (e) => {
      session.setWindowInfo(e.payload.win, e.payload.buf, e.payload.ft);
      islandManager.reconcile();
    }),
    nvim.on("reset", (e) => {
      for (const isl of islands.values())
        if (isl.bufnr === e.payload.buf) isl.applyReset(e.payload);
    }),
    nvim.on("lines", (e) => {
      const { buf, firstline, lastline, linedata } = e.payload;
      for (const isl of islands.values())
        if (isl.bufnr === buf) isl.applyBufLines(firstline, lastline, linedata);
    }),
    nvim.on("cursor", (e) => {
      // CursorMoved reports the current window explicitly. Never infer its
      // buffer from cursorGrid: a redraw can deliver this notification before
      // its grid_cursor_goto, which previously applied another window's row to
      // the island and scrolled it to that clamped position.
      session.setCursor(e.payload);
      const isl = islands.get(e.payload.win);
      if (isl)
        isl.applyCursor(
          e.payload.row,
          e.payload.col,
          e.payload.mode,
          e.payload.scrolloff,
        );
      syncGrammarlyAccessibility();
    }),
    nvim.on("cmdline", () => {
      session.setCmdlineActive(true);
      updateImeFocus();
      syncGrammarlyAccessibility();
    }),
    nvim.on("cmdline_hide", () => {
      session.setCmdlineActive(false);
      updateImeFocus();
      syncGrammarlyAccessibility();
    }),
    nvim.on("focus", () => repaintNow()),
    nvim.on("look_up", () => islandLookup()),
    nvim.on("guiopt", (e) => applyGuiOpt(e.payload.name, e.payload.value)),
    nvim.on("md_preview", (e) => {
      const { win, state } = e.payload;
      session.setPreview(win, state);
      islandManager.reconcile();
      syncGrammarlyAccessibility();
    }),
    nvim.on("win_gutter", (e) => {
      session.setGutter(e.payload);
      islands.get(e.payload.win)?.setGutter(e.payload);
    }),
    nvim.on("grammarly", (e) => {
      session.setGrammarly(e.payload.win, e.payload.state);
      syncGrammarlyAccessibility();
    }),
    nvim.on("md_decor", (e) => {
      let d;
      try {
        d = JSON.parse(e.payload.json);
      } catch (error) {
        jlog("invalid md_decor payload: " + error);
        return;
      }
      if (d.hl?.defs) highlights.mergeIslandDefinitions(d.hl.defs);
      const isl = islands.get(e.payload.win);
      if (isl) isl.setDecor(d);
    }),
    // `:GneovimResyncIsland`, the fold-desync escape hatch (see
    // docs/markdown-island-fold-desync.md and runtime/md_preview.lua). The
    // Lua side has already reset its own fold and highlight-cache state
    // before sending this; force(true) is the same full detach/reattach
    // path applyBufLines already falls back to on a caught desync.
    nvim.on("resync_island", () => {
      jlog("resync_island: forcing a full island resync");
      islandManager.reconcile(true);
      nvim.refreshMarkdownDecorations().catch(() => {});
    }),
    nvim.on("gone", (e) => showGone(e.payload)),
  ]);

  jlog(`listeners ready; cellW=${cellW.toFixed(2)} cellH=${cellH.toFixed(2)}`);

  // Now that grid/winft listeners are live, attach the Neovim UI. The first
  // redraw (every window's grid_line) is emitted only after this point, so
  // nothing is lost and no redraw-replay hack is needed.
  const m0 = screenMetrics();
  applyScreen(m0);
  for (let i = 0; i < 100; i++) {
    try {
      await nvim.uiStart(m0.cols, m0.rows);
      jlog(`ui_start ok ${m0.cols}x${m0.rows} pad=${m0.padX}`);
      break;
    } catch (e) {
      if (i === 20) jlog("ui_start still failing: " + e);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // winft events fired before we were listening; replay them (with the
  // per-window live-preview flag). IslandManager then mounts an island on
  // every previewed markdown window.
  try {
    for (const [win, buf, ft, mdp] of await nvim.winFiletypes()) {
      session.setWindowInfo(win, buf, ft);
      if (mdp === 0 || mdp === 1) session.setPreview(win, mdp);
    }
    islandManager.reconcile();
    jlog(`winfts replayed: ${JSON.stringify([...session.windowFiletypes])}`);
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
    ] of await nvim.windowGutters()) {
      const g = { win, number, relativenumber, numberwidth, signcolumn, foldcolumn };
      session.setGutter(g);
      islands.get(win)?.setGutter(g);
    }
  } catch (e) {
    jlog("wingutters failed: " + e);
  }

  // Grammarly flags (md_preview.lua) likewise; pull them.
  try {
    for (const [win, state] of await nvim.windowGrammarly()) {
      session.setGrammarly(win, state);
    }
    syncGrammarlyAccessibility();
  } catch (e) {
    jlog("wingrammarly failed: " + e);
  }

  // display-bridge payloads also fire before we listen; nudge a re-push.
  nvim.refreshMarkdownDecorations().catch((e) => jlog("md_decor failed: " + e));

  // GUI options (guifont / linespace) set before we were listening
  try {
    let changed = false;
    for (const [name, value] of await nvim.guiOptions()) {
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
        `state: grids=${grids.size} winPos=${session.windowPositions.size} ` +
          `islands=${islands.size} winFt=${JSON.stringify([...session.windowFiletypes])}`,
      ),
    800,
  );
})();

// ---------------------------------------------------------------------------
// keyboard -> nvim_input
// ---------------------------------------------------------------------------
// from config [input] option_is_meta; Option+<key> -> <M-...> instead of é/•/…
let optionIsMeta = true;
// from config [input] block_ime_in_normal_mode; islands go non-editable outside
// insert mode so a CJK IME cannot hijack normal-mode keys
let blockImeInNormalMode = true;
// from config [input] forward_cmd_keys; send Cmd+<key> to nvim as <D-...>
let forwardCmdKeys = false;

function normalModeActive(island) {
  return session.normalModeActive(island?.mode, Boolean(island));
}
function keyToNvim(e) {
  return encodeKeyToNvim(e, { optionIsMeta, forwardCmdKeys });
}

function islandLookup() {
  const isl = islandForGrid(session.cursorGrid);
  if (!isl) {
    jlog("look up: no focused island");
    return false;
  }
  const pos = isl.view.state.selection.main.head;
  const line = isl.view.state.doc.lineAt(pos);
  const col = pos - line.from;
  const segments = new Intl.Segmenter(undefined, { granularity: "word" }).segment(line.text);
  let word = null;
  let from = pos;
  for (const segment of segments) {
    const end = segment.index + segment.segment.length;
    if (segment.isWordLike && segment.index <= col && col <= end) {
      word = segment.segment;
      from = line.from + segment.index;
      break;
    }
  }
  if (!word) {
    jlog("look up: no word at cursor");
    return false;
  }
  const coords = isl.view.coordsAtPos(from);
  if (!coords) {
    jlog("look up: no cursor coordinates");
    return false;
  }
  jlog(`look up: island sent ${JSON.stringify(word)}`);
  nvim.showDefinition(word, coords.left, coords.bottom).catch((err) =>
    jlog("show_definition failed: " + err),
  );
  return true;
}

function handleFontZoom(e) {
  if (!e.metaKey || e.ctrlKey) return false;
  const action =
    e.code === "Equal" ? 1 : e.code === "Minus" ? -1 : e.code === "Digit0" ? 0 : null;
  if (action == null) return false;
  e.preventDefault();
  if (e.altKey) {
    const island = islandForGrid(session.cursorGrid);
    if (!island) return true;
    island.fontZoom = action === 0 ? 0 : island.fontZoom + action * FONT_ZOOM_STEP;
    island.applyFontZoom(effectiveGuiFontSize() / guiFontBaseSize);
  } else {
    guiFontZoom = action === 0 ? 0 : guiFontZoom + action * FONT_ZOOM_STEP;
    applyFontZoom();
    relayoutForFont();
  }
  return true;
}

let islandNativeWPending = false;
// The island awaiting the second key of a Normal-mode `zz`, or null. Scoped
// to one island by object identity, so switching focus mid-sequence cannot
// let a stray `z` in a different island complete someone else's `zz`.
let islandPendingZ = null;
addEventListener("keydown", (e) => {
  if (imeComposing) return; // IME is mid-composition; let #ime + the OS handle it
  if (handleFontZoom(e)) return;
  // A command line temporarily belongs to Neovim, even when the underlying
  // cursor grid is a Markdown island. Do not apply island Normal-mode physical
  // punctuation or semantic-motion interception to command-line text.
  const isl = session.cmdlineActive ? null : islandForGrid(session.cursorGrid);
  const normalPunctuation =
    normalModeActive(isl) ? normalModePunctuation(e) : null;
  if (normalPunctuation != null) {
    // In Normal mode, use the physical punctuation key even when a CJK input
    // source reports Process, keyCode 229, or full-width punctuation. This is
    // global across grid windows and islands; Insert mode and command lines
    // retain the IME's actual character. In an island, treat it as a possible
    // mapping/operator prefix so a following `w` remains native rather than
    // being consumed by semantic prose navigation.
    if (isl) islandNativeWPending = true;
    e.preventDefault();
    const keys = normalPunctuation === "<" ? "<lt>" : normalPunctuation;
    if (isl) isl.queueNvimKey(keys, e);
    else nvim.input(keys).catch((error) => jlog("grid input failed: " + error));
    return;
  }
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
  if (
    isl &&
    isl.mode === "n" &&
    plain &&
    (/^[1-9]$/.test(e.key) ||
      (islandNativeWPending && e.key === "0") ||
      /^[dcy><=!gz"'\[]$/.test(e.key))
  )
    islandNativeWPending = true;
  if (
    isl &&
    isl.mode === "n" &&
    e.key === "w" &&
    plain &&
    !islandNativeWPending
  ) {
    const target = isl.semanticWordTarget();
    if (target) {
      e.preventDefault();
      isl.queueNvimCursor(target.row, target.col);
      return;
    }
  }
  if (e.key === "w" || e.key === "Escape") islandNativeWPending = false;
  // `zz`: Neovim still gets both keys, unchanged, like any other Normal-mode
  // command; the island just also centers its own pixel scroll on the
  // second one, since Neovim's resulting topline change is otherwise
  // invisible to it (see Island.centerCursor).
  if (isl && isl.mode === "n" && plain && e.key === "z") {
    if (islandPendingZ === isl) {
      isl.centerCursor();
      islandPendingZ = null; // completed; a further z starts a new pair
    } else {
      islandPendingZ = isl;
    }
  } else {
    islandPendingZ = null;
  }
  const keys = keyToNvim(e);
  if (keys === null) return; // mid-composition / lone modifier
  // Editable grid context (insert/replace or command line): plain text goes into
  // the #ime textarea for the OS IME; input/compositionend forward it to nvim.
  // Named and modified keys, including Enter and Backspace, still pass here.
  if (
    gridTextInputActive() &&
    document.activeElement === imeEl &&
    !keys.startsWith("<")
  )
    return;
  e.preventDefault();
  if (isl) isl.queueNvimKey(keys, e);
  else nvim.input(keys).catch((error) => jlog("grid input failed: " + error));
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
  nvim.mouse(button, action, mouseMods(e), cell.row, cell.col).catch(() => {});

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
