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

const SHIFT_CODE_CHAR = {
  Minus: "_",
  Equal: "+",
  BracketLeft: "{",
  BracketRight: "}",
  Backslash: "|",
  Semicolon: ":",
  Quote: '"',
  Backquote: "~",
  Comma: "<",
  Period: ">",
  Slash: "?",
};

export function normalModePunctuation(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (!Object.hasOwn(SHIFT_CODE_CHAR, event.code)) return null;
  return (event.shiftKey ? SHIFT_CODE_CHAR : CODE_CHAR)[event.code] ?? null;
}

export function baseFromCode(event) {
  let match;
  if ((match = /^Key([A-Z])$/.exec(event.code))) return match[1].toLowerCase();
  if ((match = /^(?:Digit|Numpad)([0-9])$/.exec(event.code))) return match[1];
  return CODE_CHAR[event.code] ?? null;
}

export function keyToNvim(event, { optionIsMeta = true, forwardCmdKeys = false } = {}) {
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.metaKey && !forwardCmdKeys) return null;
  const key = event.key;
  const isFunctionKey = /^F([1-9]|1\d|2[0-4])$/.test(key);

  if (optionIsMeta && event.altKey && !event.ctrlKey && !event.metaKey) {
    if (event.code === "AltLeft" || event.code === "AltRight") return null;
    const codeBase = baseFromCode(event);
    const base =
      NAMED[key] ??
      (isFunctionKey ? key : undefined) ??
      NAMED[codeBase] ??
      codeBase ??
      (key.length === 1 && key.charCodeAt(0) < 0x80 ? key : undefined);
    if (base == null) return null;
    return `<M-${event.shiftKey ? "S-" : ""}${base === "<" ? "lt" : base}>`;
  }

  if (MOD_ONLY.has(key)) return null;

  let base = NAMED[key];
  let named = base !== undefined;
  if (!named && isFunctionKey) {
    base = key;
    named = true;
  }
  if (!named) {
    if (key.length !== 1) return null;
    if (event.altKey && !event.ctrlKey && !event.metaKey && key.charCodeAt(0) > 0x7f) return key;
    base = key === "<" ? "lt" : key;
    if (/[A-Za-z]/.test(base) && (event.ctrlKey || event.metaKey || event.altKey)) {
      base = base.toLowerCase();
    }
  }

  let modifiers = "";
  if (event.metaKey) modifiers += "D-";
  if (event.ctrlKey) modifiers += "C-";
  if (event.altKey) modifiers += "M-";
  if (event.shiftKey && (named || modifiers)) modifiers += "S-";

  if (modifiers || named || base === "lt") return `<${modifiers}${base}>`;
  return base;
}
