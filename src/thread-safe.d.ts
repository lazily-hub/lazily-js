import type {
  CellHandle,
  Context,
  EffectHandle,
  SignalHandle,
  SlotHandle,
} from "./reactive.js";

/**
 * A reentrant mutex whose lock word optionally lives in a `SharedArrayBuffer`,
 * giving cross-worker mutual exclusion. Degrades to a no-op guard when shared
 * memory is unavailable.
 */
export class AtomicMutex {
  constructor(buffer?: SharedArrayBuffer);
  readonly buffer: SharedArrayBuffer | ArrayBuffer | null;
  runExclusive<R>(fn: () => R): R;
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
 * The `Send + Sync` flavor of {@link Context}: every public operation runs under
 * a shared Atomics mutex. Compute/effect closures capture this context and take
 * no arguments.
 */
export class ThreadSafeContext {
  constructor(opts?: { mutex?: AtomicMutex; context?: Context; instrument?: boolean });

  /** Rebind a `ThreadSafeContext` in another realm onto a shared lock buffer. */
  static withLockBuffer(buffer: SharedArrayBuffer, context?: Context): ThreadSafeContext;

  /** The shared lock buffer to hand to a worker (null when shared memory is off). */
  readonly lockBuffer: SharedArrayBuffer | ArrayBuffer | null;
  /** The mutex guarding this context. */
  readonly mutex: AtomicMutex;

  cell<T>(value: T): CellHandle<T>;
  computed<T>(compute: () => T): SlotHandle<T>;
  slot<T>(compute: () => T): SlotHandle<T>;
  memo<T>(compute: () => T): SlotHandle<T>;
  signal<T>(compute: () => T): SignalHandle<T>;
  effect(run: () => void | (() => void)): EffectHandle;

  get<T>(handle: SlotHandle<T>): T;
  getCell<T>(handle: CellHandle<T>): T;
  getSignal<T>(handle: SignalHandle<T>): T;
  isSet<T>(handle: SlotHandle<T>): boolean;

  setCell<T>(handle: CellHandle<T>, value: T): void;
  batch(run: () => void): void;

  disposeEffect(handle: EffectHandle): void;
  isEffectActive(handle: EffectHandle): boolean;
  disposeSignal<T>(handle: SignalHandle<T>): void;
  isSignalActive<T>(handle: SignalHandle<T>): boolean;

  instrumentationSnapshot(): InstrumentationSnapshot | null;
  resetInstrumentation(): void;
}
