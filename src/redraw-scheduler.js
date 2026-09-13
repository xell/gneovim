// Coalesces ordered Neovim redraw batches into browser animation frames.
export class RedrawScheduler {
  constructor({ requestFrame, render }) {
    this.requestFrame = requestFrame;
    this.render = render;
    this.pending = [];
    this.scheduled = false;
    this.flush = this.flush.bind(this);
  }

  enqueue(ops) {
    for (const op of ops) this.pending.push(op);
    if (!this.scheduled) {
      this.scheduled = true;
      this.requestFrame(this.flush);
    }
  }

  flush() {
    this.scheduled = false;
    const ops = this.pending;
    this.pending = [];
    this.render(ops);
  }
}
