import type { MergePolicy } from "./merge.js";
import type { Overflow } from "./relay.js";

// The graph-agnostic admission algebra behind every ingress flavor
// (`#designimplementtransport`). No context, no handles, nothing awaited.

export type IngressTransportKindLabel = "event_channel" | "rpc_triggered" | "bounded_polling";
export const IngressTransportKind: Readonly<{
  EventChannel: "event_channel";
  RpcTriggered: "rpc_triggered";
  BoundedPolling: "bounded_polling";
}>;

export type IngressLifecycleLabel = "opening" | "live" | "suspended" | "closed";
export const IngressLifecycle: Readonly<{
  Opening: "opening";
  Live: "live";
  Suspended: "suspended";
  Closed: "closed";
}>;

export type IngressReadinessLabel =
  | "unknown"
  | "warming"
  | "ready"
  | "stale"
  | "suspended"
  | "closed";
export const IngressReadiness: Readonly<{
  Unknown: "unknown";
  Warming: "warming";
  Ready: "ready";
  Stale: "stale";
  Suspended: "suspended";
  Closed: "closed";
}>;

export type IngressDropReasonLabel =
  | "stale_generation"
  | "duplicate_sequence"
  | "duplicate_buffered"
  | "reorder_window_overflow"
  | "expired"
  | "backpressure"
  | "scope_closed";
export const IngressDropReason: Readonly<{
  StaleGeneration: "stale_generation";
  DuplicateSequence: "duplicate_sequence";
  DuplicateBuffered: "duplicate_buffered";
  ReorderWindowOverflow: "reorder_window_overflow";
  Expired: "expired";
  Backpressure: "backpressure";
  ScopeClosed: "scope_closed";
}>;

export type IngressErrorLabel = "transport_closed" | "decode_failed" | "authority_lost";
export const IngressError: Readonly<{
  TransportClosed: "transport_closed";
  DecodeFailed: "decode_failed";
  AuthorityLost: "authority_lost";
}>;

export type IngressAdmissionKindLabel =
  | "accepted"
  | "conflated"
  | "buffered"
  | "generation_handoff"
  | "dropped"
  | "blocked";
export const IngressAdmissionKind: Readonly<{
  Accepted: "accepted";
  Conflated: "conflated";
  Buffered: "buffered";
  GenerationHandoff: "generation_handoff";
  Dropped: "dropped";
  Blocked: "blocked";
}>;

export type IngressReceiptChannelLabel = "accepted" | "dropped" | "error";
export const IngressReceiptChannel: Readonly<{
  Accepted: "accepted";
  Dropped: "dropped";
  Error: "error";
}>;

export const IngressConfigError: Readonly<{
  ConflateNotBounding: "ConflateNotBounding";
  ZeroReceiptCapacity: "ZeroReceiptCapacity";
}>;

/** Bounds and taxes, all flavor-neutral. */
export type IngressPolicy = {
  reorderWindow: number;
  freshnessHorizon: number;
  highWater: number;
  overflow: Overflow;
  receiptCapacity: number;
  retryBase: number;
  retryCeiling: number;
};

export function defaultIngressPolicy(overrides?: Partial<IngressPolicy>): IngressPolicy;

/** When, if ever, a scope should ask the transport for more data. */
export type IngressScheduleValue = {
  kind: IngressTransportKindLabel;
  /** Bounded poll period, or null when delivery is event-driven. */
  pollInterval: number | null;
};

export function ingressSchedule(
  kind: IngressTransportKindLabel,
  pollInterval: number,
): IngressScheduleValue;

/** One decoded inbound message plus the provenance admission needs. */
export type IngressEnvelope<K = string, T = unknown> = {
  key: K;
  generation: number;
  sequence: number;
  stampedAt: number;
  payload: T;
};

export function ingressEnvelope<K, T>(
  key: K,
  generation: number,
  sequence: number,
  stampedAt: number,
  payload: T,
): IngressEnvelope<K, T>;

export type IngressAdmission =
  | { kind: "accepted"; deliveredThrough: number }
  | { kind: "conflated"; deliveredThrough: number }
  | { kind: "buffered"; gapFrom: number }
  | { kind: "generation_handoff"; from: number; to: number }
  | { kind: "dropped"; reason: IngressDropReasonLabel }
  | { kind: "blocked" };

