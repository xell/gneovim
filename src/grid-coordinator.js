// Applies normalized redraw operations to the session model and grid views.
// Browser-specific policy remains behind injected callbacks.
export class GridCoordinator {
  constructor({
    session,
    grids,
    gridFor,
    islandForGrid,
    reconcileIslands,
    isIslandGrid,
    onColors,
    onHighlight,
    onModeInfo,
    onTitle,
    forceRepaint,
    placeGridCursor,
    updateInputFocus,
  }) {
    this.session = session;
    this.grids = grids;
    this.gridFor = gridFor;
    this.islandForGrid = islandForGrid;
    this.reconcileIslands = reconcileIslands;
    this.isIslandGrid = isIslandGrid;
    this.onColors = onColors;
    this.onHighlight = onHighlight;
    this.onModeInfo = onModeInfo;
    this.onTitle = onTitle;
    this.forceRepaint = forceRepaint;
    this.placeGridCursor = placeGridCursor;
    this.updateInputFocus = updateInputFocus;
  }

  render(ops) {
    let dirty = new Set();
    let layoutDirty = false;
    for (const op of ops) {
      switch (op.op) {
        case "resize": {
          this.gridFor(op.grid).resize(op.w, op.h);
          dirty.add(op.grid);
          const position = this.session.positionForGrid(op.grid);
          if (position && (position.w !== op.w || position.h !== op.h)) {
            position.w = op.w;
            position.h = op.h;
            layoutDirty = true;
          }
          break;
        }
        case "clear":
          this.gridFor(op.grid).clear();
          dirty.add(op.grid);
          break;
        case "destroy": {
          const grid = this.grids.get(op.grid);
          if (grid) grid.el.remove();
          this.grids.delete(op.grid);
          this.session.destroyGrid(op.grid);
          layoutDirty = true;
          break;
        }
        case "line":
          this.gridFor(op.grid).line(op.row, op.col, op.cells);
          dirty.add(op.grid);
          break;
        case "scroll":
          this.gridFor(op.grid).scroll(op);
          dirty.add(op.grid);
          break;
        case "cursor":
          this.applyCursor(op);
          break;
        case "win_pos":
          this.session.placeGrid(
            op.grid,
            { srow: op.srow, scol: op.scol, w: op.w, h: op.h },
            op.win,
          );
          layoutDirty = true;
          break;
        case "win_float":
          this.placeFloat(op);
          layoutDirty = true;
          break;
        case "win_hide":
        case "win_close": {
          const grid = this.grids.get(op.grid);
          if (grid) grid.el.hidden = true;
          this.session.hideGrid(op.grid);
          layoutDirty = true;
          break;
        }
        case "msg_pos": {
          const messageGrid = this.grids.get(op.grid) || {};
          this.session.placeGrid(op.grid, {
            srow: op.row,
            scol: 0,
            w: messageGrid.cols || (this.grids.get(1) || {}).cols || 200,
            h: messageGrid.rows || 1,
            // Neovim keeps messages above every ordinary float.
            zindex: 1_000_000,
          });
          layoutDirty = true;
          break;
        }
        case "viewport":
          this.applyViewport(op);
          break;
        case "colors":
          dirty = new Set(this.onColors(op));
          break;
        case "hl":
          this.onHighlight(op.id, op.attr || {});
          break;
        case "mode":
          this.session.setMode(op.name, op.idx);
          break;
        case "mode_info":
          this.session.setModeInfo(op.modes);
          this.onModeInfo(!!op.enabled);
          break;
        case "title":
          this.onTitle(op.title || "gneovim");
          break;
        case "flush":
          break;
      }
    }

    if (layoutDirty) this.reconcileIslands();
    for (const id of dirty) {
      const grid = this.grids.get(id);
      if (grid && !this.isIslandGrid(id)) {
        grid.repaint();
        this.forceRepaint(grid.el);
      }
    }
    this.placeGridCursor();
    this.updateInputFocus();
  }

  applyCursor(op) {
    this.gridFor(op.grid).cursor = { row: op.row, col: op.col };
    if (op.grid === this.session.cursorGrid) return;
    const previous = this.islandForGrid(this.session.cursorGrid);
    this.session.moveGridCursor(op.grid);
    const next = this.islandForGrid(op.grid);
    if (previous && previous !== next) previous.clearCursor();
    if (next && next !== previous && this.session.lastCursor?.win === next.winId) {
      next.applyCursor(
        this.session.lastCursor.row,
        this.session.lastCursor.col,
        this.session.lastCursor.mode,
        this.session.lastCursor.scrolloff,
      );
    }
  }

  placeFloat(op) {
    const grid = this.grids.get(op.grid) || {};
    const width = grid.cols || 20;
    const height = grid.rows || 5;
    const anchorPosition =
      op.agrid != null && op.agrid !== 1
        ? this.session.positionForGrid(op.agrid)
        : null;
    let row = (anchorPosition ? anchorPosition.srow : 0) + (op.arow ?? 0);
    let col = (anchorPosition ? anchorPosition.scol : 0) + (op.acol ?? 0);
    const anchor = op.anchor || "NW";
    if (anchor[0] === "S") row -= height;
    if (anchor[1] === "E") col -= width;
    // Keep the anchor metadata. Layout later replaces row-based positioning
    // with an exact CodeMirror pixel lookup when the anchor is an island cursor.
    this.session.placeGrid(
      op.grid,
      {
        srow: Math.round(row),
        scol: Math.round(col),
        w: width,
        h: height,
        float: true,
        zindex: op.zindex ?? 50,
        floatAnchor: {
          agrid: op.agrid,
          arow: op.arow,
          anchorS: anchor[0] === "S",
        },
      },
      op.win,
    );
  }

  applyViewport(op) {
    const island = this.islandForGrid(op.grid);
    if (!island) return;
    island.scrollTo(op.topline, op.botline, op.linecount);
    // Viewport coordinates can trail the independent cursor notification.
    // Replay only the authoritative cursor payload.
    if (
      this.session.cursorGrid === op.grid &&
      this.session.lastCursor?.win === island.winId
    ) {
      island.applyCursor(
        this.session.lastCursor.row,
        this.session.lastCursor.col,
        this.session.lastCursor.mode,
        this.session.lastCursor.scrolloff,
      );
    }
  }
}
