// Resolve Markdown image URLs without importing Tauri. The concrete asset URL
// conversion is supplied by the application adapter.
export function imageSource(url, bufferName, convertFileSrc) {
  if (/^https?:\/\//i.test(url) || url.startsWith("data:image/")) return url;
  if (!bufferName.startsWith("/")) return null;
  try {
    const base = new URL(`file://${bufferName}`);
    const local = new URL(url, base);
    if (local.protocol !== "file:") return null;
    return convertFileSrc(decodeURIComponent(local.pathname));
  } catch {
    return null;
  }
}
