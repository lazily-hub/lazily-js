// The unified keyed reactive family (`ReactiveFamily`) and its materialization
// mode (`#lzmatmode`).
//
// `lazily-spec/cell-model.md` § "The `ReactiveFamily` vehicle" fixes a keyed
// reactive family that maps keys `K` to per-entry reactive nodes and abstracts
// over the entry's handle kind (`ReactiveFamily<K, V, H>`):
//
//   - Cell entries (`EntryKind.Cell`) are INPUT nodes. An input has no
//     derivation to defer, so it is ALWAYS materialized regardless of mode. The
//     keyed cell collection (`CellFamily`) is this input-cell specialization.
//   - Slot entries (`EntryKind.Slot`) are DERIVED nodes. These are what
//     materialization mode governs: eager allocates up front, lazy defers each
//     to first read.
//
// Materialization mode is orthogonal to entry kind and MUST NOT be observable
// through any cell's value — it changes allocation timing and memory, never
// results. `Eager` is the required default; `Lazy` is an opt-in keyed overlay
// on the eager core (the first read of key `k` builds the same node the eager
// build would have, then caches it).
//
// Rust reference: `lazily-rs/src/reactive_family.rs`. Formal proof:
// `lazily-formal` `Materialization` module (observe_canonical,
// eager_lazy_observationally_equivalent, cell_entries_materialized_in_every_mode,
// slot_entries_deferred_under_lazy, materialize_present_monotone,
// lazy_present_subset_eager, materialize_preserves_observe).

/**
 * Which kind of reactive node a {@link ReactiveFamily} entry is — the
 * handle-kind axis the family abstracts over, kept orthogonal to
 * {@link MaterializationMode}. Mirrors `EntryKind` in `lazily-formal`.
 * @enum {string}
 */
export const EntryKind = Object.freeze({
  /** An input cell — always materialized, any mode. */
  Cell: "cell",
  /** A derived slot — materialized eagerly, or lazily on first read. */
  Slot: "slot",
});

/**
 * When a {@link ReactiveFamily}'s derived (slot) entries are allocated.
 * Orthogonal to {@link EntryKind}; never observable on the value axis. Mirrors
 * `Mode` in `lazily-formal`. The default is {@link MaterializationMode.Eager}.
 * @enum {string}
 */
export const MaterializationMode = Object.freeze({
  /** Allocate every derived node up front at build time. Required default. */
  Eager: "eager",
  /** Allocate a derived node on its first read, keyed rather than held. */
  Lazy: "lazy",
});

/** The default materialization mode (`Mode.default = Mode.eager`). */
export const DEFAULT_MATERIALIZATION_MODE = MaterializationMode.Eager;

function resolveKind(entryKind, key) {
  const kind = typeof entryKind === "function" ? entryKind(key) : entryKind;
  if (kind !== EntryKind.Cell && kind !== EntryKind.Slot) {
    throw new TypeError(`entry kind for key ${String(key)} must be EntryKind.Cell or EntryKind.Slot`);
  }
  return kind;
}

/**
 * The unified keyed reactive family (`#lzmatmode`): keys map to per-entry
 * reactive nodes ({@link EntryKind.Cell} input cells or {@link EntryKind.Slot}
 * derived slots), allocated per the family's {@link MaterializationMode}.
 *
 * Operations run against the owning `Context` (from `./reactive.js`), like the
 * rest of `lazily`.
 *
 * @template K, V
 */
