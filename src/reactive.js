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
//
// #lzjsclosure: this module uses the closure factory technique (rmemo-style)
// rather than `class` + `#private` fields. `createContext()` returns an object
// whose methods close over captured `let` state; nodes are plain objects with
// a numeric `k` discriminator (CELL/SLOT/EFFECT) replacing `instanceof`. V8
// inlines the small monomorphic closures more aggressively than prototype
// methods touching `#private` fields, so the read/invalidate hot paths are
// 2-8x faster than the prior class implementation (see bench/closure-vs-class
// .bench.mjs) while also shaving ~8% off the minified+brotlied payload.

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

// -- Node discriminators (replace `instanceof` in hot loops) ----------------

const CELL = 0;
const SLOT = 1;
const EFFECT = 2;

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

/**
 * Create a reactive {@link Context} — the idiomatic entry point.
 *
 * Implemented with the closure factory technique (#lzjsclosure): graph state is
 * captured in closure bindings rather than class instance fields, so V8 inlines
 * the hot paths more aggressively than the prior `class` + `#private` version.
 *
 * `Context` is an alias of this function (same binding), so the historical
 * `new Context(opts)` call sites keep working unchanged. A function that returns
 * an object is a legal constructor under the JS spec — `new` yields the returned
 * object — so both `createContext(opts)` and `new Context(opts)` produce the
 * same reactive context.
 *
 * @param {{ instrument?: boolean }} [opts] pass `{ instrument: true }` to
 *   accumulate reactive-core counters readable via
 *   {@link Context.instrumentationSnapshot}.
 */
