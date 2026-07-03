export type AsyncSlotStateView = "none" | "empty" | "computing" | "resolved" | "error";

export interface AsyncComputeContext {
  /** Aborts when this run is superseded by a newer revision or disposed. */
  readonly signal: AbortSignal;
  /** Read a cell, recording it as a dependency (synchronous). */
  getCell<T>(handle: AsyncCellHandle<T>): T;
  /** Await a slot value, recording it as a dependency before awaiting. */
  getAsync<T>(handle: AsyncSlotHandle<T>): Promise<T>;
  /** Await a signal value, recording its slot as a dependency before awaiting. */
  getSignalAsync<T>(handle: AsyncSignalHandle<T>): Promise<T>;
}

export type AsyncComputeFn<T> = (ctx: AsyncComputeContext) => T | Promise<T>;
export type AsyncCleanup = (() => void) | (() => Promise<void>);
export type AsyncEffectRun = (
  ctx: AsyncComputeContext,
) => AsyncCleanup | null | undefined | Promise<AsyncCleanup | null | undefined>;

export class AsyncCellHandle<T = unknown> {
  /** @internal */ constructor(id: number);
  readonly id: number;
}

export class AsyncSlotHandle<T = unknown> {
  /** @internal */ constructor(id: number);
  readonly id: number;
}

export class AsyncEffectHandle {
  /** @internal */ constructor(id: number);
  readonly id: number;
}

export class AsyncSignalHandle<T = unknown> {
  /** @internal */ constructor(slot: AsyncSlotHandle<T>, effect: AsyncEffectHandle);
  readonly slot: AsyncSlotHandle<T>;
  readonly effect: AsyncEffectHandle;
}

export class AsyncContext {
  /** Create a mutable cell (the synchronous input layer). */
  cell<T>(value: T): AsyncCellHandle<T>;
  /** Read a cell value (synchronous). */
  getCell<T>(handle: AsyncCellHandle<T>): T;
  /** Update a cell and invalidate dependents (synchronous). */
  setCell<T>(handle: AsyncCellHandle<T>, value: T): void;

  /** Create an async computed slot (no memo guard). */
  computedAsync<T>(compute: AsyncComputeFn<T>): AsyncSlotHandle<T>;
  /** Create an async computed slot with an equality memo guard. */
  memoAsync<T>(compute: AsyncComputeFn<T>): AsyncSlotHandle<T>;
  /** Create an eager async signal (memo slot + puller effect). */
  signalAsync<T>(compute: AsyncComputeFn<T>): AsyncSignalHandle<T>;
  /** Create an async effect returning an optional (possibly async) cleanup. */
  effectAsync(run: AsyncEffectRun): AsyncEffectHandle;

  /** Synchronous cached read: the resolved value, or `undefined` otherwise. */
  get<T>(handle: AsyncSlotHandle<T>): T | undefined;
  isResolved<T>(handle: AsyncSlotHandle<T>): boolean;
  /** Public projection of the slot state machine. */
  slotState<T>(handle: AsyncSlotHandle<T>): AsyncSlotStateView;
  /** Await a slot value (fast path via `get()`, else spawn/attach). */
  getAsync<T>(handle: AsyncSlotHandle<T>): Promise<T>;
  getSignal<T>(handle: AsyncSignalHandle<T>): T | undefined;
  getSignalAsync<T>(handle: AsyncSignalHandle<T>): Promise<T>;

  /** Synchronous batch boundary; async reruns are scheduled at batch exit. */
  batch(run: () => void): void;
  /** Await scheduled reruns and in-flight computes until the graph quiesces. */
  settle(): Promise<void>;

  /** Dispose an async effect and await its cleanup. */
  disposeAsyncEffect(handle: AsyncEffectHandle): Promise<void>;
  isEffectActive(handle: AsyncEffectHandle): boolean;
  disposeSignal(handle: AsyncSignalHandle<unknown>): Promise<void>;
  isSignalActive(handle: AsyncSignalHandle<unknown>): boolean;
  /** Dispose the context: abort in-flight work and await active cleanups. */
  dispose(): Promise<void>;
}
