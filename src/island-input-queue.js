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
  }

  cursor(row, col) {
    this.enqueue(
      () => this.client.cursorSet(this.winId, row, col),
      "island cursor set failed: ",
    );
  }

  edit(buffer, regions) {
    this.enqueue(
      () => this.client.edit(buffer, regions),
      "island selection edit failed: ",
    );
  }

  input(keys) {
    this.enqueue(
      () => this.client.input(keys),
      "island input failed: ",
    );
  }

  enqueue(request, failurePrefix) {
    this.pending = this.pending
      .then(request)
      .catch((error) => this.log(failurePrefix + error));
  }
}
