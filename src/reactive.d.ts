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
  | SourceCell<never>
  | FormulaCell<never>
  | EffectHandle
  | SignalHandle<never>;

/**
 * The Cell kernel genus (`#lzcellkernel`) — a lightweight typed handle to a
 * reactive node. Two value kinds extend it: {@link SourceCell} (written from
 * outside) and {@link FormulaCell} (computed from upstream). `Effect` is a
 * value-less sink and stays outside the hierarchy.
 *
 * The read/write split has no compile-time enforcement in JavaScript; it is
 * expressed by METHOD PRESENCE — a `SourceCell` exposes `set`/`merge`, a
 * `FormulaCell` does not.
 */
export class Cell<T = unknown> {
  /** @internal */ constructor(id: number, ctx?: unknown);
  readonly id: number;
  /** Read the current value (tracks a dependency inside a computation). */
  get(): T;
  /** Tear this node down (kind-agnostic; dispatches on the handle's class). */
  dispose(): void;
}

/**
 * A cell written from outside, folding writes under an optional merge policy
 * (default keep-latest = replace). Subsumes the former `CellHandle` and the
 * `MergeCell` wrapper: `Cell ≡ SourceCell(KeepLatest)`.
 */
export class SourceCell<T = unknown> extends Cell<T> {
  /** Replace the value outright (the keep-latest write). */
  set(value: T): void;
  /** Fold `op` into the current value under this cell's policy (replace if none). */
  merge(op: T): void;
}

/**
 * A cell computed from upstream, guarded when built via `formula`. Lazy by
 * default; `formula(f).drive()` makes it eager (a driven formula). Exposes no
 * `set`/`merge`.
 */
export class FormulaCell<T = unknown> extends Cell<T> {
  /** Make this formula eager (attach a puller). Idempotent; returns `this`. */
  drive(): this;
  /** Reverse of {@link drive}: revert to lazy and dispose the puller. */
  undrive(): this;
  /** Whether this formula currently has an active puller. */
  isDriven(): boolean;
}

/** @deprecated alias of {@link SourceCell} (#lzcellkernel). */
export { SourceCell as CellHandle };
/** @deprecated alias of {@link FormulaCell} (#lzcellkernel). */
export { FormulaCell as SlotHandle };

export class EffectHandle {
  /** @internal */ constructor(id: number, ctx?: unknown);
  readonly id: number;
  /** Dispose this effect (unsubscribe). */
  dispose(): void;
}

/**
 * @deprecated Retired by the Cell kernel (#lzcellkernel): the eager construction
 * is a driven {@link FormulaCell} (`ctx.formula(f).drive()`). Retained as a
 * compatibility shape for the thread-safe / async contexts and `state-machine`.
 */
export class SignalHandle<T = unknown> {
  /** @internal */ constructor(slot: FormulaCell<T>, effect: EffectHandle);
  readonly slot: FormulaCell<T>;
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
 * A reactive context: the graph owning all SourceCell/FormulaCell/Effect nodes
 * (the Cell kernel, `#lzcellkernel`).
 *
 * Declared as an interface so it can be used as a type
 * (`import type { Context }`) while the runtime value is the newable
 * {@link Context} function below (declaration merging: same name, a type side
 * and a value side). New code may prefer {@link createContext}.
 */
/** A merge policy: an associative fold `merge(old, op) -> T` plus law flags. */
export interface MergePolicy<T> {
  merge(old: T, op: T): T;
  name?: string;
  commutative?: boolean;
  idempotent?: boolean;
  conflates?: boolean;
}

export interface Context {
  // -- Cell kernel (#lzcellkernel) primary surface --
  /** A source cell (keep-latest); `source(v, policy)` folds under `policy`. */
  source<T>(value: T, policy?: MergePolicy<T>): SourceCell<T>;
  /** A guarded formula (equality-suppressed) — the default derived construction. */
  formula<T>(compute: ComputeFn<T>): FormulaCell<T>;
  /** Make a formula eager by id (prefer {@link FormulaCell.drive}). Idempotent. */
  driveFormula(id: number): void;
  /** Reverse of {@link driveFormula}. */
  undriveFormula(id: number): void;
  /** Whether the formula is driven. */
  isDriven(handle: FormulaCell<unknown> | number): boolean;

  // -- Deprecated constructor aliases --
  /** @deprecated use {@link source}. */
  cell<T>(value: T): SourceCell<T>;
  /** @deprecated unguarded formula; use {@link formula} (guarded by default). */
  computed<T>(compute: ComputeFn<T>): FormulaCell<T>;
  /** @deprecated use {@link formula}. */
  slot<T>(compute: ComputeFn<T>): FormulaCell<T>;
  /** @deprecated use {@link formula} (guarded by default). */
  memo<T>(compute: ComputeFn<T>): FormulaCell<T>;
  /** @deprecated the eager construction is `formula(f).drive()`. */
  signal<T>(compute: ComputeFn<T>): SignalHandle<T>;
  effect(run: EffectRun): EffectHandle;
  get<T>(handle: FormulaCell<T>): T;
  getCell<T>(handle: SourceCell<T>): T;
  getSignal<T>(handle: SignalHandle<T>): T;
  setCell<T>(handle: SourceCell<T>, value: T): void;
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
  disposeSlot<T>(handle: FormulaCell<T>): void;
  /**
   * Tear down a source cell: detach its downstream edges, free the node, and
   * recycle its id. No-op on an already-disposed handle or the wrong kind. Callers
   * must ensure no live slot still reads the cell (its next recompute would throw).
   */
  disposeCell<T>(handle: SourceCell<T>): void;
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
  isSet<T>(handle: FormulaCell<T>): boolean;
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
  /** Create a source cell owned by this scope (#lzcellkernel). */
  source<T>(value: T, policy?: MergePolicy<T>): SourceCell<T>;
  /** Create a guarded formula owned by this scope (#lzcellkernel). */
  formula<T>(compute: ComputeFn<T>): FormulaCell<T>;
  /** @deprecated use {@link source}. */
  cell<T>(value: T): SourceCell<T>;
  /** @deprecated unguarded formula; use {@link formula}. */
  computed<T>(compute: ComputeFn<T>): FormulaCell<T>;
  /** @deprecated use {@link formula} (guarded by default). */
  memo<T>(compute: ComputeFn<T>): FormulaCell<T>;
  /** @deprecated the eager construction is `formula(f).drive()`. */
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