export class ReactiveFamily {
  /** @type {import("./reactive.js").Context} */
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
   * @param {import("./reactive.js").Context} ctx owning context
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
      // only under eager. (buildEager materializes every node; buildLazy
      // materializes only input cells — `present := isInput`.)
      if (resolveKind(entryKind, key) === EntryKind.Cell || mode === MaterializationMode.Eager) {
        this.#materializeKey(key);
      }
    }
  }

  /**
   * Build an eager family: every declared key's node is allocated now. The
   * default mode.
   * @template K, V
   * @param {import("./reactive.js").Context} ctx
   * @param {Iterable<K>} keys
   * @param {(key: K) => V} factory
   * @param {EntryKind | ((key: K) => EntryKind)} [entryKind]
   * @returns {ReactiveFamily<K, V>}
   */
  static eager(ctx, keys, factory, entryKind = EntryKind.Slot) {
    return new ReactiveFamily(ctx, MaterializationMode.Eager, keys, factory, entryKind);
  }

  /**
   * Build a lazy family: derived (slot) entries are deferred to first read;
   * input (cell) entries in `keys` are still materialized at build. Pass an
   * empty `keys` for a purely on-demand slot family.
   * @template K, V
   * @param {import("./reactive.js").Context} ctx
   * @param {Iterable<K>} keys
   * @param {(key: K) => V} factory
   * @param {EntryKind | ((key: K) => EntryKind)} [entryKind]
   * @returns {ReactiveFamily<K, V>}
   */
  static lazy(ctx, keys, factory, entryKind = EntryKind.Slot) {
    return new ReactiveFamily(ctx, MaterializationMode.Lazy, keys, factory, entryKind);
  }

  /**
   * Build a family in the default mode (eager). Alias for {@link ReactiveFamily.eager}.
   * @template K, V
   * @param {import("./reactive.js").Context} ctx
   * @param {Iterable<K>} keys
   * @param {(key: K) => V} factory
   * @param {EntryKind | ((key: K) => EntryKind)} [entryKind]
   * @returns {ReactiveFamily<K, V>}
   */
  static create(ctx, keys, factory, entryKind = EntryKind.Slot) {
    return ReactiveFamily.eager(ctx, keys, factory, entryKind);
  }

  #materializeKey(key) {
    const existing = this.#materialized.get(key);
    if (existing !== undefined) {
      return existing; // warm: already allocated.
    }
    const kind = resolveKind(this.#entryKind, key);
    const factory = this.#factory;
    // A cell entry sets its value directly (materialize-by-set); a slot entry
    // wraps the factory as its recomputation — the same node an eager build
    // would allocate.
    const handle =
      kind === EntryKind.Cell
        ? this.#ctx.cell(factory(key))
        : this.#ctx.computed(() => factory(key));
    const entry = { kind, handle };
    this.#materialized.set(key, entry);
    this.#order.push(key);
    return entry;
  }

  /**
   * Get the entry handle for `key`, materializing it on first access (the lazy
   * pull) and caching it. Under eager mode an entry is already present.
   * @param {K} key
   * @returns {import("./reactive.js").CellHandle<V> | import("./reactive.js").SlotHandle<V>}
   */
  get(key) {
    return this.#materializeKey(key).handle;
  }

  /**
   * Observe `key`'s value — the transparency law: the returned value is
   * identical under either mode. Materializes the entry if absent.
   * @param {K} key
   * @returns {V}
   */
  observe(key) {
    const { kind, handle } = this.#materializeKey(key);
    return kind === EntryKind.Cell ? this.#ctx.getCell(handle) : this.#ctx.get(handle);
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
   * Whether `key` is currently materialized (present in the allocated set).
   * Non-reactive.
   * @param {K} key
   * @returns {boolean}
   */
  isPresent(key) {
    return this.#materialized.has(key);
  }

  /**
   * The currently-materialized keys, in first-materialization order. The
   * present set only grows (deferral, not de-allocation).
   * @returns {K[]}
   */
  presentKeys() {
    return [...this.#order];
  }

  /**
   * Number of currently-materialized entries.
   * @returns {number}
   */
  presentCount() {
    return this.#order.length;
  }

  /**
   * This family's entry kind for `key` ({@link EntryKind.Cell} or
   * {@link EntryKind.Slot}).
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
 * The input-cell specialization of {@link ReactiveFamily}: a keyed family whose
 * entries are all input cells ({@link EntryKind.Cell} — always materialized).
 * Convenience factory that fixes `entryKind` to `Cell`.
 * @template K, V
 * @param {import("./reactive.js").Context} ctx
 * @param {Iterable<K>} keys
 * @param {(key: K) => V} factory
 * @param {string} [mode] {@link MaterializationMode} (cell entries materialize under either)
 * @returns {ReactiveFamily<K, V>}
 */
export function cellFamily(ctx, keys, factory, mode = DEFAULT_MATERIALIZATION_MODE) {
  return new ReactiveFamily(ctx, mode, keys, factory, EntryKind.Cell);
}
