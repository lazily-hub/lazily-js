// Transport-agnostic reactive egress delivery authority (`#lzegress`).

export declare const EgressConfigError: Readonly<{
  ZeroInflightLimit: "ZeroInflightLimit";
  ZeroRetryBase: "ZeroRetryBase";
  RetryCeilingBelowBase: "RetryCeilingBelowBase";
}>;

export declare const EgressClaimKind: Readonly<{
  Claimed: "claimed";
  Empty: "empty";
  WindowFull: "window_full";
  StaleGeneration: "stale_generation";
}>;

export declare const EgressAckKind: Readonly<{
  Advanced: "advanced";
  Unchanged: "unchanged";
  BeyondSent: "beyond_sent";
  StaleGeneration: "stale_generation";
}>;

export declare const EgressFailureKind: Readonly<{
  Retrying: "retrying";
  Exhausted: "exhausted";
  UnknownSequence: "unknown_sequence";
  StaleGeneration: "stale_generation";
}>;

export declare const EgressRetryActionKind: Readonly<{
  Scheduled: "scheduled";
  UnknownSequence: "unknown_sequence";
  StaleGeneration: "stale_generation";
}>;

export declare const EgressReconnectKind: Readonly<{
  Advanced: "advanced";
  Unchanged: "unchanged";
  StaleGeneration: "stale_generation";
}>;

export interface EgressPolicy {
  /** Maximum unacknowledged (in-flight) envelopes. Must be >= 1. */
  inflightLimit: number;
  /** Retries permitted after the first send attempt. */
  retryBudget: number;
  /** Backoff of the first retry. Must be >= 1. */
  retryBase: number;
  /** Backoff ceiling. Must be >= retryBase. */
  retryCeiling: number;
}

/** One send attempt; `(generation, sequence)` is the transport idempotency identity. */
export interface EgressEnvelope<T = unknown> {
  readonly generation: number;
  readonly sequence: number;
  readonly attempt: number;
  readonly payload: T;
}

export interface EgressRetry {
  readonly sequence: number;
  readonly attempt: number;
  readonly backoff: number;
  readonly exhausted: boolean;
}

/** Reader-kind invalidations emitted by one transition. */
export interface EgressChange {
  readonly pending: boolean;
  readonly inflight: boolean;
  readonly ackedThrough: boolean;
  readonly retry: boolean;
}

export interface EgressStale {
  readonly kind: "stale_generation";
  readonly current: number;
}

export type EgressClaim<T = unknown> =
  | { readonly kind: "claimed"; readonly envelope: EgressEnvelope<T> }
  | { readonly kind: "empty" }
  | { readonly kind: "window_full" }
  | EgressStale;

export type EgressAck =
  | { readonly kind: "advanced"; readonly through: number }
  | { readonly kind: "unchanged"; readonly through: number | null }
  | { readonly kind: "beyond_sent"; readonly nextSequence: number }
  | EgressStale;

export type EgressFailure =
  | { readonly kind: "retrying" | "exhausted"; readonly retry: EgressRetry }
  | { readonly kind: "unknown_sequence" }
  | EgressStale;

export type EgressRetryAction =
  | { readonly kind: "scheduled"; readonly sequence: number }
  | { readonly kind: "unknown_sequence" }
  | EgressStale;

export type EgressReconnect =
  | { readonly kind: "advanced"; readonly generation: number; readonly replayed: number }
  | { readonly kind: "unchanged"; readonly generation: number }
  | EgressStale;

/** The default policy, matching lazily-rs `EgressPolicy::default()`. */
export declare function defaultEgressPolicy(): EgressPolicy;
export declare function egressChangeIsEmpty(change: EgressChange): boolean;

/** Pure egress delivery authority. Owns no graph handles and performs no I/O. */
export declare class EgressCore<T = unknown> {
  constructor(generation: number, policy?: Partial<EgressPolicy>);
  readonly generation: number;
  readonly nextSequence: number;
  policy(): Readonly<EgressPolicy>;
  pending(): EgressEnvelope<T>[];
  inflight(): EgressEnvelope<T>[];
  ackedThrough(): number | null;
  retry(): EgressRetry | null;
  enqueue(payload: T): { change: EgressChange; sequence: number };
  claim(generation: number): { change: EgressChange; claim: EgressClaim<T> };
  ack(generation: number, through: number): { change: EgressChange; ack: EgressAck };
  fail(generation: number, sequence: number): { change: EgressChange; failure: EgressFailure };
  retryNow(
    generation: number,
    sequence: number,
  ): { change: EgressChange; action: EgressRetryAction };
  reconnect(generation: number): { change: EgressChange; reconnect: EgressReconnect };
}
