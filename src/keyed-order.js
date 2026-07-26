/**
 * The present set plus its authoritative key order, with the atomic-move
 * algebra (`#lzcellmove`).
 *
 * This is the **graph-agnostic** half of every `ReactiveMap` flavor. It holds no
 * context, no factory, and no closure: only `key -> handle` bookkeeping and the
 * key list. That is exactly why ordering and atomic move bind the
 * single-threaded, thread-safe, and async flavors alike — a move touches no
 * entry handle and awaits nothing, so it is neither thread- nor async-coloured.
 *
 * What is deliberately **not** here is reactivity. Membership and order
 * *invalidation* is a graph write, and each flavor must mint its own version
 * cells on its own graph; a shared core cannot supply them. Each flavor keeps a
 * thin shell holding this core, its own lock (if any), its own signals, and its
 * own materialize/observe.
 *
 * `entries` and `order` stay in lockstep: every key in `entries` appears exactly
 * once in `order` and vice versa, including on every failure path. Reordering
 * cannot fail — it is a splice with both ends clamped — so there is no error
 * path to desync on.
 *
 * Rust reference: `lazily-rs/src/keyed_order.rs`.
 *
 * @module
 */

/**
 * What a present-set mutation did, so the caller knows what to bump. A no-op
 * must bump nothing: bumping on a warm insert would invalidate every `len` /
 * `containsKey` reader on a pure cache hit.
 * @readonly
 * @enum {string}
 */
export const MapMutation = Object.freeze({
  None: "none",
  Inserted: "inserted",
  Removed: "removed",
});

/**
 * What an ordering move did. `Missing` and `Unchanged` are distinct because the
 * public `move*` methods report `false` for a missing key but `true` for a no-op
 * move — while neither may bump the order signal.
 * @readonly
 * @enum {string}
 */
export const MapMove = Object.freeze({
  Missing: "missing",
  Unchanged: "unchanged",
  Reordered: "reordered",
});

/** Whether the move applied at all (the boolean the public API returns). */
export const moveApplied = (outcome) => outcome !== MapMove.Missing;

/** Whether the order actually changed, i.e. whether to bump the order signal. */
export const moveChanged = (outcome) => outcome === MapMove.Reordered;

/** Whether a present-set mutation changed anything. */
export const mutationChanged = (mutation) => mutation !== MapMutation.None;

/**
 * The present set + key order + the move algebra. Closure-free.
 * @template K
 * @template H
 */
export class KeyedOrder {
  /** @type {Map<K, H>} */
  _entries = new Map();
  /** @type {K[]} */
  _order = [];

  // -- reads (no graph involvement) -----------------------------------------

  /** @param {K} key @returns {H | undefined} */
  get(key) {
    return this._entries.get(key);
  }

  /** @param {K} key @returns {boolean} */
  contains(key) {
    return this._entries.has(key);
  }

  /** A copy of the authoritative key list; the internal array never escapes. */
  keys() {
    return this._order.slice();
  }

  /** @returns {number} */
  length() {
    return this._order.length;
  }

  /** @param {K} key @returns {number | undefined} */
  position(key) {
    const at = this._order.indexOf(key);
    return at === -1 ? undefined : at;
  }

  // -- present-set mutations ------------------------------------------------

  /**
   * Insert `handle` under `key`, appending to the order. A warm key keeps its
   * existing handle (cell-identity: a key's node is stable for its lifetime)
   * and reports `None` so the caller bumps nothing.
   * @param {K} key @param {H} handle
   * @returns {{ handle: H, mutation: string }}
   */
  insert(key, handle) {
    const existing = this._entries.get(key);
    if (existing !== undefined) {
      return { handle: existing, mutation: MapMutation.None };
    }
    this._entries.set(key, handle);
    this._order.push(key);
    return { handle, mutation: MapMutation.Inserted };
  }

  /**
   * Remove `key`, returning its handle so the caller can dispose the node on its
   * own graph. The core never touches a handle.
   * @param {K} key
   * @returns {{ handle: H | undefined, mutation: string }}
   */
  remove(key) {
    const handle = this._entries.get(key);
    if (handle === undefined) {
      return { handle: undefined, mutation: MapMutation.None };
    }
    this._entries.delete(key);
    const at = this._order.indexOf(key);
    if (at !== -1) {
      this._order.splice(at, 1);
    }
    return { handle, mutation: MapMutation.Removed };
  }

  // -- the move algebra -----------------------------------------------------

  /**
   * Move `key` to `index`, clamped to `[0, len)`. The entry keeps the same
   * handle, its dependents, and its CRDT lineage — that is what separates a
   * reorder from a remove + re-mint.
   *
   * BOTH ends are clamped. Clamping only the upper end let a negative index
   * reach `Array.prototype.splice`'s count-from-the-end semantics, so
   * `moveTo(key, -1)` inserted the key before the LAST element instead of at the
   * front. `src/collections.js` clamped correctly and `reactive-family.js` did
   * not — two implementations of one contract disagreeing, untested in both.
   *
   * @param {K} key @param {number} index
   * @returns {string} a {@link MapMove}
   */
  moveTo(key, index) {
    const from = this._order.indexOf(key);
    if (from === -1) {
      return MapMove.Missing;
    }
    const to = Math.max(0, Math.min(index, this._order.length - 1));
    if (from === to) {
      return MapMove.Unchanged;
    }
    this._order.splice(from, 1);
    this._order.splice(to, 0, key);
    return MapMove.Reordered;
  }

  /**
   * Move `key` to just before `anchor`.
   *
   * The target is computed on the **pre-removal** list: when `key` currently
   * precedes `anchor`, lifting it out shifts `anchor` one slot left, so the
   * insertion point is `anchor - 1`. Getting this wrong lands the key on the far
   * side of its anchor — the defect found in lazily-zig, where
   * `moveBefore("a", "d")` on `[a,b,c,d]` produced `[b,c,d,a]`.
   *
   * @param {K} key @param {K} anchor
   * @returns {string} a {@link MapMove}
   */
  moveBefore(key, anchor) {
    const anchorIdx = this.position(anchor);
    const from = this.position(key);
    if (anchorIdx === undefined || from === undefined) {
      return MapMove.Missing;
    }
    return this.moveTo(key, from < anchorIdx ? anchorIdx - 1 : anchorIdx);
  }

  /**
   * Move `key` to just after `anchor`. Same pre-removal reasoning.
   * @param {K} key @param {K} anchor
   * @returns {string} a {@link MapMove}
   */
  moveAfter(key, anchor) {
    const anchorIdx = this.position(anchor);
    const from = this.position(key);
    if (anchorIdx === undefined || from === undefined) {
      return MapMove.Missing;
    }
    return this.moveTo(key, from <= anchorIdx ? anchorIdx : anchorIdx + 1);
  }
}
