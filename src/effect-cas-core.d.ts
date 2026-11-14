// Generic keyed effect compare-and-swap authority (`#lzeffectcas`).

export declare const EffectCasUpsertKind: Readonly<{
  Accepted: "accepted";
  Unchanged: "unchanged";
  AlreadyApplied: "already_applied";
  StaleEpoch: "stale_epoch";
  EpochConflict: "epoch_conflict";
}>;
export declare const EffectCasClaimKind: Readonly<{
  Claimed: "claimed";
  Empty: "empty";
  Busy: "busy";
  Waiting: "waiting";
  StaleGeneration: "stale_generation";
}>;
export declare const EffectCasAppliedKind: Readonly<{
  StepApplied: "step_applied";
  Completed: "completed";
  Superseded: "superseded";
  Duplicate: "duplicate";
  UnknownAttempt: "unknown_attempt";
  StaleGeneration: "stale_generation";
}>;
export declare const EffectCasFailureKind: Readonly<{
  Superseded: "superseded";
  Retrying: "retrying";
  Rejected: "rejected";
  UnknownAttempt: "unknown_attempt";
  StaleGeneration: "stale_generation";
}>;
export declare const EffectCasReconnectKind: Readonly<{
  Advanced: "advanced";
  Unchanged: "unchanged";
  StaleGeneration: "stale_generation";
}>;
export declare const EffectTerminalKind: Readonly<{
  Applied: "applied";
  Superseded: "superseded";
  Rejected: "rejected";
}>;
export declare const EffectApplyKind: Readonly<{
  Applied: "applied";
  Superseded: "superseded";
  Retryable: "retryable";
  Rejected: "rejected";
}>;
export declare const EffectCasHydrateError: Readonly<{
  DuplicateKey: "DuplicateKey";
  KeyMismatch: "KeyMismatch";
  CursorOutOfRange: "CursorOutOfRange";
  AttemptMismatch: "AttemptMismatch";
  FutureGeneration: "FutureGeneration";
}>;

export type EffectCasHydrateErrorReason =
  (typeof EffectCasHydrateError)[keyof typeof EffectCasHydrateError];

export declare class EffectCasHydrateFailure extends Error {
  constructor(reason: EffectCasHydrateErrorReason);
  readonly reason: EffectCasHydrateErrorReason;
}

/** Immutable desired effect. One epoch names exactly one identity and plan. */
export interface EffectIntent<K = string, A = unknown, P = unknown> {
  readonly identity: string;
  readonly epoch: number;
  readonly key: K;
  readonly expected: A;
  readonly plan: readonly P[];
}

/** Exact identity of one adapter call. */
export interface EffectAttemptIdentity {
  readonly effect: string;
  readonly generation: number;
  readonly epoch: number;
  readonly step: number;
  readonly attempt: number;
}

export interface EffectReceipt<R = unknown, A = unknown> {
  readonly attempt: EffectAttemptIdentity;
  readonly receipt: R;
  readonly authority: A;
}

/** The exact compare-and-apply call handed to an application adapter. */
export interface EffectAttempt<K = string, A = unknown, P = unknown, R = unknown> {
  readonly identity: EffectAttemptIdentity;
  readonly key: K;
  readonly expected: A;
  readonly payload: P;
  readonly priorReceipts: readonly EffectReceipt<R, A>[];
}

/** The only outcomes an application adapter may return. */
export type EffectApply<R = unknown, A = unknown, E = unknown> =
  | { readonly kind: "applied"; readonly receipt: R; readonly authority: A }
  | { readonly kind: "superseded"; readonly observed: A }
  | { readonly kind: "retryable"; readonly error: E }
  | { readonly kind: "rejected"; readonly error: E };

/** Narrow application-owned atomic authority boundary. */
export interface CompareAndApply<K = string, A = unknown, P = unknown, R = unknown, E = unknown> {
  observe(key: K): A;
  compareAndApply(attempt: EffectAttempt<K, A, P, R>): EffectApply<R, A, E>;
}

export interface EffectPending<K = string, A = unknown, P = unknown, R = unknown> {
  readonly intent: EffectIntent<K, A, P>;
  readonly nextStep: number;
  readonly expected: A;
  readonly receipts: readonly EffectReceipt<R, A>[];
  readonly nextAttempt: number;
  readonly readyAt: number | null;
}

export interface EffectRetry<E = unknown> {
  readonly attempt: EffectAttemptIdentity;
  readonly error: E;
  readonly retryAt: number;
}

export type EffectTerminal<R = unknown, A = unknown, E = unknown> =
  | {
      readonly kind: "applied";
      readonly identity: string;
      readonly epoch: number;
      readonly receipts: readonly EffectReceipt<R, A>[];
    }
  | {
      readonly kind: "superseded";
      readonly identity: string;
      readonly epoch: number;
      readonly observed: A | null;
      readonly receipts: readonly EffectReceipt<R, A>[];
    }
  | {
      readonly kind: "rejected";
      readonly identity: string;
      readonly epoch: number;
      readonly error: E;
      readonly receipts: readonly EffectReceipt<R, A>[];
    };

export interface EffectCasKeyState<K = string, A = unknown, P = unknown, R = unknown, E = unknown> {
  readonly pending: EffectPending<K, A, P, R> | null;
  readonly inflight: EffectAttempt<K, A, P, R> | null;
  readonly retry: EffectRetry<E> | null;
  readonly appliedThrough: number | null;
  readonly terminal: EffectTerminal<R, A, E> | null;
}

