import type { AsyncComputed, AsyncContext } from "./reactive-async.js";
import type { Computed, Context, SlotHandle } from "./reactive.js";
import type { AtomicMutex, ThreadSafeContext } from "./thread-safe.js";
import type {
  EffectApply,
  EffectAttemptIdentity,
  EffectCasApplied,
  EffectCasClaim,
  EffectCasDurableState,
  EffectCasFailure,
  EffectCasOptions,
  EffectCasReconnect,
  EffectCasSnapshot,
  EffectCasUpsert,
  EffectIntent,
} from "./effect-cas-core.js";

export * from "./effect-cas-core.js";

declare class EffectCasShell<K, A, P, R, E> {
  readonly generation: number;
  pendingKeys(now: number): K[];
  durableState(): EffectCasDurableState<K, A, P, R, E>;
  upsertDesired(intent: EffectIntent<K, A, P>): EffectCasUpsert;
  claim(key: K, generation: number, now: number): EffectCasClaim<K, A, P, R>;
  recordApplied(key: K, attempt: EffectAttemptIdentity, receipt: R, authority: A): EffectCasApplied;
  recordSuperseded(key: K, attempt: EffectAttemptIdentity, observed: A): EffectCasFailure;
  recordRetryable(
    key: K,
    attempt: EffectAttemptIdentity,
    error: E,
    retryAt: number,
  ): EffectCasFailure;
  recordRejected(key: K, attempt: EffectAttemptIdentity, error: E): EffectCasFailure;
  recordOutcome(
    key: K,
    attempt: EffectAttemptIdentity,
    apply: EffectApply<R, A, E>,
    retryAt?: number,
  ): EffectCasApplied | EffectCasFailure;
  reconnect(newGeneration: number): EffectCasReconnect;
}

/** Single-threaded Context flavor. */
export declare class EffectCas<
  K = string,
  A = unknown,
  P = unknown,
  R = unknown,
  E = unknown,
> extends EffectCasShell<K, A, P, R, E> {
  constructor(ctx: Context, generation?: number, options?: EffectCasOptions);
  readonly stateHandle: Computed<EffectCasSnapshot<K, A, P, R, E>>;
  snapshot(): EffectCasSnapshot<K, A, P, R, E>;
}

/** ThreadSafeContext flavor; the core lock is released before graph invalidation. */
export declare class ThreadSafeEffectCas<
  K = string,
  A = unknown,
  P = unknown,
  R = unknown,
  E = unknown,
> extends EffectCasShell<K, A, P, R, E> {
  constructor(
    ctx: ThreadSafeContext,
    generation?: number,
    options?: EffectCasOptions & { mutex?: AtomicMutex },
  );
  readonly mutex: AtomicMutex;
  readonly stateHandle: SlotHandle<EffectCasSnapshot<K, A, P, R, E>>;
  snapshot(): EffectCasSnapshot<K, A, P, R, E>;
}

/** AsyncContext flavor; transitions stay synchronous, the reader materializes asynchronously. */
export declare class AsyncEffectCas<
  K = string,
  A = unknown,
  P = unknown,
  R = unknown,
  E = unknown,
> extends EffectCasShell<K, A, P, R, E> {
  constructor(ctx: AsyncContext, generation?: number, options?: EffectCasOptions);
  readonly stateHandle: AsyncComputed<EffectCasSnapshot<K, A, P, R, E>>;
  snapshot(): Promise<EffectCasSnapshot<K, A, P, R, E>>;
}
