// Async reactive graph (lazily-spec/docs/async.md) — the native JavaScript
// counterpart of lazily-rs's `AsyncContext` and lazily-kt's `AsyncContext`.
//
// This is a SEPARATE reactive surface from `./reactive`, not an overload: async
// derivations introduce in-flight state, revision-guarded stale-completion
// discard, in-flight deduplication, cancellation, and dependency tracking across
// `await` suspension points that the synchronous graph does not have. Cells are
// the synchronous input layer; only computed slots, memos, and effects are async.
//
// Because JavaScript is single-threaded and cooperatively scheduled, this port
// drops the lazily-rs locking and id-generation guards: a synchronous section
// between two `await`s is atomic, so revision-check-then-publish needs no lock,
// and GC'd handle objects mean an in-flight run can never write into a recycled
// slot. What carries over is the *observable* contract: the Empty/Computing/
// Resolved/Error state machine, revision-guarded publish, one in-flight compute
// per revision shared by all waiters, cooperative abort on supersession/dispose,
// and cleanup-before-rerun ordering for effects.

function defaultEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((k) => Object.prototype.hasOwnProperty.call(b, k)) &&
    aKeys.every((k) => defaultEqual(a[k], b[k]))
  );
}

// -- Handles -----------------------------------------------------------------

export class AsyncCellHandle {
  /** @internal */ constructor(id) {
    this.id = id;
    Object.freeze(this);
  }
}

export class AsyncSlotHandle {
  /** @internal */ constructor(id) {
    this.id = id;
    Object.freeze(this);
  }
}

export class AsyncEffectHandle {
  /** @internal */ constructor(id) {
    this.id = id;
    Object.freeze(this);
  }
}

export class AsyncSignalHandle {
  /** @internal */ constructor(slot, effect) {
    this.slot = slot;
    this.effect = effect;
    Object.freeze(this);
  }
}

// -- Completion notifier (one per in-flight compute) -------------------------
//
// Every waiter attached to an in-flight compute awaits the same notifier. The
// compute settles it exactly once with a resolved value, an error, or a
// `superseded` signal ("the world changed — re-resolve from current state").

function makeNotifier() {
  let resolveFn;
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
  });
  return {
    promise,
    done: false,
    settle(event) {
      if (!this.done) {
        this.done = true;
        resolveFn(event);
      }
    },
  };
}

// -- Nodes -------------------------------------------------------------------

class AsyncCellNode {
  constructor(value) {
    this.value = value;
    this.dependents = new Set();
  }
}

class AsyncSlotNode {
  constructor(compute, memo) {
    this.compute = compute;
    this.memo = memo; // equality-guarded recompute
    this.state = "empty"; // empty | computing | resolved | error
    this.value = undefined;
    this.hasValue = false;
    this.error = undefined;
    this.revision = 0;
    this.token = null; // current in-flight token { revision, aborted }
    this.abort = null; // AbortController for the in-flight compute
    this.notifier = null; // completion notifier for the in-flight compute
    this.dependencies = new Set();
    this.dependents = new Set();
  }
}

class AsyncEffectNode {
  constructor(run) {
    this.run = run;
    this.dependencies = new Set();
    this.cleanup = null; // cleanup fn from the last completed body
    this.abort = null; // AbortController for the in-flight body
    this.pending = false; // a rerun is queued
    this.kicking = false; // the serialized run loop is active
  }
}

// -- Context -----------------------------------------------------------------

export class AsyncContext {
  #nodes = new Map();
  #nextId = 1;
  #inflight = new Map(); // slotId -> Promise of the current compute task
  #effectRuns = new Set(); // in-flight effect run-loop promises
  #batchDepth = 0;
  #batchedCells = new Set();

  // -- Creation ----------------------------------------------------------

  cell(value) {
    const id = this.#allocId();
    this.#nodes.set(id, new AsyncCellNode(value));
    return new AsyncCellHandle(id);
  }

  computedAsync(compute) {
    const id = this.#allocId();
    this.#nodes.set(id, new AsyncSlotNode(compute, false));
    return new AsyncSlotHandle(id);
  }

  memoAsync(compute) {
    const id = this.#allocId();
    this.#nodes.set(id, new AsyncSlotNode(compute, true));
    return new AsyncSlotHandle(id);
  }

  effectAsync(run) {
    const id = this.#allocId();
    this.#nodes.set(id, new AsyncEffectNode(run));
    this.#scheduleEffect(id);
    return new AsyncEffectHandle(id);
  }

