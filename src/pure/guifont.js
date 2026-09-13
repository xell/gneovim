// Parse `guifont` ("Family:h14,Fallback:h13" ...) from the first entry.
export function parseGuifont(value) {
  const first = (value || "").split(",")[0].trim();
  if (!first) return null;
  const parts = first.split(":");
  const family = parts[0].replace(/\\ /g, " ").replace(/_/g, " ").trim();
  let size = null;
  for (const part of parts.slice(1)) {
    const match = /^h([\d.]+)$/.exec(part);
    if (match) size = parseFloat(match[1]);
  }
  return { family, size };
}
