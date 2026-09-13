// Owns CodeMirror island identity and its refcounted bridge lifecycle.
export class IslandManager {
  constructor({
    session,
    nvim,
    createIsland,
    layout,
    reportError,
    livePreviewDefault,
  }) {
    this.session = session;
    this.nvim = nvim;
    this.createIsland = createIsland;
    this.layout = layout;
    this.reportError = reportError;
    this.getLivePreviewDefault = livePreviewDefault;
    this.islands = new Map();
    this.gridIds = new Set();
  }

  values() {
    return this.islands.values();
  }

  get(win) {
    return this.islands.get(win);
  }

  forGrid(grid) {
    return this.islands.get(this.session.windowForGrid(grid));
  }

  reconcile(force = false) {
    const desired = this.session.desiredIslands(this.getLivePreviewDefault());

    for (const [win, island] of [...this.islands]) {
      if (!desired.has(win)) {
        this.islands.delete(win);
        const buffer = island.bufnr;
        island.destroy();
        if (buffer != null) {
          this.nvim
            .detachIsland(buffer)
            .catch((error) => this.reportError("island_detach failed: " + error));
        }
      }
    }

    for (const win of desired.keys()) {
      const current = this.islands.get(win);
      const wantedBuffer = this.session.bufferForWindow(win);
      if (!current) {
        const island = this.createIsland(win);
        this.islands.set(win, island);
        this.attach(island);
        const gutter = this.session.gutterForWindow(win);
        if (gutter) island.setGutter(gutter);
      } else if (force || (wantedBuffer != null && current.bufnr !== wantedBuffer)) {
        const oldBuffer = current.bufnr;
        current.bufnr = null;
        if (oldBuffer != null) {
          this.nvim
            .detachIsland(oldBuffer)
            .catch((error) => this.reportError("island_detach failed: " + error));
        }
        this.attach(current);
      }
    }

    this.gridIds = new Set(desired.values());
    this.layout();
  }

  async attach(island) {
    try {
      const snapshot = await this.nvim.attachIsland(island.winId);
      if (this.islands.get(island.winId) !== island) {
        try {
          await this.nvim.detachIsland(snapshot.buf);
        } catch (error) {
          this.reportError("abandoned island_detach failed: " + error);
        }
        return;
      }
      island.bufnr = snapshot.buf;
      island.applyReset(snapshot);
      this.layout();
      this.nvim.refreshMarkdownDecorations().catch(() => {});
    } catch (error) {
      this.reportError("island_attach failed: " + error);
    }
  }
}
