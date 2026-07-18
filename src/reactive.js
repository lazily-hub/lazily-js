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
// a numeric discriminator (KIND_CELL/KIND_SLOT/KIND_EFFECT) replacing
// `instanceof`. V8 inlines the small monomorphic closures more aggressively
// than prototype methods touching `#private` fields, so the read/invalidate
// hot paths are 2-8x faster than the prior class implementation (see
// bench/closure-vs-class.bench.mjs) while also shaving ~8% off the
// minified+brotlied payload.
//
// #lzjsarenanodes: the hot per-node scalar state (kind + packed boolean flags)
// lives in two arena typed arrays (`kinds` / `flags`) keyed by id, not on the
// node objects themselves. The `nodes` array keeps only non-scalar fields
// (value, compute fn, edge arrays), shrinking each node object from up to 10
// properties to ≤4. That lets V8 emit one stable hidden class per shape and
// trims per-node memory from ~300 B to ~150 B on the spreadsheet-scale
// workloads in BENCHMARKS.md. Boolean fields are bit-packed: hasValue/memo/
// dirty/forceRecompute/inProgress (slots) and forceRun (effects).

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
// #lzjsarenanodes: the kind lives in the `kinds` Uint8Array arena (one byte
// per id), not on the node object. KIND_NONE (0) marks a free id — it is what
// `kinds[id]` reads as for never-allocated ids (typed arrays zero-initialize)
// and what dispose* explicitly writes back when recycling an id. The node
// objects in `nodes[]` no longer carry a `k` field.

const KIND_NONE = 0;
const KIND_CELL = 1;
const KIND_SLOT = 2;
const KIND_EFFECT = 3;

