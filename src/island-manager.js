// Owns CodeMirror island identity and its refcounted bridge lifecycle.
export class IslandManager {
  constructor({
    session,
    nvim,
    createIsland,
    layout,
    repaintGrid,
    reportError,
    livePreviewDefault,
  }) {
    this.session = session;
    this.nvim = nvim;
    this.createIsland = createIsland;
    this.layout = layout;
    this.repaintGrid = repaintGrid;
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
        island.setOptimalWidth(this.session.optimalWidthForWindow(win));
      } else if (current.attaching) {
        // An attach is already in flight, so `bufnr` is still null and the
        // check below would start a second one with no detach to balance it.
        // One `:e` fires FileType, BufWinEnter and WinEnter, each landing
        // here before the first snapshot returns: measured 3 attaches for 1
        // detach, leaving the bridge holding a ref no island ever releases,
        // which is what made a dead attach outlive `:bdelete` (see
        // docs/markdown-island-fold-desync.md). Re-run this check once the
        // in-flight attach settles instead.
        current.reconcileAfterAttach = true;
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

    const nextGridIds = new Set(desired.values());
    const released = [...this.gridIds].filter((grid) => !nextGridIds.has(grid));
    this.gridIds = nextGridIds;
    this.layout();
    // GridCoordinator never repaints a grid an island covers, but it does keep
    // feeding every grid_line op into that grid's store. So a grid handed back
    // to the renderer here has a correct store and a stale DOM: entirely empty
    // when the window has been an island since it opened. That is what made the
    // first `:MarkdownLivePreviewOff` on a file show a blank window until some
    // unrelated redraw (moving the cursor, entering Visual) happened to mark the
    // grid dirty again, and why it only showed up once per window. The flag
    // arrives on its own `md_preview` notification, not inside a redraw batch,
    // so nothing is guaranteed to mark the grid dirty; repaint it at the
    // transition itself.
    for (const grid of released) this.repaintGrid(grid);
  }

  // Reattach one window's island from a fresh buffer snapshot, the same
  // detach-then-attach sequence reconcile(true) already does per window, but
  // without touching any other island. For a reload nvim_buf_attach cannot
  // see (`:checktime` / autoread / `:edit!`; see
  // docs/markdown-island-fold-desync.md) and has no reason to disturb a
  // window the user might be actively typing in elsewhere.
  resyncWindow(win) {
    const island = this.islands.get(win);
    if (!island) return;
    if (island.attaching) {
      // The in-flight snapshot may predate the reload; take a fresh one
      // after it settles rather than stacking a second attach on it.
      island.resyncAfterAttach = true;
      return;
    }
    const oldBuffer = island.bufnr;
    island.bufnr = null;
    if (oldBuffer != null) {
      this.nvim
        .detachIsland(oldBuffer)
        .catch((error) => this.reportError("island_detach failed: " + error));
    }
    this.attach(island);
  }

  attach(island) {
    const run = (async () => {
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
      } finally {
        if (island.attaching === run) island.attaching = null;
      }
      // Work that arrived while this attach was in flight (see reconcile and
      // resyncWindow). A resync wins: it implies the snapshot just applied
      // may already be stale.
      if (this.islands.get(island.winId) !== island) return;
      const resync = island.resyncAfterAttach;
      const reconcile = island.reconcileAfterAttach;
      island.resyncAfterAttach = false;
      island.reconcileAfterAttach = false;
      if (resync) this.resyncWindow(island.winId);
      else if (reconcile) this.reconcile();
    })();
    island.attaching = run;
    return run;
  }
}
