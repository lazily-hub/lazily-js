// Async keyed reactive collection (`#reactivemap`, async flavor) — the
// {@link AsyncContext} analog of {@link ReactiveMap}.
//
// Keys `K` map to per-entry async reactive nodes: input cells
// ({@link AsyncSource}, always resolved) or derived slots
// ({@link AsyncComputed}, resolved asynchronously). Like the thread-safe map
// it keeps its present-set state under its own {@link AtomicMutex}.
//
// The eager/lazy behavior and present-set monotonicity are identical to the
// single-threaded map: eager pre-mints the keyset (`materializeAll`); lazy mints
// on access (`getOrInsertHandle`). There is NO eager/lazy mode flag. The
// transparency law is EVENTUAL: an async derived slot read is `undefined` while
// pending and resolves to the canonical value — so `observe` returns
// `V | undefined`. Input cells are always resolved. Drive a slot to resolution
// with `ctx.getAsync(map.get(key))` or {@link AsyncReactiveMap#resolve}.
//
// Its two specializations are {@link AsyncSourceMap} (input cells) and
// {@link AsyncComputedMap} (derived slots).
//
// Rust reference: `lazily-rs/src/async_reactive_family.rs`.

import { DependencyAvailability, EntryKind } from "./reactive-family.js";
import { AtomicMutex } from "./thread-safe.js";

export { EntryKind };

import { KeyedOrder, moveApplied, moveChanged, mutationChanged } from "./keyed-order.js";

/**
 * The async keyed reactive collection (`#reactivemap`) generic over the entry
 * handle kind. Present-set state is guarded by an {@link AtomicMutex}; the
 * transparency law is EVENTUAL (a pending slot observes as `undefined`).
 *
 * Operations run against an owning `AsyncContext` (from `./reactive-async.js`).
 *
 * @template K, V
 */
export class AsyncReactiveMap {
  /** @type {import("./reactive-async.js").AsyncContext} */
  _ctx;
  /** @type {EntryKind} */
  _kind;
  /**
   * Present set + key order + the move algebra, shared with the other two
   * flavors. Graph-agnostic; the reactivity below is this flavor's own.
   * @type {KeyedOrder<K, any>}
   */
  _keyed = new KeyedOrder();
  /** Reactive set-membership signal, minted on THIS flavor's graph. */
  _membership;
  /** Untracked mirror of the membership version. @type {number} */
  _version = 0;
  /** Reactive order signal; bumped on add/remove AND on move/reorder. */
  _orderSignal;
  /** Untracked mirror of the order version. @type {number} */
  _orderVersion = 0;
  /** @type {AtomicMutex} */
  _mutex = new AtomicMutex();

  /**
   * @param {import("./reactive-async.js").AsyncContext} ctx owning async context
   * @param {EntryKind} [kind] entry handle kind; defaults to {@link EntryKind.Computed}
   */
  constructor(ctx, kind = EntryKind.Computed) {
    if (kind !== EntryKind.Source && kind !== EntryKind.Computed) {
      throw new TypeError("kind must be EntryKind.Source or EntryKind.Computed");
    }
    this._ctx = ctx;
    this._kind = kind;
    this._membership = ctx.source(0);
    this._orderSignal = ctx.source(0);
  }

  /**
   * Mint the entry node for `key` on first access. A cell sets its value
   * directly (always resolved); a derived slot wraps `compute` in a ready async
   * recomputation. FIRST-WRITER-WINS so a raced key keeps a stable handle.
   * @param {K} key
   * @param {() => V} compute
   * @returns {any}
   */
  _mintWith(key, compute) {
    const warm = this._mutex.runExclusive(() => this._keyed.get(key));
    if (warm !== undefined) {
      return warm;
    }
    const handle =
      this._kind === EntryKind.Source
        ? this._ctx.source(compute())
        : this._ctx.computedAsync(async () => compute());
    // First-writer-wins commit: on a lost race the freshly-built node is
    // orphaned and the key keeps its single stable handle.
    const { handle: stored, mutation } = this._mutex.runExclusive(() =>
      this._keyed.insert(key, handle),
    );
    // Bump off the map lock: a set can drive a dependent recompute that
    // re-enters this map.
    if (mutationChanged(mutation)) {
      this._bumpMembership();
    }
    return stored;
  }

  /**
   * Get the entry handle for `key`, minting it via `factory(key)` on first
   * access and caching it. For a slot map this is the {@link AsyncComputed} to
   * drive with `ctx.getAsync` or {@link AsyncReactiveMap#resolve}.
   * @param {K} key
   * @param {(key: K) => V} factory
   * @returns {any}
   */
  getOrInsertHandle(key, factory) {
    return this._mintWith(key, () => factory(key));
  }

