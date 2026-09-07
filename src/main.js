import { EditorView, basicSetup } from "codemirror";
import { Decoration, WidgetType } from "@codemirror/view";
import { Annotation, StateEffect, StateField } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";

const editorEl = document.getElementById("editor");
const te = new TextEncoder();
const byteLen = (s) => te.encode(s).length;

// Transactions that come FROM nvim, so the updateListener can skip them.
const fromNvim = Annotation.define();

// --- nvim cursor as a decoration -------------------------------------------
const setNvimCursor = StateEffect.define();

class BlockCursor extends WidgetType {
  constructor(cls) {
    super();
    this.cls = cls;
  }
  eq(other) {
    return other.cls === this.cls;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = this.cls + " nvim-cursor-eol";
    s.textContent = " ";
    return s;
  }
}

function cursorDeco(state, pos) {
  if (!pos) return Decoration.none;
  const { row, col, mode } = pos;
  const kind = mode[0] === "i" ? "insert" : mode[0] === "R" ? "replace" : "normal";
  if (kind === "insert") return Decoration.none; // native caret is shown instead

  const doc = state.doc;
  const line = doc.line(Math.min(row + 1, doc.lines));
  const from = Math.min(line.from + col, line.to);
  const to = Math.min(from + 1, line.to);
  const cls =
    kind === "replace"
      ? "nvim-cursor nvim-cursor-underline"
      : "nvim-cursor nvim-cursor-block";

  return from === to
    ? Decoration.set([
        Decoration.widget({ widget: new BlockCursor(cls), side: 1 }).range(from),
      ])
    : Decoration.set([Decoration.mark({ class: cls }).range(from, to)]);
}

const nvimCursorField = StateField.define({
  create: () => ({ deco: Decoration.none, pos: null }),
  update(value, tr) {
    let pos = value.pos;
    for (const e of tr.effects) if (e.is(setNvimCursor)) pos = e.value;
    return { deco: cursorDeco(tr.state, pos), pos };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

// --- forward CM6-originated edits to nvim ------------------------------------
function forwardExternalEdit(u) {
  if (!u.docChanged) return;
  if (!u.transactions.some((tr) => !tr.annotation(fromNvim))) return; // ours

  const oldDoc = u.startState.doc;
  const regions = [];
  u.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
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
  regions.reverse(); // nvim_buf_set_text applied bottom-up keeps offsets valid
  send({ type: "edit", regions });
}

// --- forward clicks to nvim ------------------------------------------------------
const clickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;
    const line = view.state.doc.lineAt(pos);
    send({
      type: "cursor-set",
      row: line.number - 1,
      col: byteLen(line.text.slice(0, pos - line.from)),
    });
    return false; // let CM place its selection too; nvim echo re-affirms it
  },
});

// --- the editor -----------------------------------------------------------------
const view = new EditorView({
  doc: "",
  extensions: [
    basicSetup,
    markdown(),
    EditorView.lineWrapping,
    nvimCursorField,
    clickHandler,
    EditorView.updateListener.of(forwardExternalEdit),
  ],
  parent: editorEl,
});

// --- apply nvim -> CM6 --------------------------------------------------------
function nvimTx(spec) {
  view.dispatch({ ...spec, annotations: fromNvim.of(true) });
}

// nvim_buf_lines_event(firstline, lastline, linedata) -> minimal CM6 change.
function applyBufLines(firstline, lastline, linedata) {
  const doc = view.state.doc;
  const L = doc.lines;
  const a = firstline;
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
      from = doc.line(a).to; // end of line a-1, before its "\n"
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
    console.warn("[applyBufLines] failed — resyncing", err);
    send({ type: "resync" });
  }
}

function applyCursor(row, col, mode) {
  const doc = view.state.doc;
  const line = doc.line(Math.min(row + 1, doc.lines));
  const pos = Math.min(line.from + col, line.to);
  nvimTx({
    selection: { anchor: pos },
    effects: setNvimCursor.of({ row, col, mode }),
    scrollIntoView: true,
  });
  editorEl.dataset.mode = mode;
}

// --- WebSocket bridge --------------------------------------------------------
const statusEl = document.getElementById("status");
const connEl = document.getElementById("conn");
const modeEl = document.getElementById("mode");
const fileEl = document.getElementById("file");
const cmdlineEl = document.getElementById("cmdline");

const basename = (p) => (p && p.split("/").pop()) || "[No Name]";

function renderCmdline(ctype, content, pos) {
  const i = Math.max(0, Math.min(pos - 1, content.length));
  const prefix = document.createElement("span");
  prefix.className = "cmdline-prefix";
  prefix.textContent = ctype || ":";
  const caret = document.createElement("span");
  caret.className = "cmdline-caret";
  caret.textContent = content.slice(i, i + 1) || " ";
  cmdlineEl.replaceChildren(
    prefix,
    content.slice(0, i),
    caret,
    content.slice(i + 1),
  );
  cmdlineEl.hidden = false;
}

function hideCmdline() {
  cmdlineEl.hidden = true;
  cmdlineEl.replaceChildren();
}

const MODE_NAMES = {
  n: "NORMAL",
  no: "OP-PENDING",
  v: "VISUAL",
  V: "V-LINE",
  "\x16": "V-BLOCK",
  s: "SELECT",
  i: "INSERT",
  R: "REPLACE",
  c: "COMMAND",
  t: "TERMINAL",
};
const modeName = (m) => MODE_NAMES[m] ?? MODE_NAMES[m?.[0]] ?? m ?? "—";

let ws = null;

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/nvim`);

  ws.onopen = () => {
    statusEl.className = "ok";
    connEl.textContent = "connected";
  };

  ws.onclose = () => {
    statusEl.className = "down";
    connEl.textContent = "disconnected — retrying";
    hideCmdline();
    setTimeout(connect, 1000);
  };

  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "reset") {
      nvimTx({
        changes: { from: 0, to: view.state.doc.length, insert: m.lines.join("\n") },
      });
      applyCursor(m.row, m.col, m.mode);
      modeEl.textContent = modeName(m.mode);
      if (m.name !== undefined) fileEl.textContent = basename(m.name);
      hideCmdline();
    } else if (m.type === "lines") {
      applyBufLines(m.firstline, m.lastline, m.linedata);
    } else if (m.type === "cursor") {
      applyCursor(m.row, m.col, m.mode);
      modeEl.textContent = modeName(m.mode);
    } else if (m.type === "cmdline") {
      renderCmdline(m.ctype, m.content, m.pos);
    } else if (m.type === "cmdline_hide") {
      hideCmdline();
    }
  };
}

connect();

// --- keyboard -> nvim_input ------------------------------------------------------
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
  if (e.metaKey) return null; // leave Cmd shortcuts to the OS
  if (["Shift", "Control", "Alt", "Meta", "CapsLock", "Dead"].includes(e.key)) {
    return null;
  }

  let key = NAMED[e.key];
  const isNamed = key !== undefined;
  if (!isNamed) {
    if (e.key.length !== 1) return null; // F-keys etc. — out of scope
    key = e.key === "<" ? "lt" : e.key;
  }

  const mods = (e.ctrlKey ? "C-" : "") + (e.altKey ? "M-" : "");
  if (mods || isNamed || key === "lt") return `<${mods}${key}>`;
  return key;
}

addEventListener("keydown", (e) => {
  const keys = keyToNvim(e);
  if (keys === null) return;
  e.preventDefault();
  send({ type: "input", keys });
});
