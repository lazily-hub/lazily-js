export type ComputeFn<T> = () => T;
export type EffectRun = () => (() => void) | null | undefined;
export type EqualFn<T> = (a: T, b: T) => boolean;

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

export class Context {
  constructor(opts?: { instrument?: boolean });
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
