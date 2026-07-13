// Phase 1 of the RelayCell backpressure plan (#relaycell) — the merge algebra
// and the Reactive/Source read/write split.
//
// See lazily-spec/docs/reactive-graph.md § "MergeCell and the merge algebra" and
// relaycell-backpressure-analysis.md §4.0/§4.3. A merge policy is an *associative*
// fold ⊕: T×T→T; the properties it satisfies (associativity always; commutativity
// = reordering tax; idempotency = durability tax) select which overflow behaviour
// is sound. `MergeCell` generalizes a plain `Cell` — `Cell ≡ MergeCell(KeepLatest)`
// — a source whose write is a merge. Backed by an ordinary cell, so it inherits
// the Phase-0 `==` store-guard and store-without-cascade.

// -- Merge policies ----------------------------------------------------------
//
// A policy is a plain object: { name, merge(old, op), commutative, idempotent,
// conflates }. Associativity is a law (verified by law-tests), not a field. The
// three flags surface the transport-selected branches; `conflates` gates the
// `Conflate` overflow (only RawFifo — concat — cannot bound, Phase 2).

/** Keep-latest band: `old ⊕ op = op`. The policy behind a plain `Cell`. */
export const KeepLatest = Object.freeze({
  name: "KeepLatest",
  merge: (_old, op) => op,
  commutative: false,
  idempotent: true,
  conflates: true,
});

/** Additive commutative monoid: `old + op`. Not idempotent. */
export const Sum = Object.freeze({
  name: "Sum",
  merge: (old, op) => old + op,
  commutative: true,
  idempotent: false,
  conflates: true,
});

/** Max semilattice: `max(old, op)`. Associative, commutative, idempotent. */
export const Max = Object.freeze({
  name: "Max",
  merge: (old, op) => (op > old ? op : old),
  commutative: true,
  idempotent: true,
  conflates: true,
});

/** Grow-only set-union semilattice over `Set`. */
export const SetUnion = Object.freeze({
  name: "SetUnion",
  merge: (old, op) => {
    const out = new Set(old);
    for (const x of op) out.add(x);
    return out;
  },
  commutative: true,
  idempotent: true,
  conflates: true,
});

/** Raw FIFO append over arrays: `old ++ op`. Order + multiplicity are meaning —
 *  associative only; cannot conflate. */
export const RawFifo = Object.freeze({
  name: "RawFifo",
  merge: (old, op) => old.concat(op),
  commutative: false,
  idempotent: false,
  conflates: false,
});

// -- MergeCell ---------------------------------------------------------------

/**
 * A cell whose write is a *merge* under `policy`, rather than a replace.
 * `Cell ≡ MergeCell(KeepLatest)`.
 */
export class MergeCell {
  /** @param {import("./reactive.js").Context} ctx */
  constructor(ctx, cell, policy) {
    this.ctx = ctx;
    /** underlying CellHandle */
    this.cell = cell;
    this.policy = policy;
    Object.freeze(this);
  }

  /** Read the current converged value (tracks a dependency inside a computation). */
  get() {
    return this.ctx.getCell(this.cell);
  }

  /** Replace the value outright (the keep-latest write), bypassing the policy. */
  set(value) {
    this.ctx.setCell(this.cell, value);
  }

  /** Fold `op` into the current value under the policy. Routes through `setCell`
   *  so the `==` store-guard (free dedup for idempotent ⊕) + store-without-cascade
   *  apply unchanged. */
  merge(op) {
    const old = this.ctx.getCell(this.cell);
    this.ctx.setCell(this.cell, this.policy.merge(old, op));
  }
}

/** Create a `MergeCell` over `ctx` with `initial` value under `policy`. */
export function mergeCell(ctx, initial, policy) {
  return new MergeCell(ctx, ctx.cell(initial), policy);
}

// -- Reactive / Source -------------------------------------------------------
//
// JavaScript is structurally typed, so the `Reactive<T>` read supertype and the
// `Source<T>: Reactive<T>` write sub-interface are documented shapes rather than
// declared types. A reader (Slot/Signal) exposes { get }; a source (Cell/MergeCell)
// exposes { get, set, merge }. `asSource` adapts a plain CellHandle to the Source
// shape (its `merge` is a replace — Cell ≡ MergeCell(KeepLatest)).

/** Adapt a plain `CellHandle` to the `Source` shape (get/set/merge). */
export function asSource(ctx, cellHandle) {
  return {
    get: () => ctx.getCell(cellHandle),
    set: (value) => ctx.setCell(cellHandle, value),
    // Cell ≡ MergeCell(KeepLatest): merge replaces.
    merge: (op) => ctx.setCell(cellHandle, op),
  };
}

/** Adapt any read handle (Slot/Signal/Cell) to the `Reactive` shape ({ get }). */
export function asReactive(ctx, handle) {
  // Cells read via getCell; slots/signals via get/getSignal. Detect by shape.
  if (handle instanceof MergeCell) return { get: () => handle.get() };
  if (handle && handle.slot !== undefined) return { get: () => ctx.getSignal(handle) };
  // Fall back: try getCell then get.
  return {
    get: () => {
      try {
        return ctx.getCell(handle);
      } catch {
        return ctx.get(handle);
      }
    },
  };
}