  /**
   * Non-blocking observe of an existing entry: the value for a cell or resolved
   * slot, or `undefined` for a pending slot or an absent key. Non-minting.
   * @param {K} key
   * @returns {V | undefined}
   */
  observe(key) {
    const handle = this._mutex.runExclusive(() => this._keyed.get(key));
    if (handle === undefined) {
      return undefined;
    }
    return this._ctx.get(handle);
  }

  /**
   * Drive `key` to resolution and return its canonical value, minting the entry
   * via `factory(key)` first if absent. For a cell this is immediate; for a slot
   * it awaits the async recomputation.
   * @param {K} key
   * @param {(key: K) => V} factory
   * @returns {Promise<V>}
   */
  async resolve(key, factory) {
    const handle = factory === undefined ? this.handle(key) : this.getOrInsertHandle(key, factory);
    if (handle === undefined) {
      throw new Error(`resolve: key ${String(key)} is absent and no factory was given`);
    }
    return this._kind === EntryKind.Source ? this._ctx.get(handle) : this._ctx.getAsync(handle);
  }

  /**
   * Return the existing entry handle for `key`, or `undefined`. Non-minting.
   * @param {K} key
   * @returns {any}
   */
  handle(key) {
    return this._mutex.runExclusive(() => this._keyed.get(key));
  }

  /** Whether `key` is currently materialized (present). Non-reactive. */
  isPresent(key) {
    return this._mutex.runExclusive(() => this._keyed.contains(key));
  }

  /** Currently-materialized keys, in first-materialization order. */
  presentKeys() {
    return this._mutex.runExclusive(() => this._keyed.keys());
  }

  /** Number of currently-materialized entries. */
  presentCount() {
    return this._mutex.runExclusive(() => this._keyed.length());
  }

  /** This map's entry kind. */
  entryKind() {
    return this._kind;
  }

  // -- Core surface: ordering, atomic move, reactive membership ------------
  //
  // These bind every flavor. The move algebra touches no entry handle and
  // awaits nothing, so it is neither thread- nor async-coloured; the membership
  // and order signals are minted on this flavor's own graph.

  /**
   * Reactive snapshot of the keys in their current order. Subscribes the caller
   * to order changes (add/remove and move/reorder), not to per-entry values.
   *
   * Takes the caller's read surface, exactly as the single-threaded map does: a
   * compute surface registers a dependency edge, the bare context does not. A
   * read spellable only as a zero-argument call could never subscribe from
   * inside a derived node.
   * @param {{ get: (h: any) => any }} [ops]
   * @returns {K[]}
   */
  keys(ops) {
    (ops ?? this._ctx).get(this._orderSignal);
    return this.presentKeys();
  }

  /**
   * Reactive entry count. Subscribes the caller to membership changes only.
   * @param {{ get: (h: any) => any }} [ops]
   * @returns {number}
   */
  len(ops) {
    (ops ?? this._ctx).get(this._membership);
    return this.presentCount();
  }

  /**
   * Reactive emptiness check.
   * @param {{ get: (h: any) => any }} [ops]
   * @returns {boolean}
   */
  isEmpty(ops) {
    return this.len(ops) === 0;
  }

  /**
   * Reactive membership test for `key`. Subscribes to membership changes
   * (add/remove of any key), not to value changes.
   * @param {K} key
   * @param {{ get: (h: any) => any }} [ops]
   * @returns {boolean}
   */
  containsKey(key, ops) {
    (ops ?? this._ctx).get(this._membership);
    return this.isPresent(key);
  }

  /** Non-reactive count. @returns {number} */
  lenUntracked() {
    return this.presentCount();
  }

  /**
   * Current 0-based position of `key` in the order, or `undefined`.
   * Non-reactive.
   * @param {K} key
   * @returns {number | undefined}
   */
  position(key) {
    return this._mutex.runExclusive(() => this._keyed.position(key));
  }

  /**
   * Atomically move `key` to `index` (`#lzcellmove`). The entry keeps the same
   * node, its dependents, and its CRDT lineage — unlike a remove + re-mint,
   * which re-allocates and bumps membership twice. Only the order signal is
   * bumped, so `keys` readers recompute while `len` readers stay cached.
   * @param {K} key @param {number} index @returns {boolean}
   */
  moveTo(key, index) {
    return this._applyMove(this._mutex.runExclusive(() => this._keyed.moveTo(key, index)));
  }

  /**
   * Atomically move `key` to just before `anchor` (`#lzcellmove`).
   * @param {K} key @param {K} anchor @returns {boolean}
   */
  moveBefore(key, anchor) {
    return this._applyMove(this._mutex.runExclusive(() => this._keyed.moveBefore(key, anchor)));
  }