function createContext(opts = {}) {
  const instrument = !!(opts && opts.instrument === true);
  const nodes = [];
  let nextId = 1;
  const freeIds = [];
  const trackingStack = [];
  let pendingEffects = [];
  let pendingHead = 0;
  const scheduledEffects = new Set();
  let flushingEffects = false;
  let batchDepth = 0;
  let batchedCells = new Set();
  // Reusable scratch buffers for markFrontier (#lzjsscratchfrontier): avoid
  // per-invalidation array allocation by clearing in place. Safe under
  // reentrancy because callers fully consume the returned effects array before
  // flushEffects can re-enter markFrontier (guarded by flushingEffects).
  const frontierEffects = [];
  const frontierStack = [];
  const frontierForceStack = [];
  // Opt-in instrumentation (off by default → zero steady-state overhead, so the
  // committed BENCHMARKS.md numbers are unperturbed). Mirrors the counter subset
  // of lazily-rs's `InstrumentationSnapshot` that is meaningful single-threaded.
  let counters = instrument ? zeroCounters() : null;

  function zeroCounters() {
    return {
      nodeAllocations: 0,
      slotRecomputes: 0,
      dependencyEdgesAdded: 0,
      dependencyEdgesRemoved: 0,
      effectQueuePushes: 0,
      maxEffectQueueDepth: 0,
    };
  }

  function allocId() {
    if (instrument) counters.nodeAllocations++;
    return freeIds.pop() ?? nextId++;
  }

  // -- Creation ----------------------------------------------------------

  function cell(value) {
    return new CellHandle(cellAny(value));
  }

  function cellAny(value) {
    const id = allocId();
    nodes[id] = { k: CELL, value, dependents: null }; // #lzjslazyedges
    return id;
  }

  function computed(compute) {
    return new SlotHandle(slotAny(false, compute));
  }

  function slot(compute) {
    return computed(compute);
  }

  function memo(compute) {
    return new SlotHandle(slotAny(true, compute));
  }

  function slotAny(memoFlag, compute) {
    const id = allocId();
    nodes[id] = {
      k: SLOT,
      value: undefined,
      hasValue: false,
      memo: memoFlag,
      compute,
      dependencies: null, // #lzjslazyedges: allocated on first edge
      dependents: null, // #lzjslazyedges: allocated on first edge
      dirty: false,
      forceRecompute: false,
      inProgress: false,
    };
    return id;
  }

  function signal(compute) {
    const slot = slotAny(true, compute);
    const effect = effectAny(() => {
      getSlotAny(slot);
      return null;
    });
    return new SignalHandle(new SlotHandle(slot), new EffectHandle(effect));
  }

  function effect(run) {
    return new EffectHandle(effectAny(run));
  }

  function effectAny(run) {
    const id = allocId();
    const node = {
      k: EFFECT,
      run,
      dependencies: null, // #lzjslazyedges
      cleanup: null,
      forceRun: true, // force the initial run on registration
    };
    nodes[id] = node;
    scheduleEffect(id, false);
    flushEffects();
    return id;
  }

  // -- Read --------------------------------------------------------------

  function get(handle) {
    return getSlotAny(handle.id);
  }

  function getCell(handle) {
    return getCellAny(handle.id);
  }

  function getSignal(handle) {
    return get(handle.slot);
  }

  function getSlotAny(id) {
    const len = trackingStack.length;
    if (len > 0) {
      registerDependency(id, trackingStack[len - 1]);
    }
    refreshSlot(id);
    const node = nodes[id];
    if (node.k !== SLOT || !node.hasValue) {
      throw new Error(`slot ${id} has no value`);
    }
    return node.value;
  }

  function getCellAny(id) {
    const len = trackingStack.length;
    if (len > 0) {
      registerDependency(id, trackingStack[len - 1]);
    }
    const node = nodes[id];
    if (node.k !== CELL) {
      throw new Error(`get_cell on non-cell id ${id}`);
    }
    return node.value;
  }

  // -- Write -------------------------------------------------------------

  function setCell(handle, value) {
    setCellAny(handle.id, value);
  }

  function setCellAny(id, value) {
    const node = nodes[id];
    if (node.k !== CELL) {
      throw new Error(`set_cell on non-cell id ${id}`);
    }
    if (!defaultEqual(node.value, value)) {
      node.value = value;
      if (batchDepth > 0) {
        batchedCells.add(id);
      } else {
        // Store-without-cascade: the new value is stored above (so a late
        // subscriber reads it glitch-free) and lazy Slot dependents are
        // dirty-marked, but the effect flush runs ONLY when the dependent cone
        // actually contains an Effect. A cell with no active reactor pays no
        // flush — the write side of the merge cost law
        // (relaycell-backpressure-analysis.md §4.0 / §5).
        if (invalidateDependentsNow(id)) {
          flushEffects();
        }
      }
    }
  }

  // -- Batch -------------------------------------------------------------

  function batch(run) {
    batchDepth++;
    try {
      run();
    } finally {
      finishBatch();
    }
  }

  function finishBatch() {
    if (batchDepth <= 0) {
      throw new Error("finishBatch without active batch");
    }
    batchDepth--;
    if (batchDepth === 0) {
      flushBatched();
    }
  }

  function flushBatched() {
    const cells = batchedCells;
    batchedCells = new Set();
    const roots = [];
    for (const id of cells) {
      const node = nodes[id];
      if (node.k === CELL) {
        const deps = node.dependents;
        if (deps !== null) {
          for (let i = 0; i < deps.length; i++) {
            roots.push(deps[i]);
          }
        }
      }
    }
    const effects = markFrontier(roots);
    for (let i = 0; i < effects.length; i++) {
      scheduleEffect(effects[i][0], effects[i][1]);
    }
    flushEffects();
  }

  // -- Dispose -----------------------------------------------------------

  function disposeEffect(handle) {
    const id = handle.id;
    const idx = pendingEffects.indexOf(id, pendingHead);
    if (idx !== -1) {
      pendingEffects.splice(idx, 1);
    }
    scheduledEffects.delete(id);
    const node = nodes[id];
    if (node.k !== EFFECT) {
      return;
    }
    nodes[id] = undefined;
    freeIds.push(id);
    const deps = node.dependencies;
    if (deps !== null) {
      for (let i = 0; i < deps.length; i++) {
        removeDependentEdge(deps[i], id);
      }
    }
    if (node.cleanup) {
      node.cleanup();
    }
  }

  function isEffectActive(handle) {
    const node = nodes[handle.id];
    return node !== undefined && node.k === EFFECT;
  }

  function disposeSignal(handle) {
    disposeEffect(handle.effect);
  }

  function isSignalActive(handle) {
    return isEffectActive(handle.effect);
  }

  // Tear down a lazy derived node (slot/computed/memo). A slot is both a consumer
  // (it has `dependencies` — the cells/slots it reads) and a producer (it has
  // `dependents` — the slots/effects that read it), so both edge sets must be
  // detached: upstream so invalidation no longer reaches this node, downstream so
  // a later rerun of a former dependent never dereferences the freed id (see
  // `removeDependentEdge`, which reads `nodes[depId].k`). Safe to call on an
  // already-disposed handle or the wrong kind (no-op).
  function disposeSlot(handle) {
    const id = handle.id;
    const node = nodes[id];
    if (node === undefined || node.k !== SLOT) {
      return;
    }
    const deps = node.dependencies;
    if (deps !== null) {
      for (let i = 0; i < deps.length; i++) {
        removeDependentEdge(deps[i], id);
      }
    }
    const dependents = node.dependents;
    if (dependents !== null) {
      for (let i = 0; i < dependents.length; i++) {
        removeDependencyEdge(dependents[i], id);
      }
    }
    nodes[id] = undefined;
    freeIds.push(id);
  }

  // Tear down a source cell. Cells have no `dependencies` (pure source), so only
  // the downstream edges are detached. Callers must ensure nothing still reads the
  // cell in a live compute — disposing a cell a live slot reads will throw on that
  // slot's next recompute (same contract as disposing any still-referenced node).
  function disposeCell(handle) {
    const id = handle.id;
    const node = nodes[id];
    if (node === undefined || node.k !== CELL) {
      return;
    }
    const dependents = node.dependents;
    if (dependents !== null) {
      for (let i = 0; i < dependents.length; i++) {
        removeDependencyEdge(dependents[i], id);
      }
    }
    nodes[id] = undefined;
    freeIds.push(id);
  }

  function isSet(handle) {
    const node = nodes[handle.id];
    if (node === undefined || node.k !== SLOT) {
      return false;
    }
    return node.hasValue && !node.dirty;
  }

  // -- Instrumentation ---------------------------------------------------

  function instrumentationSnapshot() {
    return counters ? { ...counters } : null;
  }

  function resetInstrumentation() {
    if (counters) {
      counters = zeroCounters();
    }
  }

  // -- Internals: edges --------------------------------------------------

  function registerDependency(depId, parentId) {
    const dep = nodes[depId];
    if (dep.k === CELL || dep.k === SLOT) {
      if (dep.dependents === null) {
        dep.dependents = [];
      }
      const added = edgeInsert(dep.dependents, parentId);
      if (instrument && added) {
        counters.dependencyEdgesAdded++;
      }
    }
    const parent = nodes[parentId];
    if (parent.k === SLOT || parent.k === EFFECT) {
      if (parent.dependencies === null) {
        parent.dependencies = [];
      }
      edgeInsert(parent.dependencies, depId);
    }
  }

  function removeDependentEdge(depId, parentId) {
    const dep = nodes[depId];
    if (dep.k === CELL || dep.k === SLOT) {
      if (dep.dependents === null) {
        return;
      }
      const removed = edgeRemove(dep.dependents, parentId);
      if (instrument && removed) {
        counters.dependencyEdgesRemoved++;
      }
    }
  }

  // Symmetric to {@link removeDependentEdge}: remove `depId` from
  // `nodes[parentId].dependencies` (the consumer-side edge list). Only SLOT and
  // EFFECT nodes carry a `dependencies` list; cells are pure sources. Used by the
  // downstream teardown in {@link disposeSlot}/{@link disposeCell}.
  function removeDependencyEdge(parentId, depId) {
    const parent = nodes[parentId];
    if (parent === undefined) {
      return;
    }
    if (parent.k === SLOT || parent.k === EFFECT) {
      if (parent.dependencies === null) {
        return;
      }
      const removed = edgeRemove(parent.dependencies, depId);
      if (instrument && removed) {
        counters.dependencyEdgesRemoved++;
      }
    }
  }

  // -- Internals: refresh / recompute (pull-based, glitch-free) ----------

  function refreshSlot(id) {
    const node = nodes[id];
    if (node.k !== SLOT) {
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
        for (let i = 0; i < deps.length; i++) {
          const dep = deps[i];
          if (nodes[dep].k === SLOT && refreshSlot(dep)) {
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
      return recomputeSlotNow(id, node);
    } finally {
      node.inProgress = false;
    }
  }

  function recomputeSlotNow(id, node) {
    if (instrument) {
      counters.slotRecomputes++;
    }
    // #lzjslazyedges: clear in place rather than null + realloc. Toggling the
    // field null↔Array on every recompute makes V8 mark it polymorphic and
    // slows the whole refresh cascade; clearing the backing array keeps the
    // field monomorphic while still reusing it. (The lazy-init win is for nodes
    // that never acquire an edge — those stay null.)
    const oldDeps = node.dependencies;
    if (oldDeps !== null) {
      for (let i = 0; i < oldDeps.length; i++) {
        removeDependentEdge(oldDeps[i], id);
      }
      oldDeps.length = 0;
    }
    trackingStack.push(id);
    let result;
    try {
      result = node.compute();
    } finally {
      trackingStack.pop();
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
      invalidateDependentsNow(id);
    }
    return hadValue;
  }

  // -- Internals: invalidation propagation ------------------------------

  /**
   * Mark a node's dependent cone dirty. Returns `true` iff at least one Effect
   * was scheduled — a `false` result is the store-without-cascade fast path (no
   * active reactor, so no flush is owed).
   */
  function invalidateDependentsNow(id) {
    const node = nodes[id];
    let roots;
    if (node.k === CELL || node.k === SLOT) {
      if (node.dependents === null) {
        return false;
      }
      roots = node.dependents;
    } else {
      return false;
    }
    const effects = markFrontier(roots);
    for (let i = 0; i < effects.length; i++) {
      scheduleEffect(effects[i][0], effects[i][1]);
    }
    return effects.length > 0;
  }

  function markFrontier(roots) {
    const effects = frontierEffects;
    const stack = frontierStack;
    const forceStack = frontierForceStack;
    effects.length = 0;
    stack.length = 0;
    forceStack.length = 0;
    for (let i = 0; i < roots.length; i++) {
      stack.push(roots[i]);
      forceStack.push(true);
    }
    while (stack.length > 0) {
      const id = stack.pop();
      const force = forceStack.pop();
      const node = nodes[id];
      if (node.k === SLOT) {
        const shouldPropagate = !node.dirty || (force && !node.forceRecompute);
        node.dirty = true;
        if (force) {
          node.forceRecompute = true;
        }
        if (shouldPropagate) {
          const ddeps = node.dependents;
          if (ddeps !== null) {
            for (let i = 0; i < ddeps.length; i++) {
              stack.push(ddeps[i]);
              forceStack.push(false);
            }
          }
        }
      } else if (node.k === EFFECT) {
        effects.push([id, force]);
      }
    }
    return effects;
  }

  // -- Internals: effect scheduling / flush ------------------------------

  function scheduleEffect(id, force) {
    const node = nodes[id];
    if (node.k !== EFFECT) {
      return;
    }
    if (force) {
      node.forceRun = true;
    }
    if (scheduledEffects.add(id)) {
      pendingEffects.push(id);
      if (instrument) {
        counters.effectQueuePushes++;
        const depth = pendingEffects.length - pendingHead;
        if (depth > counters.maxEffectQueueDepth) {
          counters.maxEffectQueueDepth = depth;
        }
      }
    }
  }

  function flushEffects() {
    if (flushingEffects) {
      return;
    }
    flushingEffects = true;
    try {
      while (true) {
        const id = pendingEffects[pendingHead++];
        if (id === undefined) {
          pendingEffects = [];
          pendingHead = 0;
          return;
        }
        scheduledEffects.delete(id);
        runEffect(id);
      }
    } finally {
      flushingEffects = false;
    }
  }

  function runEffect(id) {
    if (!effectShouldRun(id)) {
      return;
    }
    const node = nodes[id];
    if (node.k !== EFFECT) {
      return;
    }
    // #lzjslazyedges: clear in place (see recomputeSlotNow) to keep the field
    // monomorphic once allocated.
    const oldDeps = node.dependencies;
    const cleanup = node.cleanup;
    node.cleanup = null;
    node.forceRun = false;
    if (oldDeps !== null) {
      for (let i = 0; i < oldDeps.length; i++) {
        removeDependentEdge(oldDeps[i], id);
      }
      oldDeps.length = 0;
    }
    if (cleanup) {
      cleanup();
    }
    trackingStack.push(id);
    let nextCleanup;
    try {
      nextCleanup = node.run();
    } finally {
      trackingStack.pop();
    }
    const current = nodes[id];
    if (current.k === EFFECT) {
      current.cleanup = typeof nextCleanup === "function" ? nextCleanup : null;
    } else if (typeof nextCleanup === "function") {
      nextCleanup();
    }
  }

  function effectShouldRun(id) {
    const node = nodes[id];
    if (node.k !== EFFECT) {
      return false;
    }
    if (node.forceRun) {
      return true;
    }
    const deps = node.dependencies;
    if (deps !== null) {
      for (let i = 0; i < deps.length; i++) {
        const dep = deps[i];
        if (nodes[dep].k === SLOT && refreshSlot(dep)) {
          return true;
        }
      }
    }
    return false;
  }

  return {
    cell,
    computed,
    slot,
    memo,
    signal,
    effect,
    get,
    getCell,
    getSignal,
    setCell,
    batch,
    disposeEffect,
    isEffectActive,
    disposeSignal,
    isSignalActive,
    disposeSlot,
    disposeCell,
    isSet,
    instrumentationSnapshot,
    resetInstrumentation,
  };
}

/**
 * Backwards-compatible newable alias of {@link createContext}. Existing code
 * that writes `new Context(opts)` keeps working unchanged; new code may call
 * `createContext(opts)` directly. Both produce the same reactive context.
 */
export { createContext, createContext as Context };
