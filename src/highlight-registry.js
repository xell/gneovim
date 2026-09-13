export const rgbHex = (value) =>
  value == null || value < 0 ? null : "#" + value.toString(16).padStart(6, "0");

export function colorLuma(color) {
  const value = parseInt(color.slice(1), 16);
  return (
    0.299 * ((value >> 16) & 255) +
    0.587 * ((value >> 8) & 255) +
    0.114 * (value & 255)
  );
}

const withAlpha = (css, blend) =>
  blend && /^#[0-9a-f]{6}$/i.test(css)
    ? css +
      Math.round((100 - blend) * 2.55)
        .toString(16)
        .padStart(2, "0")
    : css;

export class HighlightRegistry {
  constructor({ document }) {
    this.document = document;
    this.gridAttributes = new Map();
    this.defaults = { fg: "#000000", bg: "#ffffff", sp: "#d40000" };
    this.islandClasses = new Map();
    this.islandDefinitions = new Map();
    this.islandStyleElement = null;
  }

  setGrid(id, attributes) {
    this.gridAttributes.set(id, attributes);
  }

  gridAttributesFor(id) {
    return this.gridAttributes.get(id);
  }

  setDefaults({ fg, bg, sp }) {
    this.defaults = {
      fg: rgbHex(fg) ?? this.defaults.fg,
      bg: rgbHex(bg) ?? this.defaults.bg,
      sp: rgbHex(sp) ?? this.defaults.sp,
    };
  }

  gridCss(id) {
    const attributes = this.gridAttributes.get(id) || {};
    let foreground = rgbHex(attributes.foreground) ?? this.defaults.fg;
    let background = rgbHex(attributes.background) ?? null;
    const special = rgbHex(attributes.special) ?? this.defaults.sp;
    if (attributes.reverse || attributes.standout) {
      const previous = foreground;
      foreground = background ?? this.defaults.bg;
      background = previous;
    }
    const camouflage =
      background && foreground.toLowerCase() === background.toLowerCase();
    const blend = attributes.blend | 0;
    let css = camouflage ? "" : `color:${withAlpha(foreground, blend)};`;
    if (background && !camouflage) {
      css += `background:${withAlpha(background, blend)};`;
    }
    if (attributes.bold) css += "font-weight:700;";
    if (attributes.italic) css += "font-style:italic;";

    const underline =
      attributes.underline ||
      attributes.undercurl ||
      attributes.underdouble ||
      attributes.underdotted ||
      attributes.underdashed;
    const lines = [];
    if (underline) lines.push("underline");
    if (attributes.strikethrough) lines.push("line-through");
    if (lines.length) css += `text-decoration-line:${lines.join(" ")};`;
    if (underline) {
      const style = attributes.undercurl
        ? "wavy"
        : attributes.underdouble
          ? "double"
          : attributes.underdotted
            ? "dotted"
            : attributes.underdashed
              ? "dashed"
              : "solid";
      css += `text-decoration-style:${style};text-decoration-color:${special};`;
    }
    return css;
  }

  islandClass(group) {
    let className = this.islandClasses.get(group);
    if (!className) {
      className = "cm-h-" + this.islandClasses.size;
      this.islandClasses.set(group, className);
    }
    return className;
  }

  mergeIslandDefinitions(definitions) {
    let added = false;
    for (const [group, attributes] of Object.entries(definitions)) {
      if (!this.islandDefinitions.has(group)) {
        this.islandDefinitions.set(group, attributes);
        added = true;
      }
    }
    if (added) this.rebuildIslandStyles();
  }

  resetIslandDefinitions() {
    this.islandDefinitions.clear();
    if (this.islandStyleElement) this.islandStyleElement.textContent = "";
  }

  rebuildIslandStyles() {
    let css = "";
    const sorted = [...this.islandDefinitions].sort(
      (left, right) => (left[1].priority ?? 0) - (right[1].priority ?? 0),
    );
    for (const [group, attributes] of sorted) {
      let foreground = attributes.fg;
      let background = attributes.bg;
      if (attributes.reverse) {
        [foreground, background] = [
          background || "var(--bg)",
          foreground || "var(--fg)",
        ];
      }
      if (foreground && foreground === background) foreground = background = null;
      const properties = [];
      if (foreground) properties.push(`color:${foreground}`);
      if (background) properties.push(`background-color:${background}`);
      if (attributes.bold) properties.push("font-weight:700");
      if (attributes.italic) properties.push("font-style:italic");
      const decorations = [];
      if (attributes.underline) decorations.push("underline");
      if (attributes.undercurl) decorations.push("underline wavy");
      if (attributes.strikethrough) decorations.push("line-through");
      if (decorations.length) {
        properties.push(`text-decoration:${decorations.join(" ")}`);
        if (attributes.sp) properties.push(`text-decoration-color:${attributes.sp}`);
      }
      if (properties.length) {
        css += `.island .${this.islandClass(group)}{${properties.join(";")}}\n`;
      }
    }
    if (!this.islandStyleElement) {
      this.islandStyleElement = this.document.createElement("style");
      this.document.head.append(this.islandStyleElement);
    }
    this.islandStyleElement.textContent = css;
  }
}