// Packed boolean flags stored in the `flags` Uint8Array arena (one byte per
// id). Slot nodes use the first five bits; Effect nodes use F_FORCE_RUN. Cell
// nodes carry no flags. Packing the booleans into one byte/id (vs ~5 separate
// properties × ~8 B each on the slot object) is most of the #lzjsarenanodes
// per-node memory win.
const F_HAS_VALUE = 1 << 0;        // slot: a memoized value is cached
const F_MEMO = 1 << 1;             // slot: equality-suppressed recompute
const F_DIRTY = 1 << 2;            // slot: invalidate-on-next-read marker
const F_FORCE_RECOMPUTE = 1 << 3;  // slot: force a recompute even if not dirty
const F_IN_PROGRESS = 1 << 4;      // slot: cycle-detection tripwire
const F_FORCE_RUN = 1 << 5;        // effect: force the next run regardless

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
  // #lzjsarenanodes: arena typed arrays keyed by id. `kinds[id]` holds the
  // KIND_* discriminator (replacing the per-node `k` field); `flags[id]` holds
  // the packed F_* boolean bits (replacing hasValue/dirty/forceRecompute/
  // inProgress/memo/forceRun). They start small and double on demand via
  // ensureCapacity; both are `let` so growth can rebind them — every closure
  // sees the latest binding. 2 bytes/id total versus ~50 B/id for the same
  // fields as object properties is the bulk of the per-node savings.
  let kinds = new Uint8Array(32);
  let flags = new Uint8Array(32);
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

  // #lzjsarenanodes: grow the arena typed arrays when an id falls outside the
  // current capacity. Inlined into allocId (the sole caller) so the hot path
  // stays a single `id < kinds.length` branch; doubling keeps growth amortized
  // O(1) per alloc. `kinds`/`flags` are `let` so the new arrays are visible to
  // every closure that reads them.
  function allocId() {
    if (instrument) counters.nodeAllocations++;
    const id = freeIds.pop() ?? nextId++;
    if (id >= kinds.length) {
      const newCap = kinds.length * 2;
      const newKinds = new Uint8Array(newCap);
      newKinds.set(kinds);
      kinds = newKinds;
      const newFlags = new Uint8Array(newCap);
      newFlags.set(flags);
      flags = newFlags;
    }
    return id;
  }

  // -- Creation ----------------------------------------------------------

  function cell(value) {
    return new CellHandle(cellAny(value));
  }

  function cellAny(value) {
    const id = allocId();
    // #lzjsarenanodes: kind + (no) flags live in the arena; the node object
    // holds only value + the lazy dependents edge list.
    kinds[id] = KIND_CELL;
    flags[id] = 0;
    nodes[id] = { value, dependents: null }; // #lzjslazyedges
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
    // #lzjsarenanodes: kind + hasValue/dirty/forceRecompute/inProgress all
    // start at 0/false; memo is the only flag that may be set at creation. The
    // node object keeps value (varies), compute (closure), and the two lazy
    // edge lists — down from 10 properties to 4.
    kinds[id] = KIND_SLOT;
    flags[id] = memoFlag ? F_MEMO : 0;
    nodes[id] = {
      value: undefined,
      compute,
      dependencies: null, // #lzjslazyedges: allocated on first edge
      dependents: null, // #lzjslazyedges: allocated on first edge
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
    // #lzjsarenanodes: forceRun starts set (force the initial run on
    // registration); the node object keeps run/cleanup + the lazy edge list.
    kinds[id] = KIND_EFFECT;
    flags[id] = F_FORCE_RUN;
    nodes[id] = {
      run,
      dependencies: null, // #lzjslazyedges
      cleanup: null,
    };
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
    // After refreshSlot, F_HAS_VALUE is set iff `id` is a SLOT that has
    // produced a value: non-slot kinds (CELL/EFFECT/NONE) never carry the
    // bit, and refreshSlot sets it on first successful recompute. So this one
    // flag check replaces both the kind check and the old hasValue read on
    // the hot cached path.
    if ((flags[id] & F_HAS_VALUE) === 0) {
      throw new Error(`slot ${id} has no value`);
    }
    return nodes[id].value;
  }

  function getCellAny(id) {
    const len = trackingStack.length;
    if (len > 0) {
      registerDependency(id, trackingStack[len - 1]);
    }
    if (kinds[id] !== KIND_CELL) {
      throw new Error(`get_cell on non-cell id ${id}`);
    }
    return nodes[id].value;
  }

  // -- Write -------------------------------------------------------------

  function setCell(handle, value) {
    setCellAny(handle.id, value);
  }

  function setCellAny(id, value) {
    if (kinds[id] !== KIND_CELL) {
      throw new Error(`set_cell on non-cell id ${id}`);
    }
    const node = nodes[id];
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
      if (kinds[id] === KIND_CELL) {
        const deps = nodes[id].dependents;
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
    if (kinds[id] !== KIND_EFFECT) {
      return;
    }
    const node = nodes[id];
    // #lzjsarenanodes: clear the arena slots so the recycled id reads as
    // KIND_NONE/flags=0, then drop the object reference so the run/cleanup
    // closures can be GC'd.
    kinds[id] = KIND_NONE;
    flags[id] = 0;
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
    return kinds[handle.id] === KIND_EFFECT;
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
  // `removeDependentEdge`, which reads `kinds[depId]`). Safe to call on an
  // already-disposed handle or the wrong kind (no-op).
  function disposeSlot(handle) {
    const id = handle.id;
    if (kinds[id] !== KIND_SLOT) {
      return;
    }
    const node = nodes[id];
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
    // #lzjsarenanodes: clear arena slots before recycling the id.
    kinds[id] = KIND_NONE;
    flags[id] = 0;
    nodes[id] = undefined;
    freeIds.push(id);
  }

  // Tear down a source cell. Cells have no `dependencies` (pure source), so only
  // the downstream edges are detached. Callers must ensure nothing still reads the
  // cell in a live compute — disposing a cell a live slot reads will throw on that
  // slot's next recompute (same contract as disposing any still-referenced node).
  function disposeCell(handle) {
    const id = handle.id;
    if (kinds[id] !== KIND_CELL) {
      return;
    }
    const node = nodes[id];
    const dependents = node.dependents;
    if (dependents !== null) {
      for (let i = 0; i < dependents.length; i++) {
        removeDependencyEdge(dependents[i], id);
      }
    }
    kinds[id] = KIND_NONE;
    flags[id] = 0;
    nodes[id] = undefined;
    freeIds.push(id);
  }

  function isSet(handle) {
    const id = handle.id;
    if (kinds[id] !== KIND_SLOT) {
      return false;
    }
    // hasValue && !dirty, packed.
    return (flags[id] & (F_HAS_VALUE | F_DIRTY)) === F_HAS_VALUE;
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
    const depKind = kinds[depId];
    if (depKind === KIND_CELL || depKind === KIND_SLOT) {
      const dep = nodes[depId];
      if (dep.dependents === null) {
        dep.dependents = [];
      }
      const added = edgeInsert(dep.dependents, parentId);
      if (instrument && added) {
        counters.dependencyEdgesAdded++;
      }
    }
    const parentKind = kinds[parentId];
    if (parentKind === KIND_SLOT || parentKind === KIND_EFFECT) {
      const parent = nodes[parentId];
      if (parent.dependencies === null) {
        parent.dependencies = [];
      }
      edgeInsert(parent.dependencies, depId);
    }
  }

  function removeDependentEdge(depId, parentId) {
    const depKind = kinds[depId];
    if (depKind === KIND_CELL || depKind === KIND_SLOT) {
      const dep = nodes[depId];
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
    const parentKind = kinds[parentId];
    if (parentKind === KIND_NONE) {
      return;
    }
    if (parentKind === KIND_SLOT || parentKind === KIND_EFFECT) {
      const parent = nodes[parentId];
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
    if (kinds[id] !== KIND_SLOT) {
      return false;
    }
    const node = nodes[id];
    const f = flags[id];
    // hasValue && !dirty && !forceRecompute → cached, nothing to do.
    if ((f & F_HAS_VALUE) !== 0 && (f & (F_DIRTY | F_FORCE_RECOMPUTE)) === 0) {
      return false;
    }
    if ((f & F_IN_PROGRESS) !== 0) {
      throw new Error(
        `lazily: circular dependency detected at slot ${id}; a computed/memo slot depends on itself`,
      );
    }
    flags[id] = f | F_IN_PROGRESS;
    try {
      let dependencyChanged = false;
      const deps = node.dependencies;
      if (deps !== null) {
        for (let i = 0; i < deps.length; i++) {
          const dep = deps[i];
          if (kinds[dep] === KIND_SLOT && refreshSlot(dep)) {
            dependencyChanged = true;
          }
        }
      }
      const needsRecompute =
        (f & F_HAS_VALUE) === 0 || (f & F_FORCE_RECOMPUTE) !== 0 || dependencyChanged;
      if (!needsRecompute) {
        // Clear dirty/forceRecompute; the finally clears inProgress.
        flags[id] &= ~(F_DIRTY | F_FORCE_RECOMPUTE);
        return false;
      }
      return recomputeSlotNow(id, node, f);
    } finally {
      flags[id] &= ~F_IN_PROGRESS;
    }
  }

  function recomputeSlotNow(id, node, f) {
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
    const isMemo = (f & F_MEMO) !== 0;
    const hadValue = (f & F_HAS_VALUE) !== 0;
    const unchanged = isMemo && hadValue && defaultEqual(node.value, result);
    // Clear dirty/forceRecompute for the next cycle. Use `&=` (not assignment
    // from `f`) so F_IN_PROGRESS — set by the caller and cleared by its finally
    // — stays set for the duration of the recompute (cycle detection).
    flags[id] &= ~(F_DIRTY | F_FORCE_RECOMPUTE);
    if (unchanged) {
      return false;
    }
    node.value = result;
    flags[id] |= F_HAS_VALUE;
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
    const kind = kinds[id];
    let roots;
    if (kind === KIND_CELL || kind === KIND_SLOT) {
      const dependents = nodes[id].dependents;
      if (dependents === null) {
        return false;
      }
      roots = dependents;
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
      const kind = kinds[id];
      if (kind === KIND_SLOT) {
        // #lzjsarenanodes: read+write the dirty/forceRecompute bits in the
        // flags arena. shouldPropagate mirrors the original `!dirty || (force
        // && !forceRecompute)` predicate; then we set dirty (and
        // forceRecompute when forcing).
        const f = flags[id];
        const isDirty = (f & F_DIRTY) !== 0;
        const isForceRecompute = (f & F_FORCE_RECOMPUTE) !== 0;
        const shouldPropagate = !isDirty || (force && !isForceRecompute);
        let newFlags = f | F_DIRTY;
        if (force) {
          newFlags |= F_FORCE_RECOMPUTE;
        }
        flags[id] = newFlags;
        if (shouldPropagate) {
          const ddeps = nodes[id].dependents;
          if (ddeps !== null) {
            for (let i = 0; i < ddeps.length; i++) {
              stack.push(ddeps[i]);
              forceStack.push(false);
            }
          }
        }
      } else if (kind === KIND_EFFECT) {
        effects.push([id, force]);
      }
    }
    return effects;
  }

  // -- Internals: effect scheduling / flush ------------------------------

  function scheduleEffect(id, force) {
    if (kinds[id] !== KIND_EFFECT) {
      return;
    }
    if (force) {
      flags[id] |= F_FORCE_RUN;
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
    if (kinds[id] !== KIND_EFFECT) {
      return;
    }
    const node = nodes[id];
    // #lzjslazyedges: clear in place (see recomputeSlotNow) to keep the field
    // monomorphic once allocated.
    const oldDeps = node.dependencies;
    const cleanup = node.cleanup;
    node.cleanup = null;
    flags[id] &= ~F_FORCE_RUN;
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
    if (kinds[id] === KIND_EFFECT) {
      nodes[id].cleanup = typeof nextCleanup === "function" ? nextCleanup : null;
    } else if (typeof nextCleanup === "function") {
      nextCleanup();
    }
  }

  function effectShouldRun(id) {
    if (kinds[id] !== KIND_EFFECT) {
      return false;
    }
    if ((flags[id] & F_FORCE_RUN) !== 0) {
      return true;
    }
    const deps = nodes[id].dependencies;
    if (deps !== null) {
      for (let i = 0; i < deps.length; i++) {
        const dep = deps[i];
        if (kinds[dep] === KIND_SLOT && refreshSlot(dep)) {
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
