// Keyed cell collections: CellMap + LIS keyed reconciliation (cell-model.md
// § Keyed cell collections). Pure logic — no reactive graph. Like the state
// chart, this is compute that every binding (including this state-projection
// consumer) MUST implement; the conformance/collections/ fixtures pin behavior.
//
// Invalidation classes mirror the reactive independence contract: a value write
// touches only value readers of that key; an insert/remove touches membership +
// order readers; a pure reorder (atomic move) touches only order readers and
// keeps the entry's stable handle (never remove + re-mint).

function deepEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((k) => Object.is(aKeys[k], bKeys[k])) &&
    aKeys.every((k) => deepEqual(a[k], b[k]))
  );
}

function indexOfKey(order, key) {
  const index = order.indexOf(key);
  if (index === -1) {
    throw new RangeError(`CellMap key not present: ${String(key)}`);
  }
  return index;
}

// Longest strictly-increasing subsequence, returned as indices into `seq`.
// Classic patience-sorting reconstruction (O(n log n)); ties break toward the
// earliest equal value so the stable set is the longest possible.
function longestIncreasingSubsequence(seq) {
  const n = seq.length;
  if (n === 0) {
    return [];
  }
  const tails = []; // tails[i] = index (into seq) of the smallest tail of an IS of length i+1
  const prev = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const value = seq[i];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (seq[tails[mid]] < value) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    if (lo > 0) {
      prev[i] = tails[lo - 1];
    }
    tails[lo] = i;
  }
  const lis = [];
  for (let cursor = tails[tails.length - 1]; cursor !== -1; cursor = prev[cursor]) {
    lis.push(cursor);
  }
  return lis.reverse();
}

export class CellMap {
  constructor(initial = {}) {
    const order = Array.isArray(initial.order) ? [...initial.order] : [];
    const values = initial.values ?? {};
    this.order = order;
    this.values = new Map();
    this.handles = new Map();
    this.#nextHandle = 0;
    for (const key of order) {
      this.values.set(key, values[key]);
      this.handles.set(key, this.#nextHandle++);
    }
    Object.freeze(this);
  }

  #nextHandle;

  static from(initial) {
    return new CellMap(initial);
  }

  keys() {
    return [...this.order];
  }

  has(key) {
    return this.handles.has(key);
  }

  get(key) {
    return this.values.get(key);
  }

  handle(key) {
    return this.handles.get(key);
  }

  snapshot() {
    const values = {};
    for (const [key, value] of this.values) {
      values[key] = value;
    }
    return { order: [...this.order], values };
  }

  // Dispatch a fixture op; returns the invalidation report
  // { value: key[], membership: bool, order: bool }.
  apply(op) {
    switch (op.type) {
      case "set_value":
        return this.setValue(op.key, op.value);
      case "insert":
        return this.insert(op.key, op.value, op.at);
      case "remove":
        return this.remove(op.key);
      case "move_to":
        return this.moveTo(op.key, op.index);
      case "move_before":
        return this.moveBefore(op.key, op.before);
      case "move_after":
        return this.moveAfter(op.key, op.after);
      default:
        throw new TypeError(`unknown CellMap op type: ${op.type}`);
    }
  }

  setValue(key, value) {
    if (!this.handles.has(key)) {
      // No fixture exercises this; treat as a value-less insert to stay total.
      return this.insert(key, value, "end");
    }
    const changed = !deepEqual(this.values.get(key), value);
    if (changed) {
      this.values.set(key, value);
    }
    return { value: changed ? [key] : [], membership: false, order: false };
  }

  insert(key, value, at = "end") {
    if (this.handles.has(key)) {
      throw new RangeError(`CellMap key already present: ${String(key)}`);
    }
    let index;
    if (at === "end") {
      index = this.order.length;
    } else if (at === "start") {
      index = 0;
    } else if (typeof at === "number") {
      index = Math.max(0, Math.min(at, this.order.length));
    } else {
      index = indexOfKey(this.order, at) + 1; // anchor key → insert after it
    }
    this.order.splice(index, 0, key);
    this.values.set(key, value);
    this.handles.set(key, this.#nextHandle++);
    return { value: [], membership: true, order: true };
  }

  remove(key) {
    const index = indexOfKey(this.order, key);
    this.order.splice(index, 1);
    this.values.delete(key);
    this.handles.delete(key);
    return { value: [], membership: true, order: true };
  }

  moveTo(key, index) {
    const from = indexOfKey(this.order, key);
    const to = Math.max(0, Math.min(index, this.order.length - 1));
    if (from !== to) {
      this.order.splice(from, 1);
      this.order.splice(to, 0, key);
    }
    return { value: [], membership: false, order: true };
  }

  moveBefore(key, beforeKey) {
    return this.#reorderBefore(key, indexOfKey(this.order, beforeKey));
  }

  moveAfter(key, afterKey) {
    return this.#reorderBefore(key, indexOfKey(this.order, afterKey) + 1);
  }

  #reorderBefore(key, targetSlot) {
    const from = indexOfKey(this.order, key);
    // Remove first, then compute the slot in the shortened order so an anchor
    // before the moved key does not shift past it.
    this.order.splice(from, 1);
    let slot = targetSlot;
    if (from < targetSlot) {
      slot = targetSlot - 1;
    }
    slot = Math.max(0, Math.min(slot, this.order.length));
    this.order.splice(slot, 0, key);
    // Handle is untouched — a move is never a remove + re-mint.
    return { value: [], membership: false, order: true };
  }
}

// Standalone keyed reconciliation (cell-model.md § Keyed reconciliation).
// Diffs two keyed sequences BY STABLE KEY, not position, emitting the minimal
// {remove, move, insert} op set. Keys already in relative order (the longest
// increasing subsequence over their prior indices) MUST NOT move, and stable
// entries with unchanged values are not invalidated by a sibling reorder.
export function reconcileCollections(prior, target) {
  const priorOrder = Array.isArray(prior.order) ? [...prior.order] : [];
  const priorValues = prior.values ?? {};
  const targetOrder = Array.isArray(target.order) ? [...target.order] : [];
  const targetValues = target.values ?? {};

  const priorIndex = new Map(priorOrder.map((key, i) => [key, i]));
  const targetSet = new Set(targetOrder);

  const commonInTarget = targetOrder.filter((key) => priorIndex.has(key));
  const priorIndices = commonInTarget.map((key) => priorIndex.get(key));
  const lisPositions = new Set(longestIncreasingSubsequence(priorIndices));
  const stableKeys = new Set(
    commonInTarget.filter((_, i) => lisPositions.has(i)),
  );

  // Stable entries whose value is also unchanged keep their value cell intact.
  const stableKeysNotInvalidated = commonInTarget.filter(
    (key) =>
      stableKeys.has(key) && deepEqual(priorValues[key], targetValues[key]),
  );

  const ops = [];
  // 1. removals (prior-only keys), in prior order.
  for (const key of priorOrder) {
    if (!targetSet.has(key)) {
      ops.push({ type: "remove", key });
    }
  }
  // 2. moves + inserts, walking the target order; each is anchored after the
  //    previously placed key (stable entries are already placed).
  let placedAfter = null;
  for (const key of targetOrder) {
    if (stableKeys.has(key)) {
      placedAfter = key;
      continue;
    }
    if (priorIndex.has(key)) {
      ops.push({ type: "move", key, after: placedAfter });
    } else {
      ops.push({ type: "insert", key, value: targetValues[key], after: placedAfter });
    }
    placedAfter = key;
  }

  return {
    ops,
    result_order: [...targetOrder],
    stable_keys_not_invalidated: stableKeysNotInvalidated,
  };
}