export function isDelivered(admission: IngressAdmission): boolean;

export type IngressAuthority = {
  generation: number;
  deliveredThrough: number | null;
  stampedAt: number;
};

export type IngressRetry = { attempt: number; backoff: number; resumeFrom: number };

export type ReplayRequest = { generation: number; fromSequence: number };

export type IngressReceiptOutcome =
  | { kind: "accepted"; deliveredThrough: number; conflated: boolean }
  | { kind: "dropped"; reason: IngressDropReasonLabel }
  | { kind: "error"; error: IngressErrorLabel };

export type IngressReceipt<K = string> = {
  /** Monotone receipt offset, stable across eviction. */
  offset: number;
  key: K;
  generation: number;
  sequence: number | null;
  outcome: IngressReceiptOutcome;
};

export function receiptChannel(receipt: IngressReceipt<unknown>): IngressReceiptChannelLabel;

/** Which of a scope's reader kinds a transition dirtied. */
export type IngressScopeChange = {
  value: boolean;
  readiness: boolean;
  authority: boolean;
  retry: boolean;
};

/** The pure invalidation set of one transition. */
export type IngressChange<K = string> = {
  scopes: Array<[K, IngressScopeChange]>;
  acceptedReceipts: boolean;
  droppedReceipts: boolean;
  errorReceipts: boolean;
};

export function emptyIngressChange<K = string>(): IngressChange<K>;
export function ingressChangeIsEmpty(change: IngressChange<unknown>): boolean;

/** Read-only projection of one scope, from which every derive is computed. */
export class ScopeView {
  readonly lifecycle: IngressLifecycleLabel;
  readonly generation: number;
  readonly deliveredThrough: number | null;
  readonly stampedAt: number;
  readonly buffered: number;
  readonly windowDepth: number;
  readonly consecutiveErrors: number;
  readonly observedNow: number;
  readonly policy: IngressPolicy;
  isFresh(): boolean;
  readiness(): IngressReadinessLabel;
  authority(): IngressAuthority | null;
  resumeFrom(): number;
  hasGap(): boolean;
  retry(): IngressRetry | null;
}

export class IngressCore<K = string, T = unknown> {
  constructor(policy: IngressPolicy, mergePolicy: MergePolicy<T>);
  policy(): IngressPolicy;
  scopeKeys(): K[];
  view(key: K): ScopeView | null;
  readiness(key: K): IngressReadinessLabel;
  authority(key: K): IngressAuthority | null;
  retry(key: K): IngressRetry | null;
  peek(key: K): T | null;
  hasWindow(key: K): boolean;
  receipts(channel: IngressReceiptChannelLabel): Array<IngressReceipt<K>>;
  observedNow(): number;
  open(key: K, generation: number): IngressChange<K>;
  suspend(key: K): { change: IngressChange<K>; replay: ReplayRequest | null };
  reconnect(key: K, generation: number): { change: IngressChange<K>; replay: ReplayRequest };
  close(key: K): IngressChange<K>;
  tick(now: number): IngressChange<K>;
  fail(key: K, error: IngressErrorLabel): IngressChange<K>;
  drain(key: K): { change: IngressChange<K>; drained: T | null };
  admit(envelope: IngressEnvelope<K, T>): {
    change: IngressChange<K>;
    admission: IngressAdmission;
  };
}

/** A decoded source of envelopes. Implementations decode; they do not decide. */
export type IngressTransport<K = string, T = unknown> = {
  kind: IngressTransportKindLabel;
  drain(): Array<IngressEnvelope<K, T>>;
  requestReplay(key: K, request: ReplayRequest): boolean;
};

export class InProcIngress<K = string, T = unknown> implements IngressTransport<K, T> {
  constructor(kind: IngressTransportKindLabel);
  kind: IngressTransportKindLabel;
  push(envelope: IngressEnvelope<K, T>): this;
  drain(): Array<IngressEnvelope<K, T>>;
  requestReplay(key: K, request: ReplayRequest): boolean;
  replays(): Array<[K, ReplayRequest]>;
}
