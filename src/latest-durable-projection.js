// Reactive shells for LatestDurableProjectionCore (`#lzlatestdurableprojection`).

import { LatestDurableProjectionCore } from "./latest-durable-projection-core.js";
import { AtomicMutex } from "./thread-safe.js";

export * from "./latest-durable-projection-core.js";

function requireContext(ctx, asyncReaders, name) {
  const computed = asyncReaders ? "computedAsync" : "computed";
  if (!ctx || typeof ctx[computed] !== "function" || typeof ctx.clearComputeds !== "function") {
    throw new TypeError(`${name} requires a compatible lazily context`);
  }
}

class LatestDurableProjectionShell {
  constructor(ctx, generation, { asyncReaders = false, mutex = null, name }) {
    requireContext(ctx, asyncReaders, name);
    this._ctx = ctx;
    this._core = new LatestDurableProjectionCore(generation);
    this._asyncReaders = asyncReaders;
    this._mutex = mutex;
    this._entryReaders = new Map();
    this._generationState = this._computed(() => this._read(() => this._core.generation));
    this._snapshotState = this._computed(() => this._read(() => this._core.snapshot()));
  }

  _computed(read) {
    return this._asyncReaders
      ? this._ctx.computedAsync(async () => read())
      : this._ctx.computed(read);
  }

  _read(body) {
    return this._mutex === null ? body() : this._mutex.runExclusive(body);
  }

  _transition(key, affectsGeneration, body) {
    const transition = this._read(() => {
      const before = this._core.version;
      const outcome = body();
      return { changed: this._core.version !== before, outcome };
    });
    if (!transition.changed) return transition.outcome;

    const roots = [this._snapshotState];
    if (affectsGeneration) {
      roots.push(this._generationState, ...this._entryReaders.values());
    } else {
      const reader = this._entryReaders.get(key);
      if (reader !== undefined) roots.push(reader);
    }
    this._ctx.clearComputeds(roots);
    return transition.outcome;
  }

  /** Reactive reader for the current sink generation. */
  get generationState() {
    return this._generationState;
  }

  /** Reactive reader for the complete keyed projection. */
  get snapshotState() {
    return this._snapshotState;
  }

  /** Mint or return the reactive reader for one key. */
  entryState(key) {
    let reader = this._entryReaders.get(key);
    if (reader === undefined) {
      reader = this._computed(() => this._read(() => this._core.entry(key)));
      this._entryReaders.set(key, reader);
    }
    return reader;
  }

  upsertDesired(key, epoch, value) {
    return this._transition(key, false, () => this._core.upsertDesired(key, epoch, value));
  }

  claim(key, generation) {
    return this._transition(key, false, () => this._core.claim(key, generation));
  }

  ackApplied(key, generation, epoch) {
    return this._transition(key, false, () => this._core.ackApplied(key, generation, epoch));
  }

  failRetryable(key, generation, epoch) {
    return this._transition(key, false, () => this._core.failRetryable(key, generation, epoch));
  }

  reconnect(newGeneration) {
    return this._transition(undefined, true, () => this._core.reconnect(newGeneration));
  }
}

/** Single-threaded Context flavor. */
export class LatestDurableProjection extends LatestDurableProjectionShell {
  constructor(ctx, generation = 0) {
    super(ctx, generation, { name: "LatestDurableProjection" });
  }
}

/** ThreadSafeContext flavor; the core lock is released before graph invalidation. */
export class ThreadSafeLatestDurableProjection extends LatestDurableProjectionShell {
  constructor(ctx, generation = 0, options = {}) {
    super(ctx, generation, {
      name: "ThreadSafeLatestDurableProjection",
      mutex: options.mutex ?? new AtomicMutex(),
    });
  }

  get mutex() {
    return this._mutex;
  }
}

/** AsyncContext flavor; transitions stay synchronous and readers materialize asynchronously. */
export class AsyncLatestDurableProjection extends LatestDurableProjectionShell {
  constructor(ctx, generation = 0) {
    super(ctx, generation, { asyncReaders: true, name: "AsyncLatestDurableProjection" });
  }
}
