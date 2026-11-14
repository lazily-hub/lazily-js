// Reactive shells for EffectCasCore (`#lzeffectcas`).
//
// One `state` Computed projects the core's snapshot (pending, in-flight, retry,
// receipt, and terminal state for every key). Every transition runs on the core
// (under the core's own lock in the thread-safe flavor), RELEASES that lock, and
// only then invalidates the reader — a no-op, stale-generation, unknown-attempt,
// or duplicate-receipt transition invalidates nothing. Scheduling observes
// `pendingKeys(now)` and invokes the application adapter OUTSIDE any lock.
//
// Mirrors `lazily-rs/src/thread_safe_effect_cas.rs`; the single-threaded and
// async flavors follow the same shape as `./latest-durable-projection.js`.

import { EffectCasCore } from "./effect-cas-core.js";
import { AtomicMutex } from "./thread-safe.js";

export * from "./effect-cas-core.js";

function requireContext(ctx, asyncReaders, name) {
  const computed = asyncReaders ? "computedAsync" : "computed";
  if (!ctx || typeof ctx[computed] !== "function" || typeof ctx.clearComputeds !== "function") {
    throw new TypeError(`${name} requires a compatible lazily context`);
  }
}

class EffectCasShell {
  constructor(ctx, generation, options, { asyncReaders, mutex, name }) {
    requireContext(ctx, asyncReaders, name);
    this._ctx = ctx;
    this._core = new EffectCasCore(generation, options);
    this._asyncReaders = asyncReaders;
    this._mutex = mutex;
    const read = () => this._locked(() => this._core.snapshot());
    this._state = asyncReaders ? ctx.computedAsync(async () => read()) : ctx.computed(read);
  }

  _locked(body) {
    return this._mutex === null ? body() : this._mutex.runExclusive(body);
  }

  _transition(body) {
    const { change, outcome } = this._locked(body);
    if (change.state) this._ctx.clearComputeds([this._state]);
    return outcome;
  }

  /** Reactive reader for the complete keyed snapshot. */
  get stateHandle() {
    return this._state;
  }

  /** Read the snapshot (a Promise in the async flavor). */
  snapshot() {
    return this._asyncReaders ? this._ctx.getAsync(this._state) : this._ctx.get(this._state);
  }

  get generation() {
    return this._locked(() => this._core.generation);
  }

  pendingKeys(now) {
    return this._locked(() => this._core.pendingKeys(now));
  }

  /** The full-fidelity durable image (`#lzeffectcasdurable`). */
  durableState() {
    return this._locked(() => this._core.durableState());
  }

  upsertDesired(intent) {
    return this._transition(() => this._core.upsertDesired(intent));
  }

  claim(key, generation, now) {
    return this._transition(() => this._core.claim(key, generation, now));
  }

  recordApplied(key, attempt, receipt, authority) {
    return this._transition(() => this._core.recordApplied(key, attempt, receipt, authority));
  }

  recordSuperseded(key, attempt, observed) {
    return this._transition(() => this._core.recordSuperseded(key, attempt, observed));
  }

  recordRetryable(key, attempt, error, retryAt) {
    return this._transition(() => this._core.recordRetryable(key, attempt, error, retryAt));
  }

  recordRejected(key, attempt, error) {
    return this._transition(() => this._core.recordRejected(key, attempt, error));
  }

  recordOutcome(key, attempt, apply, retryAt) {
    return this._transition(() => this._core.recordOutcome(key, attempt, apply, retryAt));
  }

  reconnect(newGeneration) {
    return this._transition(() => this._core.reconnect(newGeneration));
  }
}

/** Single-threaded Context flavor. */
export class EffectCas extends EffectCasShell {
  constructor(ctx, generation = 0, options = {}) {
    super(ctx, generation, options, { asyncReaders: false, mutex: null, name: "EffectCas" });
  }
}

/** ThreadSafeContext flavor; the core lock is released before graph invalidation. */
export class ThreadSafeEffectCas extends EffectCasShell {
  constructor(ctx, generation = 0, options = {}) {
    super(ctx, generation, options, {
      asyncReaders: false,
      mutex: options.mutex ?? new AtomicMutex(),
      name: "ThreadSafeEffectCas",
    });
  }

  get mutex() {
    return this._mutex;
  }
}

/** AsyncContext flavor; transitions stay synchronous and the reader materializes asynchronously. */
export class AsyncEffectCas extends EffectCasShell {
  constructor(ctx, generation = 0, options = {}) {
    super(ctx, generation, options, { asyncReaders: true, mutex: null, name: "AsyncEffectCas" });
  }
}
