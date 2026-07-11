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
    aKeys.every((k) => Object.is(aKeys[k], bKeys[k])) &&
    aKeys.every((k) => defaultEqual(a[k], b[k]))
  );
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

class CellNode {
  constructor(value) {
    this.value = value;
    this.dependents = new Set();
  }
}

class SlotNode {
  constructor(compute, memo) {
    this.value = undefined;
    this.hasValue = false;
    this.memo = memo;
    this.compute = compute;
    this.dependencies = new Set();
    this.dependents = new Set();
    this.dirty = false;
    this.forceRecompute = false;
    this.inProgress = false;
  }
}

class EffectNode {
  constructor(run) {
    this.run = run;
    this.dependencies = new Set();
    this.cleanup = null;
    this.forceRun = false;
  }
}

export class Context {
  #nodes = new Map();
  #nextId = 1;
  #freeIds = [];
  #trackingStack = [];
  #pendingEffects = [];
  #scheduledEffects = new Set();
  #flushingEffects = false;
  #batchDepth = 0;
  #batchedCells = new Set();
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
    this.#nodes.set(id, new CellNode(value));
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
    this.#nodes.set(id, new SlotNode(compute, memo));
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
    this.#nodes.set(id, node);
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
    const node = this.#nodes.get(id);
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
    const node = this.#nodes.get(id);
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
    const node = this.#nodes.get(id);
    if (!(node instanceof CellNode)) {
      throw new Error(`set_cell on non-cell id ${id}`);
    }
    if (!defaultEqual(node.value, value)) {
      node.value = value;
      if (this.#isBatching()) {
        this.#batchedCells.add(id);
      } else {
        this.#invalidateCellDependentsNow(id);
        this.#flushEffects();
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
    const cells = [...this.#batchedCells];
    this.#batchedCells.clear();
    for (const id of cells) {
      this.#invalidateCellDependentsNow(id);
    }
    this.#flushEffects();
  }

  #isBatching() {
    return this.#batchDepth > 0;
  }

  // -- Dispose -----------------------------------------------------------

  disposeEffect(handle) {
    const id = handle.id;
    const idx = this.#pendingEffects.indexOf(id);
    if (idx !== -1) {
      this.#pendingEffects.splice(idx, 1);
    }
    this.#scheduledEffects.delete(id);
    const node = this.#nodes.get(id);
    if (!(node instanceof EffectNode)) {
      return;
    }
    this.#nodes.delete(id);
    this.#freeIds.push(id);
    for (const dep of [...node.dependencies]) {
      this.#removeDependentEdge(dep, id);
    }
    if (node.cleanup) {
      node.cleanup();
    }
  }

  isEffectActive(handle) {
    return this.#nodes.get(handle.id) instanceof EffectNode;
  }

  disposeSignal(handle) {
    this.disposeEffect(handle.effect);
  }

  isSignalActive(handle) {
    return this.isEffectActive(handle.effect);
  }

  isSet(handle) {
    const node = this.#nodes.get(handle.id);
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
    const dep = this.#nodes.get(depId);
    if (dep instanceof CellNode || dep instanceof SlotNode) {
      if (this.#instrument && !dep.dependents.has(parentId)) {
        this.#counters.dependencyEdgesAdded++;
      }
      dep.dependents.add(parentId);
    }
    const parent = this.#nodes.get(parentId);
    if (parent instanceof SlotNode || parent instanceof EffectNode) {
      parent.dependencies.add(depId);
    }
  }

  #removeDependentEdge(depId, parentId) {
    const dep = this.#nodes.get(depId);
    if (dep instanceof CellNode || dep instanceof SlotNode) {
      if (this.#instrument && dep.dependents.has(parentId)) {
        this.#counters.dependencyEdgesRemoved++;
      }
      dep.dependents.delete(parentId);
    }
  }

  // -- Internals: refresh / recompute (pull-based, glitch-free) ----------

  #refreshSlot(id) {
    const node = this.#nodes.get(id);
    if (!(node instanceof SlotNode)) {
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
      for (const dep of [...node.dependencies]) {
        if (this.#nodes.get(dep) instanceof SlotNode && this.#refreshSlot(dep)) {
          dependencyChanged = true;
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
    for (const dep of [...node.dependencies]) {
      this.#removeDependentEdge(dep, id);
    }
    node.dependencies.clear();
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
    const node = this.#nodes.get(id);
    if (!(node instanceof SlotNode)) {
      return;
    }
    for (const d of [...node.dependents]) {
      this.#invalidateDependentFromChangedValue(d);
    }
  }

  // -- Internals: invalidation propagation ------------------------------

  #invalidateCellDependentsNow(id) {
    const node = this.#nodes.get(id);
    if (!(node instanceof CellNode)) {
      return;
    }
    for (const d of [...node.dependents]) {
      this.#invalidateDependentFromChangedValue(d);
    }
  }

  #invalidateDependentFromChangedValue(id) {
    if (this.#nodes.get(id) instanceof EffectNode) {
      this.#scheduleEffect(id, true);
    } else {
      this.#markSlotDirty(id, true);
    }
  }

  #markSlotDirty(id, force) {
    const node = this.#nodes.get(id);
    if (!(node instanceof SlotNode)) {
      return;
    }
    const shouldPropagate = !node.dirty || (force && !node.forceRecompute);
    node.dirty = true;
    if (force) {
      node.forceRecompute = true;
    }
    if (!shouldPropagate) {
      return;
    }
    for (const d of [...node.dependents]) {
      if (this.#nodes.get(d) instanceof EffectNode) {
        this.#scheduleEffect(d, false);
      } else {
        this.#markSlotDirty(d, false);
      }
    }
  }

  // -- Internals: effect scheduling / flush ------------------------------

  #scheduleEffect(id, force) {
    const node = this.#nodes.get(id);
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
        if (this.#pendingEffects.length > this.#counters.maxEffectQueueDepth) {
          this.#counters.maxEffectQueueDepth = this.#pendingEffects.length;
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
        const id = this.#pendingEffects.shift();
        if (id === undefined) {
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
    const node = this.#nodes.get(id);
    if (!(node instanceof EffectNode)) {
      return;
    }
    const oldDeps = [...node.dependencies];
    node.dependencies.clear();
    const cleanup = node.cleanup;
    node.cleanup = null;
    node.forceRun = false;
    for (const dep of oldDeps) {
      this.#removeDependentEdge(dep, id);
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
    const current = this.#nodes.get(id);
    if (current instanceof EffectNode) {
      current.cleanup = typeof nextCleanup === "function" ? nextCleanup : null;
    } else if (typeof nextCleanup === "function") {
      nextCleanup();
    }
  }

  #effectShouldRun(id) {
    const node = this.#nodes.get(id);
    if (!(node instanceof EffectNode)) {
      return false;
    }
    if (node.forceRun) {
      return true;
    }
    for (const dep of node.dependencies) {
      if (this.#nodes.get(dep) instanceof SlotNode && this.#refreshSlot(dep)) {
        return true;
      }
    }
    return false;
  }
}
