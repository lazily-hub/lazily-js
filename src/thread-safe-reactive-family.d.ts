import type { CellHandle, SlotHandle } from "./reactive.js";
import type { EntryKind } from "./reactive-family.js";
import type { ThreadSafeContext } from "./thread-safe.js";

export { EntryKind } from "./reactive-family.js";

/** The entry handle a {@link ThreadSafeReactiveMap} holds. */
export type MapHandle<V> = CellHandle<V> | SlotHandle<V>;

/**
 * The thread-safe keyed reactive collection (`#reactivemap`, thread-safe flavor):
 * keys map to per-entry reactive nodes on a {@link ThreadSafeContext}. Present-set
 * state is guarded by a mutex; materialization is confluent under concurrent
 * access. Its two specializations are {@link ThreadSafeSourceMap} and
 * {@link ThreadSafeComputedMap}.
 */
export class ThreadSafeReactiveMap<K = unknown, V = unknown> {
  constructor(ctx: ThreadSafeContext, kind?: EntryKind);

  /** Get the entry handle for `key`, minting via `factory(key)` if absent. */
  getOrInsertHandle(key: K, factory: (key: K) => V): MapHandle<V>;
  /** Get the value at `key`, minting via `factory(key)` if absent. */
  getOrInsertWith(key: K, factory: (key: K) => V): V;
  /** Observe `key`'s value if present, else `undefined`. Non-minting. */
  observe(key: K): V | undefined;
  /** The existing entry handle for `key`, or `undefined`. Non-minting. */
  handle(key: K): MapHandle<V> | undefined;
  /** Whether `key` is currently materialized. Non-reactive. */
  isPresent(key: K): boolean;
  /** Currently-materialized keys, in first-materialization order. */
  presentKeys(): K[];
  /** Number of currently-materialized entries. */
  presentCount(): number;
  /** This map's entry kind. */
  entryKind(): EntryKind;
}

/**
 * The thread-safe input-cell map: every entry is an always-materialized input
 * cell. Adds cell-only `set`.
 */
export class ThreadSafeSourceMap<K = unknown, V = unknown> extends ThreadSafeReactiveMap<K, V> {
  constructor(ctx: ThreadSafeContext);
  /** Set the value at `key`, inserting a new input cell if absent. Cell-only. */
  set(key: K, value: V): void;
}

/**
 * The thread-safe derived-slot map: entries are derived slots minted lazily on
 * access or eagerly via `materializeAll`. NO `set`.
 */
export class ThreadSafeComputedMap<K = unknown, V = unknown> extends ThreadSafeReactiveMap<K, V> {
  constructor(ctx: ThreadSafeContext);
  /** Eager materialization: pre-mint a derived slot for every key in `keys`. */
  materializeAll(keys: Iterable<K>, factory: (key: K) => V): void;
}

/**
 * @deprecated Renamed to {@link ThreadSafeSourceMap}. Kept as an alias for compatibility.
 */
export const ThreadSafeCellMap: typeof ThreadSafeSourceMap;
/**
 * @deprecated Renamed to {@link ThreadSafeSourceMap}. Kept as an alias for compatibility.
 */
export type ThreadSafeCellMap<K = unknown, V = unknown> = ThreadSafeSourceMap<K, V>;

/**
 * @deprecated Renamed to {@link ThreadSafeComputedMap}. Kept as an alias for compatibility.
 */
export const ThreadSafeSlotMap: typeof ThreadSafeComputedMap;
/**
 * @deprecated Renamed to {@link ThreadSafeComputedMap}. Kept as an alias for compatibility.
 */
export type ThreadSafeSlotMap<K = unknown, V = unknown> = ThreadSafeComputedMap<K, V>;
