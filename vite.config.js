import { defineConfig } from "vite";

// Frontend dev server only. The nvim bridge now lives in the Tauri shell
// (src-tauri/src/bridge.rs); Vite just serves and bundles the CodeMirror UI.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // CodeMirror breaks if @codemirror/state or /view load as two instances.
  resolve: { dedupe: ["@codemirror/state", "@codemirror/view"] },
});
