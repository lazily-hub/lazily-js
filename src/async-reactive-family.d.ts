import type { AsyncCellHandle, AsyncContext, AsyncSlotHandle } from "./reactive-async.js";
import type { EntryKind, MaterializationMode } from "./reactive-family.js";

export { EntryKind, MaterializationMode, DEFAULT_MATERIALIZATION_MODE } from "./reactive-family.js";

export type EntryKindResolver<K> = EntryKind | ((key: K) => EntryKind);
export type AsyncFamilyHandle = AsyncCellHandle | AsyncSlotHandle;

/**
 * The async keyed reactive family (`#lzmatmode`, async flavor): keys map to
 * per-entry async reactive nodes (input cells resolved synchronously, or derived
 * slots resolved asynchronously), allocated per the family's
 * {@link MaterializationMode}. The transparency law is EVENTUAL — a pending slot
 * observes as `undefined` and resolves to the canonical value.
 */
export class AsyncReactiveFamily<K = unknown, V = unknown> {
  constructor(
    ctx: AsyncContext,
    mode: MaterializationMode,
    keys: Iterable<K>,
    factory: (key: K) => V,
    entryKind?: EntryKindResolver<K>,
  );

  /** Build an eager async family: every declared key's node is allocated now. */
  static eager<K, V>(
    ctx: AsyncContext,
    keys: Iterable<K>,
    factory: (key: K) => V,
    entryKind?: EntryKindResolver<K>,
  ): AsyncReactiveFamily<K, V>;

  /** Build a lazy async family: derived (slot) entries deferred to first read. */
  static lazy<K, V>(
    ctx: AsyncContext,
    keys: Iterable<K>,
    factory: (key: K) => V,
    entryKind?: EntryKindResolver<K>,
  ): AsyncReactiveFamily<K, V>;

  /** Build an async family in the default (eager) mode. */
  static create<K, V>(
    ctx: AsyncContext,
    keys: Iterable<K>,
    factory: (key: K) => V,
    entryKind?: EntryKindResolver<K>,
  ): AsyncReactiveFamily<K, V>;

  /** Materialize (lazy pull) and return the entry handle for `key`. */
  get(key: K): AsyncFamilyHandle;
  /** Non-blocking observe: value for a cell/resolved slot, `undefined` if pending. */
  observe(key: K): V | undefined;
  /** Drive `key` to resolution and return its canonical value. */
  resolve(key: K): Promise<V>;
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
 * The input-cell specialization of {@link AsyncReactiveFamily}: a keyed async
 * family whose entries are all input cells (always materialized, always resolved).
 */
export function asyncCellFamily<K, V>(
  ctx: AsyncContext,
  keys: Iterable<K>,
  factory: (key: K) => V,
  mode?: MaterializationMode,
): AsyncReactiveFamily<K, V>;
