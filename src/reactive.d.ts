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
 * Backwards-compatible newable wrapper around {@link createContext}. Existing
 * `new Context(opts)` call sites keep working unchanged; new code may call
 * `createContext(opts)` directly. Both return the same reactive context.
 */
export declare function Context(opts?: { instrument?: boolean }): Context;
