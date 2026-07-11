import type { CellHandle, Context, SlotHandle } from "./reactive.js";

/**
 * Which kind of reactive node a {@link ReactiveFamily} entry is — the
 * handle-kind axis the family abstracts over, orthogonal to
 * {@link MaterializationMode}.
 */
export const EntryKind: {
  /** An input cell — always materialized, any mode. */
  readonly Cell: "cell";
  /** A derived slot — materialized eagerly, or lazily on first read. */
  readonly Slot: "slot";
};
export type EntryKind = (typeof EntryKind)[keyof typeof EntryKind];

/**
 * When a {@link ReactiveFamily}'s derived (slot) entries are allocated.
 * Orthogonal to {@link EntryKind}; never observable on the value axis.
 */
export const MaterializationMode: {
  /** Allocate every derived node up front at build time. Required default. */
  readonly Eager: "eager";
  /** Allocate a derived node on its first read, keyed rather than held. */
  readonly Lazy: "lazy";
};
export type MaterializationMode =
  (typeof MaterializationMode)[keyof typeof MaterializationMode];

/** The default materialization mode (eager). */
export const DEFAULT_MATERIALIZATION_MODE: MaterializationMode;

export type EntryKindResolver<K> = EntryKind | ((key: K) => EntryKind);
export type FamilyHandle<V> = CellHandle<V> | SlotHandle<V>;

/**
 * The unified keyed reactive family (`#lzmatmode`): keys map to per-entry
 * reactive nodes (input cells or derived slots), allocated per the family's
 * {@link MaterializationMode}.
 */
export class ReactiveFamily<K = unknown, V = unknown> {
  constructor(
    ctx: Context,
    mode: MaterializationMode,
    keys: Iterable<K>,
    factory: (key: K) => V,
    entryKind?: EntryKindResolver<K>,
  );

  /** Build an eager family: every declared key's node is allocated now. */
  static eager<K, V>(
    ctx: Context,
    keys: Iterable<K>,
    factory: (key: K) => V,
    entryKind?: EntryKindResolver<K>,
  ): ReactiveFamily<K, V>;

  /** Build a lazy family: derived (slot) entries are deferred to first read. */
  static lazy<K, V>(
    ctx: Context,
    keys: Iterable<K>,
    factory: (key: K) => V,
    entryKind?: EntryKindResolver<K>,
  ): ReactiveFamily<K, V>;

  /** Build a family in the default (eager) mode. */
  static create<K, V>(
    ctx: Context,
    keys: Iterable<K>,
    factory: (key: K) => V,
    entryKind?: EntryKindResolver<K>,
  ): ReactiveFamily<K, V>;

  /** Materialize (lazy pull) and return the entry handle for `key`. */
  get(key: K): FamilyHandle<V>;
  /** Observe `key`'s value — identical under either mode. */
  observe(key: K): V;
  /** Set a cell entry's value (input entries only). */
  setCell(key: K, value: V): void;
  /** Whether `key` is currently materialized. Non-reactive. */
  isPresent(key: K): boolean;
  /** Currently-materialized keys, in first-materialization order. */
  presentKeys(): K[];
  /** Number of currently-materialized entries. */
  presentCount(): number;
  /** This family's entry kind for `key`. */
  entryKind(key: K): EntryKind;
  /** This family's materialization mode. */
  readonly mode: MaterializationMode;
}

/**
 * The input-cell specialization of {@link ReactiveFamily}: a keyed family whose
 * entries are all input cells (always materialized).
 */
export function cellFamily<K, V>(
  ctx: Context,
  keys: Iterable<K>,
  factory: (key: K) => V,
  mode?: MaterializationMode,
): ReactiveFamily<K, V>;
