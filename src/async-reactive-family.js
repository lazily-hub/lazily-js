// The async keyed reactive family (`AsyncReactiveFamily`, `#lzmatmode` async
// flavor) — the {@link AsyncContext} analog of {@link ReactiveFamily}.
//
// Keys `K` map to per-entry async reactive nodes: {@link EntryKind.Cell} input
// cells ({@link AsyncCellHandle}, always resolved) or {@link EntryKind.Slot}
// derived slots ({@link AsyncSlotHandle}, resolved asynchronously), allocated per
// the family's {@link MaterializationMode}.
//
// The eager/lazy contract and present-set monotonicity are identical to the
// single-threaded family. The transparency law here is EVENTUAL: an async derived
// slot read is `undefined` while pending and resolves to the canonical value — so
// `observe` returns `V | undefined`. Input cells are always resolved. Drive a slot
// to resolution with {@link AsyncReactiveFamily#resolve} (or
// `ctx.getAsync(fam.get(key))`).
//
// To keep the sync/thread-safe/async families API-parallel the per-key factory is
// the same sync `(key) => V`; a derived slot wraps it in a ready async
// recomputation. Mirrors the async materialization case in lazily-spec and the
// `AsyncMaterialization` proofs (eventual transparency) in lazily-formal.
//
// Rust reference: `lazily-rs/src/async_reactive_family.rs`.

import { EntryKind, MaterializationMode, DEFAULT_MATERIALIZATION_MODE } from "./reactive-family.js";

export { EntryKind, MaterializationMode, DEFAULT_MATERIALIZATION_MODE };

function resolveKind(entryKind, key) {
  const kind = typeof entryKind === "function" ? entryKind(key) : entryKind;
  if (kind !== EntryKind.Cell && kind !== EntryKind.Slot) {
    throw new TypeError(`entry kind for key ${String(key)} must be EntryKind.Cell or EntryKind.Slot`);
  }
  return kind;
}

/**
 * The async unified keyed reactive family (`#lzmatmode`): keys map to per-entry
 * async reactive nodes ({@link EntryKind.Cell} input cells resolved
 * synchronously, or {@link EntryKind.Slot} derived slots resolved
 * asynchronously), allocated per the family's {@link MaterializationMode}.
 *
 * Operations run against an owning `AsyncContext` (from `./reactive-async.js`).
 *
 * @template K, V
 */
export class AsyncReactiveFamily {
  /** @type {import("./reactive-async.js").AsyncContext} */
  #ctx;
  /** @type {string} */
  #mode;
  /** @type {(key: K) => V} */
  #factory;
  /** @type {EntryKind | ((key: K) => EntryKind)} */
  #entryKind;
  /** Present (materialized) entries: key -> { kind, handle }. */
  #materialized = new Map();
  /** First-materialization order of the present set. */
  #order = [];

  /**
   * @param {import("./reactive-async.js").AsyncContext} ctx owning async context
   * @param {string} mode {@link MaterializationMode}
   * @param {Iterable<K>} keys declared keys
   * @param {(key: K) => V} factory canonical per-key value producer
   * @param {EntryKind | ((key: K) => EntryKind)} [entryKind] entry kind (or per-key resolver); defaults to Slot
   */
  constructor(ctx, mode, keys, factory, entryKind = EntryKind.Slot) {
    if (mode !== MaterializationMode.Eager && mode !== MaterializationMode.Lazy) {
      throw new TypeError("mode must be a MaterializationMode");
    }
    if (typeof factory !== "function") {
      throw new TypeError("factory must be a function");
    }
    this.#ctx = ctx;
    this.#mode = mode;
    this.#factory = factory;
    this.#entryKind = entryKind;

    for (const key of keys) {
      // A cell entry is always materialized regardless of mode; a slot entry
      // only under eager.
      if (resolveKind(entryKind, key) === EntryKind.Cell || mode === MaterializationMode.Eager) {
        this.#materializeKey(key);
      }
    }
  }

  /**
   * Build an eager async family: every declared key's node is allocated now. The
   * default mode.
   * @template K, V
   * @param {import("./reactive-async.js").AsyncContext} ctx
   * @param {Iterable<K>} keys
   * @param {(key: K) => V} factory
   * @param {EntryKind | ((key: K) => EntryKind)} [entryKind]
   * @returns {AsyncReactiveFamily<K, V>}
   */
  static eager(ctx, keys, factory, entryKind = EntryKind.Slot) {
    return new AsyncReactiveFamily(ctx, MaterializationMode.Eager, keys, factory, entryKind);
  }

  /**
   * Build a lazy async family: derived (slot) entries deferred to first read;
   * input (cell) entries in `keys` are still materialized at build.
   * @template K, V
   * @param {import("./reactive-async.js").AsyncContext} ctx
   * @param {Iterable<K>} keys
   * @param {(key: K) => V} factory
   * @param {EntryKind | ((key: K) => EntryKind)} [entryKind]
   * @returns {AsyncReactiveFamily<K, V>}
   */
  static lazy(ctx, keys, factory, entryKind = EntryKind.Slot) {
    return new AsyncReactiveFamily(ctx, MaterializationMode.Lazy, keys, factory, entryKind);
  }

