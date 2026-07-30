import type { Compute, Computed, Context } from "./reactive.js";
import type { MergePolicy } from "./merge.js";
import type {
  IngressAdmission,
  IngressAuthority,
  IngressChange,
  IngressEnvelope,
  IngressErrorLabel,
  IngressPolicy,
  IngressReadinessLabel,
  IngressReceipt,
  IngressScheduleValue,
  IngressTransport,
  IngressTransportKindLabel,
  IngressRetry,
  ReplayRequest,
  ScopeView,
} from "./ingress-core.js";

export * from "./ingress-core.js";

export type IngressCellOptions<T = unknown> = {
  policy?: Partial<IngressPolicy>;
  merge?: MergePolicy<T>;
  transport?: IngressTransportKindLabel;
  pollInterval?: number;
};

/**
 * The single-threaded flavor: one keyed admission plane per scope, with
 * readiness, authority, and retry as derives rather than refresh calls.
 */
export class IngressCell<K = string, T = unknown> {
  constructor(ctx: Context, options?: IngressCellOptions<T>);

  open(key: K, generation: number): IngressChange<K>;
  admit(envelope: IngressEnvelope<K, T>): IngressAdmission;
  suspend(key: K): ReplayRequest | null;
  reconnect(key: K, generation: number): ReplayRequest;
  close(key: K): IngressChange<K>;
  fail(key: K, error: IngressErrorLabel): IngressChange<K>;
  tick(now: number): IngressChange<K>;
  drain(key: K): T | null;
  pump(transport: IngressTransport<K, T>): IngressAdmission[];

  value(key: K, cx?: Compute): T | null;
  readiness(key: K, cx?: Compute): IngressReadinessLabel;
  authority(key: K, cx?: Compute): IngressAuthority | null;
  retry(key: K, cx?: Compute): IngressRetry | null;
  accepted(cx?: Compute): Array<IngressReceipt<K>>;
  dropped(cx?: Compute): Array<IngressReceipt<K>>;
  errors(cx?: Compute): Array<IngressReceipt<K>>;
  schedule(cx?: Compute): IngressScheduleValue;

  valueHandle(key: K): Computed<T | null>;
  readinessHandle(key: K): Computed<IngressReadinessLabel>;
  authorityHandle(key: K): Computed<IngressAuthority | null>;
  retryHandle(key: K): Computed<IngressRetry | null>;
  acceptedHandle(): Computed<Array<IngressReceipt<K>>>;
  droppedHandle(): Computed<Array<IngressReceipt<K>>>;
  errorsHandle(): Computed<Array<IngressReceipt<K>>>;
  scheduleHandle(): Computed<IngressScheduleValue>;

  setTransport(kind: IngressTransportKindLabel): void;
  setPollInterval(interval: number): void;

  view(key: K): ScopeView | null;
  policy(): IngressPolicy;
  scopeKeys(): K[];
}
