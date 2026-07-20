export type ComputeFn<T> = () => T;
export type EffectRun = () => (() => void) | null | undefined;
export type EqualFn<T> = (a: T, b: T) => boolean;

/**
 * Default structural equality used by cells and memos: identity, then
 * byte-wise `Uint8Array`, then `Array` index recursion, then a key-wise
 * shallow/deep object comparison. Exposed so consumers can reuse the canonical
 * equality in custom {@link EqualFn} composition and benchmarks.
 */
export declare function defaultEqual<T>(a: T, b: T): boolean;

/**
 * Thrown when a node that has been torn down is read or written
 * (`read_after_dispose`). Narrowable with `instanceof`, so a caller — an effect
 * body, a teardown path — can act on this cause specifically instead of
 * swallowing every error.
 */
export class DisposedNodeError extends Error {
  readonly name: "DisposedNodeError";
  readonly nodeId: number;
}

/** Any node handle a {@link Context} can address by degree or tear down. */
export type NodeHandle =
  | CellHandle<never>
  | SlotHandle<never>
  | EffectHandle
  | SignalHandle<never>;

export class SlotHandle<T = unknown> {
  /** @internal */ constructor(id: number);
  readonly id: number;
}

export class CellHandle<T = unknown> {
  /** @internal */ constructor(id: number);
  readonly id: number;
}

export class EffectHandle {
  /** @internal */ constructor(id: number);
  readonly id: number;
}

export class SignalHandle<T = unknown> {
  /** @internal */ constructor(slot: SlotHandle<T>, effect: EffectHandle);
  readonly slot: SlotHandle<T>;
  readonly effect: EffectHandle;
}

export interface InstrumentationSnapshot {
  nodeAllocations: number;
  slotRecomputes: number;
  dependencyEdgesAdded: number;
  dependencyEdgesRemoved: number;
  effectQueuePushes: number;
  maxEffectQueueDepth: number;
}

/**
 * A reactive context: the graph owning all Cell/Slot/Signal/Effect nodes.
 *
 * Declared as an interface so it can be used as a type
 * (`import type { Context }`) while the runtime value is the newable
 * {@link Context} function below (declaration merging: same name, a type side
 * and a value side). New code may prefer {@link createContext}.
 */
export interface Context {
  cell<T>(value: T): CellHandle<T>;
  computed<T>(compute: ComputeFn<T>): SlotHandle<T>;
  slot<T>(compute: ComputeFn<T>): SlotHandle<T>;
  memo<T>(compute: ComputeFn<T>): SlotHandle<T>;
  signal<T>(compute: ComputeFn<T>): SignalHandle<T>;
  effect(run: EffectRun): EffectHandle;
  get<T>(handle: SlotHandle<T>): T;
  getCell<T>(handle: CellHandle<T>): T;
  getSignal<T>(handle: SignalHandle<T>): T;
  setCell<T>(handle: CellHandle<T>, value: T): void;
  batch(run: () => void): void;
  disposeEffect(handle: EffectHandle): void;
  isEffectActive(handle: EffectHandle): boolean;
  disposeSignal(handle: SignalHandle<unknown>): void;
  isSignalActive(handle: SignalHandle<unknown>): boolean;
  /**
   * Tear down a lazy derived node (slot/computed/memo): detach its upstream and
   * downstream dependency edges, free the node, and recycle its id. No-op on an
   * already-disposed handle or the wrong kind. Callers must ensure no live compute
   * still reads the slot.
   */
  disposeSlot<T>(handle: SlotHandle<T>): void;
  /**
   * Tear down a source cell: detach its downstream edges, free the node, and
   * recycle its id. No-op on an already-disposed handle or the wrong kind. Callers
   * must ensure no live slot still reads the cell (its next recompute would throw).
   */
  disposeCell<T>(handle: CellHandle<T>): void;
  /**
   * Tear down whatever kind of node `handle` names. Dispatch is on the handle's
   * CLASS, not on the node currently occupying its id: ids are recycled, and a
   * stale handle whose id has been reissued must be a no-op rather than tear
   * down the new occupant.
   */
  disposeNode(handle: NodeHandle): void;
  /**
   * How many nodes currently depend on `handle` — the size of its reverse edge
   * set. 0 for a disposed node and for effects, which are pure sinks.
   *
   * Counts, never collections: graph shape is assertable with no path to the
   * edge arrays and no storage strategy pinned into the contract.
   */
  dependentCount(handle: NodeHandle): number;
  /**
   * How many nodes `handle` currently depends on — the size of its forward edge
   * set. 0 for a disposed node and for cells, which are pure sources.
   */
  dependencyCount(handle: NodeHandle): number;
  /** Whether `handle`'s id currently names no live node. Ids are recycled, so
   * this means "disposed and not yet reused". */
  isNodeDisposed(handle: NodeHandle): boolean;
  /** Open a {@link TeardownScope} over this context. */
  scope(): TeardownScope;
  /** Run `body` with a fresh scope and end it in a `finally`. */
  withScope<R>(body: (scope: TeardownScope) => R): R;
  isSet<T>(handle: SlotHandle<T>): boolean;
  /** Instrumentation counters, or `null` if not enabled at construction. */
  instrumentationSnapshot(): InstrumentationSnapshot | null;
  /** Zero the instrumentation counters (no-op when instrumentation is off). */
  resetInstrumentation(): void;
}

/**
 * Create a reactive {@link Context} — the idiomatic entry point.
 *
 * Implemented with the closure factory technique (#lzjsclosure): graph state is
 * captured in closure bindings rather than class instance fields, so V8 inlines
 * the hot paths more aggressively than the prior `class` + `#private` version.
 */
export declare function createContext(opts?: { instrument?: boolean }): Context;

/**
 * A teardown scope over a {@link Context}: nodes created through it are disposed
 * when it ends, in reverse creation order (`#lzspecedgeindex`).
 *
 * The end is explicit — `withScope`, `using` via `Symbol.dispose`, or `end()`.
 * JavaScript has no destructor, and the only GC-driven hook
 * (`FinalizationRegistry`) is not guaranteed to run, so a scope that tore down
 * on collection would reintroduce the very leak scopes exist to prevent.
 * `end()` also covers what no bracket can express: a scope whose lifetime is a
 * connection or a subscription, opened in one callback and ended in another.
 */
export class TeardownScope {
  /** @internal — obtain one from {@link Context.scope} / {@link Context.withScope}. */
  private constructor(ctx: Context);
  /** How many nodes this scope currently owns. */
  readonly size: number;
  /** Whether {@link end} has already run. */
  readonly ended: boolean;
  adopt<H extends NodeHandle>(handle: H): H;
  cell<T>(value: T): CellHandle<T>;
  computed<T>(compute: ComputeFn<T>): SlotHandle<T>;
  memo<T>(compute: ComputeFn<T>): SlotHandle<T>;
  signal<T>(compute: ComputeFn<T>): SignalHandle<T>;
  effect(run: EffectRun): EffectHandle;
  /** Cancel this scope's teardown. The nodes are untouched — same values, same
   * edges, still individually disposable. */
  disarm(): void;
  /** Dispose every node this scope owns, in reverse creation order. Idempotent. */
  end(): void;
  [Symbol.dispose](): void;
}

/**
 * Backwards-compatible newable wrapper around {@link createContext}. Existing
 * `new Context(opts)` call sites keep working unchanged; new code may call
 * `createContext(opts)` directly. Both return the same reactive context.
 */
export declare function Context(opts?: { instrument?: boolean }): Context;
