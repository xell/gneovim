// The single owner of the frozen Tauri IPC surface. This module deliberately
// receives its transport adapters so it can be tested without Tauri or a DOM.
export class NvimClient {
  constructor({ invoke, listen, windowLabel }) {
    this.invoke = invoke;
    this.listen = listen;
    this.windowLabel = windowLabel;
    this.inputQueue = Promise.resolve();
  }

  eventName(kind) {
    return `gnv://${this.windowLabel}/${kind}`;
  }

  on(kind, callback) {
    return this.listen(this.eventName(kind), callback);
  }

  input(keys) {
    const request = this.inputQueue.then(() => this.invoke("nvim_input", { keys }));
    // Keep later input moving after a rejected request while still returning the
    // original rejection to the caller that owns its error policy.
    this.inputQueue = request.catch(() => {});
    return request;
  }

  showDefinition(text, x, y) {
    return this.invoke("show_definition", { text, x, y });
  }

  cursorSet(win, row, col) {
    return this.invoke("nvim_cursor_set", { win, row, col });
  }

  edit(buf, regions) {
    return this.invoke("nvim_edit", { buf, regions });
  }

  mouse(button, action, modifier, row, col) {
    return this.invoke("nvim_mouse", { button, action, modifier, row, col });
  }

  attachIsland(win) {
    return this.invoke("island_attach", { win });
  }

  detachIsland(buf) {
    return this.invoke("island_detach", { buf }).catch(() =>
      // Detach is idempotent in Rust. A retry is safe whether the first request
      // failed before execution or only lost its response.
      this.invoke("island_detach", { buf }),
    );
  }

  resize(cols, rows) {
    return this.invoke("nvim_resize", { cols, rows });
  }

  redraw() {
    return this.invoke("nvim_redraw");
  }

  uiStart(cols, rows) {
    return this.invoke("nvim_ui_start", { cols, rows });
  }

  log(message) {
    return this.invoke("js_log", { msg: String(message) });
  }

  config() {
    return this.invoke("gnv_config");
  }

  winFiletypes() {
    return this.invoke("nvim_winfts");
  }

  guiOptions() {
    return this.invoke("nvim_guiopts");
  }

  windowGutters() {
    return this.invoke("nvim_wingutters");
  }

  windowGrammarly() {
    return this.invoke("nvim_wingrammarly");
  }

  windowOptimalWidth() {
    return this.invoke("nvim_winoptimalwidth");
  }

  setAccessibilityHidden(hidden) {
    return this.invoke("set_accessibility_hidden", { hidden });
  }

  refreshMarkdownDecorations() {
    return this.invoke("nvim_md_decor");
  }

  pasteClipboard() {
    return this.invoke("nvim_paste_clip");
  }

  yankClipboard(cut) {
    return this.invoke("nvim_clip_yank", { cut });
  }

  newWindow() {
    return this.invoke("new_window");
  }

  newTab() {
    return this.invoke("new_tab");
  }
}
