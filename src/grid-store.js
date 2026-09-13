// Pure Neovim multigrid cell storage. DOM painting is deliberately separate so
// redraw semantics can be tested without a browser.
export class GridStore {
  constructor() {
    this.cols = 0;
    this.rows = 0;
    this.cells = [];
  }

  resize(width, height) {
    const old = this.cells;
    this.cells = Array.from({ length: height }, (_, row) =>
      Array.from({ length: width }, (_, col) =>
        old[row] && old[row][col] ? old[row][col] : [" ", 0],
      ),
    );
    this.cols = width;
    this.rows = height;
  }

  clear() {
    this.cells = Array.from({ length: this.rows }, () =>
      Array.from({ length: this.cols }, () => [" ", 0]),
    );
  }

  line(row, col, cells) {
    const target = this.cells[row];
    if (!target) return false;
    let highlight = 0;
    let column = col;
    for (const [text, cellHighlight, repeat] of cells) {
      if (cellHighlight != null) highlight = cellHighlight;
      const count = repeat ?? 1;
      for (let index = 0; index < count && column < this.cols; index++) {
        target[column++] = [text, highlight];
      }
    }
    return true;
  }

  scroll({ top, bot, left, right, rows }) {
    if (!rows || bot <= top) return false;
    const move = (from, to) => {
      for (let col = left; col < right; col++) {
        this.cells[to][col] = this.cells[from][col];
      }
    };
    if (rows > 0) {
      for (let row = top + rows; row < bot; row++) move(row, row - rows);
    } else {
      for (let row = bot - 1 + rows; row >= top; row--) move(row, row - rows);
    }
    return true;
  }
}
