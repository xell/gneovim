// Serializes cursor placement, buffer edit, and input requests for one island.
// This ordering matters when a click or accessibility selection is immediately
// followed by a key: Neovim must observe the cursor request first, and a typed
// replacement of an external selection must delete that selection before the
// replacement key arrives.
export class IslandInputQueue {
  constructor({ client, winId, log }) {
    this.client = client;
    this.winId = winId;
    this.log = log;
    this.pending = Promise.resolve();
    // Diagnostics only: requests not yet started, and those sent to Neovim
    // without an answer yet. A request that never settles blocks every later
    // one for this island, which would look exactly like a deaf island.
    this.waiting = 0;
    this.inflight = new Set();
  }

  describe(now) {
    const inflight = [...this.inflight].map(
      (entry) => `${entry.kind}@${Math.round(now - entry.at)}ms`,
    );
    return `waiting ${this.waiting}, unanswered [${inflight.join(" ")}]`;
  }

  cursor(row, col) {
    this.enqueue(
      () => this.client.cursorSet(this.winId, row, col),
      "island cursor set failed: ",
      "cursor",
    );
  }

  edit(buffer, regions) {
    this.enqueue(
      () => this.client.edit(buffer, regions),
      "island selection edit failed: ",
      "edit",
    );
  }

  input(keys) {
    this.enqueue(
      () => this.client.input(keys),
      "island input failed: ",
      "input",
    );
  }

  enqueue(request, failurePrefix, kind) {
    this.waiting += 1;
    this.pending = this.pending
      .then(() => {
        this.waiting -= 1;
        const entry = { kind, at: performance.now() };
        this.inflight.add(entry);
        let result;
        try {
          result = request();
        } catch (error) {
          this.inflight.delete(entry);
          throw error;
        }
        return Promise.resolve(result).finally(() =>
          this.inflight.delete(entry),
        );
      })
      .catch((error) => this.log(failurePrefix + error));
  }
}
