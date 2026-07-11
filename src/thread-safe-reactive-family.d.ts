import type { CellHandle, SlotHandle } from "./reactive.js";
import type { EntryKind, MaterializationMode } from "./reactive-family.js";
import type { ThreadSafeContext } from "./thread-safe.js";

export { EntryKind, MaterializationMode, DEFAULT_MATERIALIZATION_MODE } from "./reactive-family.js";

export type EntryKindResolver<K> = EntryKind | ((key: K) => EntryKind);
export type FamilyHandle<V> = CellHandle<V> | SlotHandle<V>;

/**
 * The thread-safe keyed reactive family (`#lzmatmode`, thread-safe flavor): keys
 * map to per-entry reactive nodes on a {@link ThreadSafeContext}, allocated per
 * the family's {@link MaterializationMode}. Materialization is confluent under
 * concurrent access.
 */
export class ThreadSafeReactiveFamily<K = unknown, V = unknown> {
  constructor(
    ctx: ThreadSafeContext,
    mode: MaterializationMode,
    keys: Iterable<K>,
    factory: (key: K) => V,
    entryKind?: EntryKindResolver<K>,
  );

  static eager<K, V>(
    ctx: ThreadSafeContext,
    keys: Iterable<K>,
    factory: (key: K) => V,
    entryKind?: EntryKindResolver<K>,
  ): ThreadSafeReactiveFamily<K, V>;

  static lazy<K, V>(
    ctx: ThreadSafeContext,
    keys: Iterable<K>,
    factory: (key: K) => V,
    entryKind?: EntryKindResolver<K>,
  ): ThreadSafeReactiveFamily<K, V>;

  static create<K, V>(
    ctx: ThreadSafeContext,
    keys: Iterable<K>,
    factory: (key: K) => V,
    entryKind?: EntryKindResolver<K>,
  ): ThreadSafeReactiveFamily<K, V>;

  get(key: K): FamilyHandle<V>;
  observe(key: K): V;
  setCell(key: K, value: V): void;
  isPresent(key: K): boolean;
  presentKeys(): K[];
  presentCount(): number;
  entryKind(key: K): EntryKind;
  readonly mode: MaterializationMode;
}

/**
 * The input-cell specialization of {@link ThreadSafeReactiveFamily}: a keyed
 * thread-safe family whose entries are all input cells (always materialized).
 */
export function threadSafeCellFamily<K, V>(
  ctx: ThreadSafeContext,
  keys: Iterable<K>,
  factory: (key: K) => V,
  mode?: MaterializationMode,
): ThreadSafeReactiveFamily<K, V>;
