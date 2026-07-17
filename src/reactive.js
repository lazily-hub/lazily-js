// Reactive dependency graph (lazily-spec/docs/reactive-graph.md) — the native
// JavaScript counterpart of lazily-kt's `Context` and lazily-rs's `Context`.
//
// The reactive family is Slot (lazy memoized derived) → Cell (mutable source)
// → Signal (eager derived), plus Effect (side-effecting observer). Reading a
// cell/slot/signal inside a computation auto-registers a dependency edge;
// mutating a cell invalidates dependents.
//
// - Lazy slots mark dirty on invalidation and recompute on the next read
//   (pull-based, glitch-free: a slot always observes consistent inputs).
// - Cells use a `==` (PartialEq) guard: setting an equal value is a no-op.
// - `memo` adds a `==` guard so an equal recompute suppresses downstream.
// - Signals are eager: a backing memo slot plus a puller effect — the value is
//   re-materialized by the time the invalidating `setCell`/`batch` returns.
// - Effects rerun after any tracked dependency invalidates.

export function defaultEqual(a, b) {
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
  // #lzjsshalloweq: fast path for plain arrays — Array.isArray + length check
  // before Object.keys, index loop, no closure allocation.
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = a.length;
    if (n !== b.length) {
      return false;
    }
    for (let i = 0; i < n; i++) {
      if (!defaultEqual(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  for (let i = 0; i < aKeys.length; i++) {
    const k = aKeys[i];
    if (!(k in b) || !defaultEqual(a[k], b[k])) {
      return false;
    }
  }
  return true;
}

// -- Handles -----------------------------------------------------------------

export class SlotHandle {
  /** @internal */ constructor(id) {
    this.id = id;
    Object.freeze(this);
  }
}

export class CellHandle {
  /** @internal */ constructor(id) {
    this.id = id;
    Object.freeze(this);
  }
}

export class EffectHandle {
  /** @internal */ constructor(id) {
    this.id = id;
    Object.freeze(this);
  }
}

export class SignalHandle {
  /** @internal */ constructor(slot, effect) {
    this.slot = slot;
    this.effect = effect;
    Object.freeze(this);
  }
}

// -- Context -----------------------------------------------------------------

function edgeInsert(edges, id) {
  for (let i = 0; i < edges.length; i++) {
    if (edges[i] === id) {
      return false;
    }
  }
  edges.push(id);
  return true;
}

function edgeRemove(edges, id) {
  for (let i = 0; i < edges.length; i++) {
    if (edges[i] === id) {
      edges[i] = edges[edges.length - 1];
      edges.pop();
      return true;
    }
  }
  return false;
}

class CellNode {
  constructor(value) {
    this.value = value;
    this.dependents = null; // #lzjslazyedges: allocated on first edge
  }
}

class SlotNode {
  constructor(compute, memo) {
    this.value = undefined;
    this.hasValue = false;
    this.memo = memo;
    this.compute = compute;
    this.dependencies = null; // #lzjslazyedges: allocated on first edge
    this.dependents = null; // #lzjslazyedges: allocated on first edge
    this.dirty = false;
    this.forceRecompute = false;
    this.inProgress = false;
  }
}

class EffectNode {
  constructor(run) {
    this.run = run;
    this.dependencies = null; // #lzjslazyedges: allocated on first edge
    this.cleanup = null;
    this.forceRun = false;
  }
}

export class Context {
  #nodes = [];
  #nextId = 1;
  #freeIds = [];
  #trackingStack = [];
  #pendingEffects = [];
  #pendingHead = 0;
  #scheduledEffects = new Set();
  #flushingEffects = false;
  #batchDepth = 0;
  #batchedCells = new Set();
  // Reusable scratch buffers for #markFrontier (#lzjsscratchfrontier): avoid
  // per-invalidation array allocation by clearing in place. Safe under
  // reentrancy because callers fully consume the returned effects array before
  // #flushEffects can re-enter #markFrontier (guarded by #flushingEffects).
  #frontierEffects = [];
  #frontierStack = [];
  #frontierForceStack = [];
  // Opt-in instrumentation (off by default → zero steady-state overhead, so the
  // committed BENCHMARKS.md numbers are unperturbed). Mirrors the counter subset
  // of lazily-rs's `InstrumentationSnapshot` that is meaningful single-threaded.
  #instrument = false;
  #counters = null;

  /**
   * @param {{ instrument?: boolean }} [opts] pass `{ instrument: true }` to
   *   accumulate reactive-core counters readable via
   *   {@link Context#instrumentationSnapshot}.
   */
  constructor(opts = {}) {
    if (opts && opts.instrument === true) {
      this.#instrument = true;
      this.#counters = this.#zeroCounters();
    }
  }

  #zeroCounters() {
    return {
      nodeAllocations: 0,
      slotRecomputes: 0,
      dependencyEdgesAdded: 0,
      dependencyEdgesRemoved: 0,
      effectQueuePushes: 0,
      maxEffectQueueDepth: 0,
    };
  }

  /**
   * A snapshot of the reactive-core instrumentation counters, or `null` when
   * instrumentation was not enabled at construction.
   * @returns {{ nodeAllocations: number, slotRecomputes: number, dependencyEdgesAdded: number, dependencyEdgesRemoved: number, effectQueuePushes: number, maxEffectQueueDepth: number } | null}
   */
  instrumentationSnapshot() {
    return this.#counters ? { ...this.#counters } : null;
  }

  /** Zero the instrumentation counters (no-op when instrumentation is off). */
  resetInstrumentation() {
    if (this.#counters) {
      this.#counters = this.#zeroCounters();
    }
  }

  // -- Creation ----------------------------------------------------------

  cell(value) {
    return new CellHandle(this.#cellAny(value));
  }

  #cellAny(value) {
    const id = this.#allocId();
    this.#nodes[id] = new CellNode(value);
    return id;
  }

  computed(compute) {
    return new SlotHandle(this.#slotAny(false, compute));
  }

  slot(compute) {
    return this.computed(compute);
  }

  memo(compute) {
    return new SlotHandle(this.#slotAny(true, compute));
  }

  #slotAny(memo, compute) {
    const id = this.#allocId();
    this.#nodes[id] = new SlotNode(compute, memo);
    return id;
  }

  signal(compute) {
    const slot = this.#slotAny(true, compute);
    const effect = this.#effectAny(() => {
      this.#getSlotAny(slot);
      return null;
    });
    return new SignalHandle(new SlotHandle(slot), new EffectHandle(effect));
  }

  effect(run) {
    return new EffectHandle(this.#effectAny(run));
  }

  #effectAny(run) {
    const id = this.#allocId();
    const node = new EffectNode(run);
    node.forceRun = true; // force the initial run on registration
    this.#nodes[id] = node;
    this.#scheduleEffect(id, false);
    this.#flushEffects();
    return id;
  }

  // -- Read --------------------------------------------------------------

  get(handle) {
    return this.#getSlotAny(handle.id);
  }

  getCell(handle) {
    return this.#getCellAny(handle.id);
  }

  getSignal(handle) {
    return this.get(handle.slot);
  }

  #getSlotAny(id) {
    const frame = this.#currentFrame();
    if (frame !== undefined) {
      this.#registerDependency(id, frame);
    }
    this.#refreshSlot(id);
    const node = this.#nodes[id];
    if (!(node instanceof SlotNode) || !node.hasValue) {
      throw new Error(`slot ${id} has no value`);
    }
    return node.value;
  }

  #getCellAny(id) {
    const frame = this.#currentFrame();
    if (frame !== undefined) {
      this.#registerDependency(id, frame);
    }
    const node = this.#nodes[id];
    if (!(node instanceof CellNode)) {
      throw new Error(`get_cell on non-cell id ${id}`);
    }
    return node.value;
  }

  // -- Write -------------------------------------------------------------

  setCell(handle, value) {
    this.#setCellAny(handle.id, value);
  }

  #setCellAny(id, value) {
    const node = this.#nodes[id];
    if (!(node instanceof CellNode)) {
      throw new Error(`set_cell on non-cell id ${id}`);
    }
    if (!defaultEqual(node.value, value)) {
      node.value = value;
      if (this.#isBatching()) {
        this.#batchedCells.add(id);
      } else {
        // Store-without-cascade: the new value is stored above (so a late
        // subscriber reads it glitch-free) and lazy Slot dependents are
        // dirty-marked, but the effect flush runs ONLY when the dependent cone
        // actually contains an Effect. A cell with no active reactor pays no
        // flush — the write side of the merge cost law
        // (relaycell-backpressure-analysis.md §4.0 / §5).
        if (this.#invalidateCellDependentsNow(id)) {
          this.#flushEffects();
        }
      }
    }
  }

  // -- Batch -------------------------------------------------------------

  batch(run) {
    this.#batchDepth++;
    try {
      run();
    } finally {
      this.#finishBatch();
    }
  }

  #finishBatch() {
    if (this.#batchDepth <= 0) {
      throw new Error("finishBatch without active batch");
    }
    this.#batchDepth--;
    if (this.#batchDepth === 0) {
      this.#flushBatched();
    }
  }

  #flushBatched() {
    const cells = this.#batchedCells;
    this.#batchedCells = new Set();
    const roots = [];
    for (const id of cells) {
      const node = this.#nodes[id];
      if (node instanceof CellNode) {
        const deps = node.dependents;
        if (deps !== null) {
          for (const d of deps) {
            roots.push(d);
          }
        }
      }
    }
    const effects = this.#markFrontier(roots);
    for (let i = 0; i < effects.length; i++) {
      this.#scheduleEffect(effects[i][0], effects[i][1]);
    }
    this.#flushEffects();
  }

  #isBatching() {
    return this.#batchDepth > 0;
  }

  // -- Dispose -----------------------------------------------------------

  disposeEffect(handle) {
    const id = handle.id;
    const idx = this.#pendingEffects.indexOf(id, this.#pendingHead);
    if (idx !== -1) {
      this.#pendingEffects.splice(idx, 1);
    }
    this.#scheduledEffects.delete(id);
    const node = this.#nodes[id];
    if (!(node instanceof EffectNode)) {
      return;
    }
    this.#nodes[id] = undefined;
    this.#freeIds.push(id);
    const deps = node.dependencies;
    if (deps !== null) {
      for (const dep of deps) {
        this.#removeDependentEdge(dep, id);
      }
    }
    if (node.cleanup) {
      node.cleanup();
    }
  }

  isEffectActive(handle) {
    return this.#nodes[handle.id] instanceof EffectNode;
  }

  disposeSignal(handle) {
    this.disposeEffect(handle.effect);
  }

  isSignalActive(handle) {
    return this.isEffectActive(handle.effect);
  }

  isSet(handle) {
    const node = this.#nodes[handle.id];
    if (!(node instanceof SlotNode)) {
      return false;
    }
    return node.hasValue && !node.dirty;
  }

  // -- Internals: id + edges --------------------------------------------

  #allocId() {
    if (this.#instrument) {
      this.#counters.nodeAllocations++;
    }
    return this.#freeIds.pop() ?? this.#nextId++;
  }

  #currentFrame() {
    return this.#trackingStack[this.#trackingStack.length - 1];
  }

  #registerDependency(depId, parentId) {
    const dep = this.#nodes[depId];
    if (dep instanceof CellNode || dep instanceof SlotNode) {
      if (dep.dependents === null) {
        dep.dependents = [];
      }
      const added = edgeInsert(dep.dependents, parentId);
      if (this.#instrument && added) {
        this.#counters.dependencyEdgesAdded++;
      }
    }
    const parent = this.#nodes[parentId];
    if (parent instanceof SlotNode || parent instanceof EffectNode) {
      if (parent.dependencies === null) {
        parent.dependencies = [];
      }
      edgeInsert(parent.dependencies, depId);
    }
  }

  #removeDependentEdge(depId, parentId) {
    const dep = this.#nodes[depId];
    if (dep instanceof CellNode || dep instanceof SlotNode) {
      if (dep.dependents === null) {
        return;
      }
      const removed = edgeRemove(dep.dependents, parentId);
      if (this.#instrument && removed) {
        this.#counters.dependencyEdgesRemoved++;
      }
    }
  }

  // -- Internals: refresh / recompute (pull-based, glitch-free) ----------

  #refreshSlot(id) {
    const node = this.#nodes[id];
    if (!(node instanceof SlotNode)) {
      return false;
    }
    if (node.hasValue && !node.dirty && !node.forceRecompute) {
      return false;
    }
    if (node.inProgress) {
      throw new Error(
        `lazily: circular dependency detected at slot ${id}; a computed/memo slot depends on itself`,
      );
    }
    node.inProgress = true;
    try {
      let dependencyChanged = false;
      const deps = node.dependencies;
      if (deps !== null) {
        for (const dep of deps) {
          if (this.#nodes[dep] instanceof SlotNode && this.#refreshSlot(dep)) {
            dependencyChanged = true;
          }
        }
      }
      const needsRecompute = !node.hasValue || node.forceRecompute || dependencyChanged;
      if (!needsRecompute) {
        node.dirty = false;
        node.forceRecompute = false;
        return false;
      }
      return this.#recomputeSlotNow(id, node);
    } finally {
      node.inProgress = false;
    }
  }

  #recomputeSlotNow(id, node) {
    if (this.#instrument) {
      this.#counters.slotRecomputes++;
    }
    // #lzjslazyedges: clear in place rather than null + realloc. Toggling the
    // field null↔Array on every recompute makes V8 mark it polymorphic and
    // slows the whole refresh cascade; clearing the backing array keeps the
    // field monomorphic while still reusing it. (The lazy-init win is for nodes
    // that never acquire an edge — those stay null.)
    const oldDeps = node.dependencies;
    if (oldDeps !== null) {
      for (const dep of oldDeps) {
        this.#removeDependentEdge(dep, id);
      }
      oldDeps.length = 0;
    }
    this.#trackingStack.push(id);
    let result;
    try {
      result = node.compute();
    } finally {
      this.#trackingStack.pop();
    }
    const unchanged = node.memo && node.hasValue && defaultEqual(node.value, result);
    node.dirty = false;
    node.forceRecompute = false;
    if (unchanged) {
      return false;
    }
    const hadValue = node.hasValue;
    node.value = result;
    node.hasValue = true;
    if (hadValue) {
      this.#notifySlotValueChanged(id);
    }
    return hadValue;
  }

  #notifySlotValueChanged(id) {
    this.#invalidateDependentsNow(id);
  }

  // -- Internals: invalidation propagation ------------------------------

  /**
   * Mark a cell's dependent cone dirty. Returns `true` iff at least one Effect
   * was scheduled — a `false` result is the store-without-cascade fast path (no
   * active reactor, so no flush is owed).
   * @returns {boolean}
   */
  #invalidateCellDependentsNow(id) {
    return this.#invalidateDependentsNow(id);
  }

  #invalidateDependentsNow(id) {
    const node = this.#nodes[id];
    let roots;
    if (node instanceof CellNode) {
      if (node.dependents === null) {
        return false;
      }
      roots = node.dependents;
    } else if (node instanceof SlotNode) {
      if (node.dependents === null) {
        return false;
      }
      roots = node.dependents;
    } else {
      return false;
    }
    const effects = this.#markFrontier(roots);
    for (let i = 0; i < effects.length; i++) {
      this.#scheduleEffect(effects[i][0], effects[i][1]);
    }
    return effects.length > 0;
  }

  #markFrontier(roots) {
    const effects = this.#frontierEffects;
    const stack = this.#frontierStack;
    const forceStack = this.#frontierForceStack;
    effects.length = 0;
    stack.length = 0;
    forceStack.length = 0;
    for (const root of roots) {
      stack.push(root);
      forceStack.push(true);
    }
    while (stack.length > 0) {
      const id = stack.pop();
      const force = forceStack.pop();
      const node = this.#nodes[id];
      if (node instanceof SlotNode) {
        const shouldPropagate = !node.dirty || (force && !node.forceRecompute);
        node.dirty = true;
        if (force) {
          node.forceRecompute = true;
        }
        if (shouldPropagate) {
          const ddeps = node.dependents;
          if (ddeps !== null) {
            for (const depId of ddeps) {
              stack.push(depId);
              forceStack.push(false);
            }
          }
        }
      } else if (node instanceof EffectNode) {
        effects.push([id, force]);
      }
    }
    return effects;
  }

  // -- Internals: effect scheduling / flush ------------------------------

  #scheduleEffect(id, force) {
    const node = this.#nodes[id];
    if (!(node instanceof EffectNode)) {
      return;
    }
    if (force) {
      node.forceRun = true;
    }
    if (this.#scheduledEffects.add(id)) {
      this.#pendingEffects.push(id);
      if (this.#instrument) {
        this.#counters.effectQueuePushes++;
        const depth = this.#pendingEffects.length - this.#pendingHead;
        if (depth > this.#counters.maxEffectQueueDepth) {
          this.#counters.maxEffectQueueDepth = depth;
        }
      }
    }
  }

  #flushEffects() {
    if (this.#flushingEffects) {
      return;
    }
    this.#flushingEffects = true;
    try {
      while (true) {
        const id = this.#pendingEffects[this.#pendingHead++];
        if (id === undefined) {
          this.#pendingEffects = [];
          this.#pendingHead = 0;
          return;
        }
        this.#scheduledEffects.delete(id);
        this.#runEffect(id);
      }
    } finally {
      this.#flushingEffects = false;
    }
  }

  #runEffect(id) {
    if (!this.#effectShouldRun(id)) {
      return;
    }
    const node = this.#nodes[id];
    if (!(node instanceof EffectNode)) {
      return;
    }
    // #lzjslazyedges: clear in place (see #recomputeSlotNow) to keep the field
    // monomorphic once allocated.
    const oldDeps = node.dependencies;
    const cleanup = node.cleanup;
    node.cleanup = null;
    node.forceRun = false;
    if (oldDeps !== null) {
      for (const dep of oldDeps) {
        this.#removeDependentEdge(dep, id);
      }
      oldDeps.length = 0;
    }
    if (cleanup) {
      cleanup();
    }
    this.#trackingStack.push(id);
    let nextCleanup;
    try {
      nextCleanup = node.run();
    } finally {
      this.#trackingStack.pop();
    }
    const current = this.#nodes[id];
    if (current instanceof EffectNode) {
      current.cleanup = typeof nextCleanup === "function" ? nextCleanup : null;
    } else if (typeof nextCleanup === "function") {
      nextCleanup();
    }
  }

  #effectShouldRun(id) {
    const node = this.#nodes[id];
    if (!(node instanceof EffectNode)) {
      return false;
    }
    if (node.forceRun) {
      return true;
    }
    const deps = node.dependencies;
    if (deps !== null) {
      for (const dep of deps) {
        if (this.#nodes[dep] instanceof SlotNode && this.#refreshSlot(dep)) {
          return true;
        }
      }
    }
    return false;
  }
}