  signalAsync(compute) {
    const slotId = this.#allocId();
    this.#nodes.set(slotId, new AsyncSlotNode(compute, true));
    const slot = new AsyncSlotHandle(slotId);
    const effectId = this.#allocId();
    this.#nodes.set(
      effectId,
      new AsyncEffectNode(async (cctx) => {
        await cctx.getAsync(slot);
        return null;
      }),
    );
    this.#scheduleEffect(effectId);
    return new AsyncSignalHandle(slot, new AsyncEffectHandle(effectId));
  }

  // -- Cells (synchronous input layer) -----------------------------------

  getCell(handle) {
    const node = this.#nodes.get(handle.id);
    if (!(node instanceof AsyncCellNode)) {
      throw new Error(`get_cell on non-cell id ${handle.id}`);
    }
    return node.value;
  }

  setCell(handle, value) {
    const node = this.#nodes.get(handle.id);
    if (!(node instanceof AsyncCellNode)) {
      throw new Error(`set_cell on non-cell id ${handle.id}`);
    }
    if (defaultEqual(node.value, value)) {
      return;
    }
    node.value = value;
    if (this.#batchDepth > 0) {
      this.#batchedCells.add(handle.id);
      return;
    }
    this.#invalidateCellDependents(handle.id);
  }

  // -- Slot reads --------------------------------------------------------

  /** Synchronous snapshot: the resolved value, or `undefined` if not resolved. */
  get(handle) {
    const node = this.#nodes.get(handle.id);
    if (node instanceof AsyncSlotNode && node.state === "resolved") {
      return node.value;
    }
    return undefined;
  }

  isResolved(handle) {
    const node = this.#nodes.get(handle.id);
    return node instanceof AsyncSlotNode && node.state === "resolved";
  }

  /** Public projection of the slot state machine (AsyncSlotStateView). */
  slotState(handle) {
    const node = this.#nodes.get(handle.id);
    if (!(node instanceof AsyncSlotNode)) {
      return "none";
    }
    return node.state;
  }

  /**
   * Await a slot value. Uses the synchronous `get()` fast path for resolved
   * slots; otherwise attaches to the single in-flight compute for the current
   * revision, or spawns one. Re-resolves through both benign race windows
   * (resolved-since-get, notifier-dropped) rather than asserting.
   */
  async getAsync(handle) {
    const id = handle.id;
    // Outer re-resolve loop: slot state is authoritative.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const node = this.#nodes.get(id);
      if (!(node instanceof AsyncSlotNode)) {
        throw new Error(`get_async on non-slot id ${id}`);
      }
      if (node.state === "resolved") {
        return node.value; // fast path (and benign window 1: resolved-since-get)
      }
      let notifier;
      if (node.state === "computing") {
        notifier = node.notifier;
      } else {
        // empty or error: spawn a fresh compute for the current revision.
        notifier = this.#spawnCompute(id);
      }
      const event = await notifier.promise;
      if (event.kind === "resolved") {
        return event.value;
      }
      if (event.kind === "error") {
        throw event.error;
      }
      // superseded (benign window 2): the world changed — re-resolve.
    }
  }

  getSignal(handle) {
    return this.get(handle.slot);
  }

  getSignalAsync(handle) {
    return this.getAsync(handle.slot);
  }

  // -- Dispose -----------------------------------------------------------

  async disposeAsyncEffect(handle) {
    const id = handle.id;
    const node = this.#nodes.get(id);
    if (!(node instanceof AsyncEffectNode)) {
      return;
    }
    // Remove pending reruns and abort any in-flight body first, then await the
    // current cleanup before removing the node.
    node.pending = false;
    if (node.abort) {
      node.abort.abort();
    }
    // Wait for the serialized run loop to quiesce so cleanup ordering holds.
    while (node.kicking) {
      await Promise.resolve();
      // Re-fetch: dispose may race the loop's own completion.
      if (!(this.#nodes.get(id) instanceof AsyncEffectNode)) {
        return;
      }
    }
    for (const dep of [...node.dependencies]) {
      this.#removeDependentEdge(dep, id);
    }
    const cleanup = node.cleanup;
    node.cleanup = null;
    this.#nodes.delete(id);
    if (typeof cleanup === "function") {
      await cleanup();
    }
  }

  isEffectActive(handle) {
    return this.#nodes.get(handle.id) instanceof AsyncEffectNode;
  }

  disposeSignal(handle) {
    return this.disposeAsyncEffect(handle.effect);
  }

  isSignalActive(handle) {
    return this.isEffectActive(handle.effect);
  }

  /** Dispose the whole context: abort every in-flight compute and effect body,
   * then await all active effect cleanups. */
  async dispose() {
    for (const [id, node] of this.#nodes) {
      if (node instanceof AsyncSlotNode && node.state === "computing") {
        node.token.aborted = true;
        if (node.abort) {
          node.abort.abort();
        }
        node.notifier.settle({ kind: "superseded" });
        this.#inflight.delete(id);
      } else if (node instanceof AsyncEffectNode) {
        node.pending = false;
        if (node.abort) {
          node.abort.abort();
        }
      }
    }
    await this.settle();
    const cleanups = [];
    for (const node of this.#nodes.values()) {
      if (node instanceof AsyncEffectNode && typeof node.cleanup === "function") {
        cleanups.push(node.cleanup);
        node.cleanup = null;
      }
    }
    for (const cleanup of cleanups) {
      await cleanup();
    }
  }

  // -- Batch -------------------------------------------------------------

  batch(run) {
    this.#batchDepth++;
    try {
      run();
    } finally {
      this.#batchDepth--;
      if (this.#batchDepth === 0) {
        const cells = [...this.#batchedCells];
        this.#batchedCells.clear();
        for (const id of cells) {
          this.#invalidateCellDependents(id);
        }
      }
    }
  }

  /** Await all scheduled effect reruns and in-flight computes until the graph
   * quiesces. Deterministic anchor for tests and for eager-signal materialization
   * (async reruns settle on the executor, not synchronously in `setCell`). */
  async settle() {
    while (this.#effectRuns.size > 0 || this.#inflight.size > 0) {
      await Promise.allSettled([...this.#effectRuns, ...this.#inflight.values()]);
    }
  }

  // -- Internals: ids + edges -------------------------------------------

  #allocId() {
    return this.#nextId++;
  }

  #registerDependency(depId, ownerId) {
    const dep = this.#nodes.get(depId);
    if (dep instanceof AsyncCellNode || dep instanceof AsyncSlotNode) {
      dep.dependents.add(ownerId);
    }
    const owner = this.#nodes.get(ownerId);
    if (owner instanceof AsyncSlotNode || owner instanceof AsyncEffectNode) {
      owner.dependencies.add(depId);
    }
  }

  #removeDependentEdge(depId, ownerId) {
    const dep = this.#nodes.get(depId);
    if (dep instanceof AsyncCellNode || dep instanceof AsyncSlotNode) {
      dep.dependents.delete(ownerId);
    }
  }

  // A compute/effect callback receives this context. Dependency edges register
  // synchronously, BEFORE the awaited read, so a source invalidation while the
  // future is suspended supersedes the in-flight compute before it publishes.
  #makeComputeContext(ownerId, signal) {
    const self = this;
    return {
      signal,
      getCell(handle) {
        self.#registerDependency(handle.id, ownerId);
        return self.getCell(handle);
      },
      getAsync(handle) {
        self.#registerDependency(handle.id, ownerId);
        return self.getAsync(handle);
      },
      getSignalAsync(handle) {
        self.#registerDependency(handle.slot.id, ownerId);
        return self.getAsync(handle.slot);
      },
    };
  }

  // -- Internals: slot compute ------------------------------------------

  #spawnCompute(id) {
    const node = this.#nodes.get(id);
    // Clear old dependency edges; they are rediscovered live during compute.
    for (const dep of [...node.dependencies]) {
      this.#removeDependentEdge(dep, id);
    }
    node.dependencies.clear();

    const token = { revision: node.revision, aborted: false };
    const controller = new AbortController();
    const notifier = makeNotifier();
    node.state = "computing";
    node.hasValue = false;
    node.token = token;
    node.abort = controller;
    node.notifier = notifier;

    const cctx = this.#makeComputeContext(id, controller.signal);
    const task = Promise.resolve()
      .then(() => node.compute(cctx))
      .then(
        (value) => this.#publishResolved(id, token, notifier, value),
        (error) => this.#publishError(id, token, notifier, error),
      )
      .finally(() => {
        this.#inflight.delete(id);
      });
    this.#inflight.set(id, task);
    return notifier;
  }

  #publishResolved(id, token, notifier, value) {
    const node = this.#nodes.get(id);
    if (!(node instanceof AsyncSlotNode) || token.aborted || node.revision !== token.revision) {
      // Stale completion: discard, never publish. Waiters re-resolve.
      notifier.settle({ kind: "superseded" });
      return;
    }
    // Propagation is eager at the mutation boundary: `setCell` -> `#invalidateSlot`
    // already cascaded to the whole transitive dependent subtree (slots -> empty,
    // effects -> rescheduled), so dependents re-pull the new value on their next
    // read. Publishing does not re-propagate. The `memo` equality guard keeps the
    // cached value stable but, per the async contract, does not suppress the
    // force-rerun of dependents that the invalidation cascade already scheduled.
    node.state = "resolved";
    node.value = value;
    node.hasValue = true;
    node.error = undefined;
    node.token = null;
    node.abort = null;
    node.notifier = null;
    notifier.settle({ kind: "resolved", value });
  }

  #publishError(id, token, notifier, error) {
    const node = this.#nodes.get(id);
    if (!(node instanceof AsyncSlotNode) || token.aborted || node.revision !== token.revision) {
      notifier.settle({ kind: "superseded" });
      return;
    }
    node.state = "error";
    node.error = error;
    node.hasValue = false;
    node.token = null;
    node.abort = null;
    node.notifier = null;
    notifier.settle({ kind: "error", error });
  }

  // -- Internals: invalidation ------------------------------------------

  #invalidateCellDependents(id) {
    const node = this.#nodes.get(id);
    if (!(node instanceof AsyncCellNode)) {
      return;
    }
    for (const d of [...node.dependents]) {
      this.#invalidateDependent(d);
    }
  }

  #invalidateDependent(id) {
    const node = this.#nodes.get(id);
    if (node instanceof AsyncEffectNode) {
      this.#scheduleEffect(id);
    } else if (node instanceof AsyncSlotNode) {
      this.#invalidateSlot(id);
    }
  }

  #invalidateSlot(id) {
    const node = this.#nodes.get(id);
    if (!(node instanceof AsyncSlotNode)) {
      return;
    }
    node.revision++;
    if (node.state === "computing") {
      // Supersede the in-flight compute: abort it and release its waiters so
      // they re-resolve against the new revision.
      node.token.aborted = true;
      if (node.abort) {
        node.abort.abort();
      }
      node.notifier.settle({ kind: "superseded" });
      this.#inflight.delete(id);
      node.abort = null;
      node.notifier = null;
      node.token = null;
    }
    node.state = "empty";
    node.hasValue = false;
    // Cascade to this slot's dependents (lazy slots go empty; effects reschedule).
    for (const d of [...node.dependents]) {
      this.#invalidateDependent(d);
    }
  }

  // -- Internals: async effects (serialized, cleanup-before-body) --------

  #scheduleEffect(id) {
    const node = this.#nodes.get(id);
    if (!(node instanceof AsyncEffectNode)) {
      return;
    }
    node.pending = true;
    if (node.kicking) {
      // A run loop is already active; it will pick up the rerun after the
      // current body (and its cleanup) finish. Reruns are serialized.
      return;
    }
    node.kicking = true;
    // Start the run loop on a microtask, NOT synchronously: all cell writes in
    // the current synchronous pass (e.g. inside a `batch`) coalesce into a single
    // `pending` flag before the body runs, so a batch triggers exactly one rerun.
    const run = Promise.resolve().then(async () => {
      try {
        while (node.pending && this.#nodes.get(id) === node) {
          node.pending = false;
          await this.#runEffectOnce(id);
        }
      } finally {
        node.kicking = false;
      }
    });
    this.#effectRuns.add(run);
    run.finally(() => this.#effectRuns.delete(run));
  }

  async #runEffectOnce(id) {
    const node = this.#nodes.get(id);
    if (!(node instanceof AsyncEffectNode)) {
      return;
    }
    // Cleanup of the previous body completes before the next body starts.
    if (typeof node.cleanup === "function") {
      const cleanup = node.cleanup;
      node.cleanup = null;
      await cleanup();
    }
    if (this.#nodes.get(id) !== node) {
      return; // disposed during cleanup
    }
    for (const dep of [...node.dependencies]) {
      this.#removeDependentEdge(dep, id);
    }
    node.dependencies.clear();
    const controller = new AbortController();
    node.abort = controller;
    const cctx = this.#makeComputeContext(id, controller.signal);
    let nextCleanup;
    try {
      nextCleanup = await node.run(cctx);
    } catch (error) {
      if (!controller.signal.aborted) {
        node.lastError = error;
      }
      return;
    } finally {
      if (node.abort === controller) {
        node.abort = null;
      }
    }
    const current = this.#nodes.get(id);
    if (current instanceof AsyncEffectNode) {
      current.cleanup = typeof nextCleanup === "function" ? nextCleanup : null;
    } else if (typeof nextCleanup === "function") {
      await nextCleanup(); // disposed mid-run: run the fresh cleanup immediately
    }
  }
}
