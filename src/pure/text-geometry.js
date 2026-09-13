const textEncoder = new TextEncoder();

export const byteLen = (text) => textEncoder.encode(text).length;

// Return the UTF-16 offset at a UTF-8 byte column. Neovim uses byte offsets;
// CodeMirror uses UTF-16 offsets.
export function byteToCol(text, byte) {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    if (bytes >= byte) return i;
    const codePoint = text.codePointAt(i);
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    if (codePoint >= 0x10000) i++;
  }
  return text.length;
}