  /**
   * Build an async family in the default mode (eager). Alias for
   * {@link AsyncReactiveFamily.eager}.
   * @template K, V
   * @param {import("./reactive-async.js").AsyncContext} ctx
   * @param {Iterable<K>} keys
   * @param {(key: K) => V} factory
   * @param {EntryKind | ((key: K) => EntryKind)} [entryKind]
   * @returns {AsyncReactiveFamily<K, V>}
   */
  static create(ctx, keys, factory, entryKind = EntryKind.Slot) {
    return AsyncReactiveFamily.eager(ctx, keys, factory, entryKind);
  }

  #materializeKey(key) {
    const existing = this.#materialized.get(key);
    if (existing !== undefined) {
      return existing; // warm: already allocated (first-writer-wins, stable handle).
    }
    const kind = resolveKind(this.#entryKind, key);
    const factory = this.#factory;
    // A cell entry sets its value directly (always resolved); a derived slot
    // wraps the factory as a ready async recomputation — the same node an eager
    // build would allocate.
    const handle =
      kind === EntryKind.Cell
        ? this.#ctx.cell(factory(key))
        : this.#ctx.computedAsync(async () => factory(key));
    const entry = { kind, handle };
    this.#materialized.set(key, entry);
    this.#order.push(key);
    return entry;
  }

  /**
   * Get the entry handle for `key`, materializing it on first access (the lazy
   * pull) and caching it. For a slot family this is the {@link AsyncSlotHandle}
   * to drive with `ctx.getAsync` or {@link AsyncReactiveFamily#resolve}.
   * @param {K} key
   * @returns {import("./reactive-async.js").AsyncCellHandle | import("./reactive-async.js").AsyncSlotHandle}
   */
  get(key) {
    return this.#materializeKey(key).handle;
  }

  /**
   * Non-blocking observe: the resolved value for a cell or resolved slot, or
   * `undefined` for a slot still pending. The EVENTUAL-transparency law: once
   * resolved this equals the canonical value under either mode. Materializes the
   * entry if absent.
   * @param {K} key
   * @returns {V | undefined}
   */
  observe(key) {
    const { kind, handle } = this.#materializeKey(key);
    return kind === EntryKind.Cell ? this.#ctx.getCell(handle) : this.#ctx.get(handle);
  }

  /**
   * Drive `key` to resolution and return its canonical value. For a cell this is
   * immediate; for a slot it awaits the async recomputation. Materializes the
   * entry if absent.
   * @param {K} key
   * @returns {Promise<V>}
   */
  async resolve(key) {
    const { kind, handle } = this.#materializeKey(key);
    return kind === EntryKind.Cell ? this.#ctx.getCell(handle) : this.#ctx.getAsync(handle);
  }

  /**
   * Set a cell entry's value (input entries only). Materializes it if absent.
   * @param {K} key
   * @param {V} value
   */
  setCell(key, value) {
    const { kind, handle } = this.#materializeKey(key);
    if (kind !== EntryKind.Cell) {
      throw new TypeError(`key ${String(key)} is a derived slot, not a writable input cell`);
    }
    this.#ctx.setCell(handle, value);
  }

  /**
   * Whether `key` is currently materialized (present). Non-reactive.
   * @param {K} key
   * @returns {boolean}
   */
  isPresent(key) {
    return this.#materialized.has(key);
  }

  /**
   * The currently-materialized keys, in first-materialization order. The present
   * set only grows (deferral, not de-allocation).
   * @returns {K[]}
   */
  presentKeys() {
    return [...this.#order];
  }

  /** Number of currently-materialized entries. @returns {number} */
  presentCount() {
    return this.#order.length;
  }

  /**
   * This family's entry kind for `key`.
   * @param {K} key
   * @returns {EntryKind}
   */
  entryKind(key) {
    return resolveKind(this.#entryKind, key);
  }

  /** This family's materialization mode. @returns {MaterializationMode} */
  get mode() {
    return this.#mode;
  }
}

/**
 * The input-cell specialization of {@link AsyncReactiveFamily}: a keyed async
 * family whose entries are all input cells ({@link EntryKind.Cell} — always
 * materialized, always resolved).
 * @template K, V
 * @param {import("./reactive-async.js").AsyncContext} ctx
 * @param {Iterable<K>} keys
 * @param {(key: K) => V} factory
 * @param {string} [mode] {@link MaterializationMode} (cell entries materialize under either)
 * @returns {AsyncReactiveFamily<K, V>}
 */
export function asyncCellFamily(ctx, keys, factory, mode = DEFAULT_MATERIALIZATION_MODE) {
  return new AsyncReactiveFamily(ctx, mode, keys, factory, EntryKind.Cell);
}
