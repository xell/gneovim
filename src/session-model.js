// Owns the frontend's mirror of Neovim window relationships. Rendering and
// editor modules may query this model, but transport event ordering is resolved
// here rather than by coordinating several unrelated maps.
export class SessionModel {
  constructor() {
    this.windowPositions = new Map();
    this.gridWindows = new Map();
    this.windowFiletypes = new Map();
    this.windowBuffers = new Map();
    this.previewWindows = new Map();
    this.windowGutters = new Map();
    this.grammarlyWindows = new Map();
    this.cursorGrid = 1;
    this.lastCursor = null;
    this.modeName = "n";
    this.modeInfo = [];
    this.currentMode = null;
    this.cmdlineActive = false;
  }

  positionForGrid(grid) {
    return this.windowPositions.get(grid);
  }

  windowForGrid(grid) {
    return this.gridWindows.get(grid);
  }

  filetypeForWindow(win) {
    return this.windowFiletypes.get(win) || "";
  }

  bufferForWindow(win) {
    return this.windowBuffers.get(win);
  }

  gutterForWindow(win) {
    return this.windowGutters.get(win);
  }

  // Whether Grammarly may act on the window's island. Unknown means allowed.
  grammarlyForWindow(win) {
    return this.grammarlyWindows.get(win) ?? true;
  }

  // Whether the webview's content should be published to macOS Accessibility:
  // only while the cursor is in an allowed island and no command line owns it.
  // Grid windows, the command line, and command-line windows are never
  // published, so an external client such as Grammarly has nothing to attach
  // to there.
  accessibilityExposed(isIsland) {
    if (this.cmdlineActive) return false;
    const win = this.windowForGrid(this.cursorGrid);
    return win != null && isIsland(win) && this.grammarlyForWindow(win);
  }

  isMarkdownWindow(win) {
    return this.filetypeForWindow(win).includes("markdown");
  }

  wantsIsland(win, livePreviewDefault) {
    if (!this.isMarkdownWindow(win)) return false;
    return this.previewWindows.has(win)
      ? this.previewWindows.get(win)
      : livePreviewDefault;
  }

  desiredIslands(livePreviewDefault) {
    const desired = new Map();
    for (const [grid, win] of this.gridWindows) {
      if (this.wantsIsland(win, livePreviewDefault)) desired.set(win, grid);
    }
    return desired;
  }

  setWindowInfo(win, buf, filetype) {
    this.windowFiletypes.set(win, filetype || "");
    if (buf != null) this.windowBuffers.set(win, buf);
  }

  setPreview(win, state) {
    if (state === -1) this.previewWindows.delete(win);
    else this.previewWindows.set(win, state === 1 || state === true);
  }

  setGutter(payload) {
    this.windowGutters.set(payload.win, payload);
  }

  setGrammarly(win, state) {
    if (state === -1) this.grammarlyWindows.delete(win);
    else this.grammarlyWindows.set(win, state === 1 || state === true);
  }

  moveGridCursor(grid) {
    const previous = this.cursorGrid;
    this.cursorGrid = grid;
    return previous;
  }

  setCursor(payload) {
    this.lastCursor = payload;
  }

  setMode(name, index) {
    this.modeName = name || this.modeName;
    if (index != null) this.currentMode = this.modeInfo[index] ?? null;
  }

  setModeInfo(modes) {
    this.modeInfo = modes || [];
  }

  setCmdlineActive(active) {
    this.cmdlineActive = active;
  }

  normalModeActive(islandMode = null, islandPresent = false) {
    if (this.cmdlineActive) return false;
    if (islandPresent) return islandMode === "n";
    return this.lastCursor ? this.lastCursor.mode === "n" : this.modeName === "normal";
  }

  placeGrid(grid, position, win = null) {
    this.windowPositions.set(grid, position);
    if (win != null) this.gridWindows.set(grid, win);
  }

  hideGrid(grid) {
    this.windowPositions.delete(grid);
  }

  destroyGrid(grid) {
    this.windowPositions.delete(grid);
    const goneWindow = this.gridWindows.get(grid);
    this.gridWindows.delete(grid);
    if (goneWindow != null && ![...this.gridWindows.values()].includes(goneWindow)) {
      this.previewWindows.delete(goneWindow);
      this.grammarlyWindows.delete(goneWindow);
    }
    return goneWindow;
  }
}