export interface EffectCasSnapshot<K = string, A = unknown, P = unknown, R = unknown, E = unknown> {
  readonly generation: number;
  readonly keys: readonly { readonly key: K; readonly state: EffectCasKeyState<K, A, P, R, E> }[];
}

export interface EffectCasDurableKey<
  K = string,
  A = unknown,
  P = unknown,
  R = unknown,
  E = unknown,
> {
  readonly key: K;
  readonly pending: EffectPending<K, A, P, R> | null;
  readonly inflight: {
    readonly retained: EffectPending<K, A, P, R>;
    readonly attempt: EffectAttempt<K, A, P, R>;
  } | null;
  readonly retry: EffectRetry<E> | null;
  readonly appliedThrough: number | null;
  readonly terminal: EffectTerminal<R, A, E> | null;
  readonly terminalIntent: EffectIntent<K, A, P> | null;
}

export interface EffectCasDurableState<
  K = string,
  A = unknown,
  P = unknown,
  R = unknown,
  E = unknown,
> {
  readonly generation: number;
  readonly keys: readonly EffectCasDurableKey<K, A, P, R, E>[];
}

export interface EffectCasChange {
  readonly state: boolean;
}

export interface EffectCasStale {
  readonly kind: "stale_generation";
  readonly current: number;
}

export type EffectCasUpsert =
  | { readonly kind: "accepted" | "unchanged" | "epoch_conflict" }
  | { readonly kind: "already_applied"; readonly appliedThrough: number }
  | { readonly kind: "stale_epoch"; readonly current: number };

export type EffectCasClaim<K = string, A = unknown, P = unknown, R = unknown> =
  | { readonly kind: "claimed"; readonly attempt: EffectAttempt<K, A, P, R> }
  | { readonly kind: "empty" | "busy" }
  | { readonly kind: "waiting"; readonly retryAt: number }
  | EffectCasStale;

export type EffectCasApplied =
  | { readonly kind: "step_applied"; readonly nextStep: number }
  | { readonly kind: "completed"; readonly appliedThrough: number }
  | { readonly kind: "superseded" | "duplicate" | "unknown_attempt" }
  | EffectCasStale;

export type EffectCasFailure =
  | { readonly kind: "superseded" | "rejected" | "unknown_attempt" }
  | { readonly kind: "retrying"; readonly retryAt: number }
  | EffectCasStale;

export type EffectCasReconnect =
  | {
      readonly kind: "advanced";
      readonly generation: number;
      readonly requeued: number;
      readonly superseded: number;
    }
  | { readonly kind: "unchanged"; readonly generation: number }
  | EffectCasStale;

export interface EffectCasOptions {
  /** Domain equality for authority tokens, payloads, receipts, errors and keys. */
  equals?: (a: unknown, b: unknown) => boolean;
  /** Key order for snapshots, durable images and `pendingKeys`. */
  compareKeys?: (a: unknown, b: unknown) => number;
}

export declare function structuralEqual(a: unknown, b: unknown): boolean;
export declare function effectIdentity(value: string): string;
export declare function effectIntent<K, A, P>(intent: {
  identity: string;
  epoch: number;
  key: K;
  expected: A;
  plan: readonly P[];
}): EffectIntent<K, A, P>;

type Transition<O> = { change: EffectCasChange; outcome: O };

/** Pure keyed effect-CAS orchestration authority. */
export declare class EffectCasCore<K = string, A = unknown, P = unknown, R = unknown, E = unknown> {
  constructor(generation: number, options?: EffectCasOptions);
  readonly generation: number;
  state(key: K): EffectCasKeyState<K, A, P, R, E> | null;
  snapshot(): EffectCasSnapshot<K, A, P, R, E>;
  pendingKeys(now: number): K[];
  upsertDesired(intent: EffectIntent<K, A, P>): Transition<EffectCasUpsert>;
  claim(key: K, generation: number, now: number): Transition<EffectCasClaim<K, A, P, R>>;
  recordApplied(
    key: K,
    attempt: EffectAttemptIdentity,
    receipt: R,
    authority: A,
  ): Transition<EffectCasApplied>;
  recordSuperseded(
    key: K,
    attempt: EffectAttemptIdentity,
    observed: A,
  ): Transition<EffectCasFailure>;
  recordRetryable(
    key: K,
    attempt: EffectAttemptIdentity,
    error: E,
    retryAt: number,
  ): Transition<EffectCasFailure>;
  recordRejected(key: K, attempt: EffectAttemptIdentity, error: E): Transition<EffectCasFailure>;
  recordOutcome(
    key: K,
    attempt: EffectAttemptIdentity,
    apply: EffectApply<R, A, E>,
    retryAt?: number,
  ): Transition<EffectCasApplied | EffectCasFailure>;
  reconnect(newGeneration: number): Transition<EffectCasReconnect>;
  /** Full-fidelity durable image (`#lzeffectcasdurable`). */
  durableState(): EffectCasDurableState<K, A, P, R, E>;
  /** Restore a core from `durableState()`; throws `EffectCasHydrateFailure` on a corrupt image. */
  static hydrate<K = string, A = unknown, P = unknown, R = unknown, E = unknown>(
    state: EffectCasDurableState<K, A, P, R, E>,
    options?: EffectCasOptions,
  ): EffectCasCore<K, A, P, R, E>;
}
