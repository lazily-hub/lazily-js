// The thread-safe keyed reactive family (`ThreadSafeReactiveFamily`,
// `#lzmatmode` thread-safe flavor) — the {@link ThreadSafeContext} analog of
// {@link ReactiveFamily}.
//
// Keys `K` map to per-entry reactive nodes ({@link EntryKind.Cell} input cells /
// {@link EntryKind.Slot} derived slots) on a {@link ThreadSafeContext}, allocated
// per the family's {@link MaterializationMode}. The present-set state is guarded
// by its own {@link AtomicMutex} so a keyed family can be materialized
// concurrently from multiple realms.
//
// The eager/lazy contract, present-set monotonicity, and transparency law are
// identical to the single-threaded family. What the thread-safe flavor adds is
// MATERIALIZATION CONFLUENCE (proved in lazily-formal `Materialization` —
// `materialize_present_comm`, `materialize_observe_comm`): whatever order the
// mutex admits concurrent materializations in, the present set and every observed
// value are identical. The concurrency contract is faithfully modeled here:
// `#materializeKey` computes the node OUTSIDE the family lock, then commits under
// it with FIRST-WRITER-WINS so a raced key keeps a single stable handle.
//
// Rust reference: `lazily-rs/src/thread_safe_reactive_family.rs`.

import { EntryKind, MaterializationMode, DEFAULT_MATERIALIZATION_MODE } from "./reactive-family.js";
import { AtomicMutex } from "./thread-safe.js";

export { EntryKind, MaterializationMode, DEFAULT_MATERIALIZATION_MODE };

function resolveKind(entryKind, key) {
  const kind = typeof entryKind === "function" ? entryKind(key) : entryKind;
  if (kind !== EntryKind.Cell && kind !== EntryKind.Slot) {
    throw new TypeError(`entry kind for key ${String(key)} must be EntryKind.Cell or EntryKind.Slot`);
  }
  return kind;
}

/**
 * The thread-safe unified keyed reactive family (`#lzmatmode`): keys map to
 * per-entry reactive nodes on a {@link ThreadSafeContext}, allocated per the
 * family's {@link MaterializationMode}. Present-set state is guarded by an
 * {@link AtomicMutex}; materialization is confluent under concurrent access.
 *
 * @template K, V
 */
export class ThreadSafeReactiveFamily {
  /** @type {import("./thread-safe.js").ThreadSafeContext} */
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
  /** @type {AtomicMutex} */
  #mutex = new AtomicMutex();

  /**
   * @param {import("./thread-safe.js").ThreadSafeContext} ctx owning thread-safe context
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
      if (resolveKind(entryKind, key) === EntryKind.Cell || mode === MaterializationMode.Eager) {
        this.#materializeKey(key);
      }
    }
  }

  /** Build an eager thread-safe family: every declared key allocated now (default). */
  static eager(ctx, keys, factory, entryKind = EntryKind.Slot) {
    return new ThreadSafeReactiveFamily(ctx, MaterializationMode.Eager, keys, factory, entryKind);
  }

  /** Build a lazy thread-safe family: slot entries deferred to first read. */
  static lazy(ctx, keys, factory, entryKind = EntryKind.Slot) {
    return new ThreadSafeReactiveFamily(ctx, MaterializationMode.Lazy, keys, factory, entryKind);
  }

  /** Build a thread-safe family in the default (eager) mode. */
  static create(ctx, keys, factory, entryKind = EntryKind.Slot) {
    return ThreadSafeReactiveFamily.eager(ctx, keys, factory, entryKind);
  }

  #materializeKey(key) {
    // Fast path under the family lock; release before touching the context so a
    // slot recompute can't re-enter the family lock.
    const warm = this.#mutex.runExclusive(() => this.#materialized.get(key));
    if (warm !== undefined) {
      return warm;
    }
    const kind = resolveKind(this.#entryKind, key);
    const factory = this.#factory;
    const handle =
      kind === EntryKind.Cell
        ? this.#ctx.cell(factory(key))
        : this.#ctx.computed(() => factory(key));
    const entry = { kind, handle };
    // First-writer-wins commit: on a lost race the freshly-built node is orphaned
    // (unreferenced in the context) and the key keeps its stable handle.
    return this.#mutex.runExclusive(() => {
      const existing = this.#materialized.get(key);
      if (existing !== undefined) {
        return existing;
      }
      this.#materialized.set(key, entry);
      this.#order.push(key);
      return entry;
    });
  }

  /** Materialize (lazy pull) and return the entry handle for `key`. */
  get(key) {
    return this.#materializeKey(key).handle;
  }

  /** Observe `key`'s value — the transparency law: identical under either mode. */
  observe(key) {
    const { kind, handle } = this.#materializeKey(key);
    return kind === EntryKind.Cell ? this.#ctx.getCell(handle) : this.#ctx.get(handle);
  }

  /** Set a cell entry's value (input entries only). */
  setCell(key, value) {
    const { kind, handle } = this.#materializeKey(key);
    if (kind !== EntryKind.Cell) {
      throw new TypeError(`key ${String(key)} is a derived slot, not a writable input cell`);
    }
    this.#ctx.setCell(handle, value);
  }

  /** Whether `key` is currently materialized. Non-reactive. */
  isPresent(key) {
    return this.#mutex.runExclusive(() => this.#materialized.has(key));
  }

  /** Currently-materialized keys, in first-materialization order. */
  presentKeys() {
    return this.#mutex.runExclusive(() => [...this.#order]);
  }

  /** Number of currently-materialized entries. */
  presentCount() {
    return this.#mutex.runExclusive(() => this.#order.length);
  }

  /** This family's entry kind for `key`. */
  entryKind(key) {
    return resolveKind(this.#entryKind, key);
  }

  /** This family's materialization mode. */
  get mode() {
    return this.#mode;
  }
}

/**
 * The input-cell specialization of {@link ThreadSafeReactiveFamily}: a keyed
 * thread-safe family whose entries are all input cells (always materialized).
 * @template K, V
 * @param {import("./thread-safe.js").ThreadSafeContext} ctx
 * @param {Iterable<K>} keys
 * @param {(key: K) => V} factory
 * @param {string} [mode]
 * @returns {ThreadSafeReactiveFamily<K, V>}
 */
export function threadSafeCellFamily(ctx, keys, factory, mode = DEFAULT_MATERIALIZATION_MODE) {
  return new ThreadSafeReactiveFamily(ctx, mode, keys, factory, EntryKind.Cell);
}