  /**
   * Atomically move `key` to just after `anchor` (`#lzcellmove`).
   * @param {K} key @param {K} anchor @returns {boolean}
   */
  moveAfter(key, anchor) {
    return this._applyMove(this._mutex.runExclusive(() => this._keyed.moveAfter(key, anchor)));
  }

  /**
   * Remove `key`'s entry and bump reactive membership. Returns whether the key
   * was present.
   * @param {K} key @returns {boolean}
   */
  remove(key) {
    const { mutation } = this._mutex.runExclusive(() => this._keyed.remove(key));
    if (!mutationChanged(mutation)) {
      return false;
    }
    // Off the map lock: the membership bump can drive a dependent recompute
    // that re-enters this map.
    this._bumpMembership();
    return true;
  }

  // -- signal plumbing ------------------------------------------------------

  /** Bump the order signal (invalidates `keys` readers). */
  _bumpOrder() {
    const next = this._mutex.runExclusive(() => {
      this._orderVersion = (this._orderVersion + 1) >>> 0;
      return this._orderVersion;
    });
    this._ctx.set(this._orderSignal, next);
  }

  /** Bump set-membership (invalidates `len`/`containsKey` readers) + order. */
  _bumpMembership() {
    const next = this._mutex.runExclusive(() => {
      this._version = (this._version + 1) >>> 0;
      return this._version;
    });
    this._ctx.set(this._membership, next);
    this._bumpOrder();
  }

  /**
   * Bump the order signal only when the order actually changed.
   * @param {string} outcome a {@link MapMove}
   * @returns {boolean}
   */
  _applyMove(outcome) {
    if (!moveApplied(outcome)) {
      return false;
    }
    if (moveChanged(outcome)) {
      this._bumpOrder();
    }
    return true;
  }
}

/**
 * An async INPUT-CELL map: every entry is an always-resolved input cell. The
 * async analog of {@link SourceMap}. Adds cell-only `set`.
 *
 * @template K, V
 * @extends {AsyncReactiveMap<K, V>}
 */
export class AsyncSourceMap extends AsyncReactiveMap {
  /** @param {import("./reactive-async.js").AsyncContext} ctx */
  constructor(ctx) {
    super(ctx, EntryKind.Source);
  }

  /**
   * Set the value at `key`, inserting a new input cell if absent. Cell-only.
   * @param {K} key
   * @param {V} value
   */
  set(key, value) {
    const existing = this._mutex.runExclusive(() => this._keyed.get(key));
    if (existing !== undefined) {
      this._ctx.set(existing, value);
      return;
    }
    this.getOrInsertHandle(key, () => value);
  }
}

/** @template K,V */
export class AsyncDependencyMap extends AsyncSourceMap {
  /** @param {K} key @returns {DependencyAvailability<V>} */
  observeDependency(key) {
    const handle = this.getOrInsertHandle(key, () => DependencyAvailability.unavailable());
    return this._ctx.get(handle);
  }

  /** @param {K} key @param {V} value */
  publish(key, value) {
    this.set(key, DependencyAvailability.available(value));
  }

  /** @param {K} key */
  unpublish(key) {
    this.set(key, DependencyAvailability.unavailable());
  }
}

/**
 * An async DERIVED-SLOT map: entries are derived slots minted lazily on access
 * or eagerly via {@link AsyncComputedMap#materializeAll}, resolved via
 * `ctx.getAsync`. The async analog of {@link ComputedMap}.
 *
 * @template K, V
 * @extends {AsyncReactiveMap<K, V>}
 */
export class AsyncComputedMap extends AsyncReactiveMap {
  /** @param {import("./reactive-async.js").AsyncContext} ctx */
  constructor(ctx) {
    super(ctx, EntryKind.Computed);
  }

  /**
   * EAGER materialization: pre-mint a derived slot for every key in `keys`.
   * Observationally identical to minting each lazily on first read.
   * @param {Iterable<K>} keys
   * @param {(key: K) => V} factory
   */
  materializeAll(keys, factory) {
    for (const key of keys) {
      this.getOrInsertHandle(key, factory);
    }
  }
}

// Deprecated aliases (`#lzcellkernel`) — see `./reactive-family.js`.

/**
 * @deprecated Renamed to {@link AsyncSourceMap}. Kept as an alias for compatibility.
 */
export const AsyncCellMap = AsyncSourceMap;

/**
 * @deprecated Renamed to {@link AsyncComputedMap}. Kept as an alias for compatibility.
 */
export const AsyncSlotMap = AsyncComputedMap;
