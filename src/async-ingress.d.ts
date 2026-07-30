import type { AsyncComputed, AsyncContext } from "./reactive-async.js";
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
  IngressRetry,
  IngressScheduleValue,
  IngressTransport,
  IngressTransportKindLabel,
  ReplayRequest,
  ScopeView,
} from "./ingress-core.js";

export * from "./ingress-core.js";

export type AsyncIngressCellOptions<T = unknown> = {
  policy?: Partial<IngressPolicy>;
  merge?: MergePolicy<T>;
  transport?: IngressTransportKindLabel;
  pollInterval?: number;
};

/**
 * The async flavor. Mutators are SYNCHRONOUS — admission is not async-coloured —
 * while reader materialization resolves through `getAsync`, because this
 * binding's `AsyncContext` has no synchronous compute constructor.
 */
export class AsyncIngressCell<K = string, T = unknown> {
  constructor(ctx: AsyncContext, options?: AsyncIngressCellOptions<T>);

  open(key: K, generation: number): IngressChange<K>;
  admit(envelope: IngressEnvelope<K, T>): IngressAdmission;
  suspend(key: K): ReplayRequest | null;
  reconnect(key: K, generation: number): ReplayRequest;
  close(key: K): IngressChange<K>;
  fail(key: K, error: IngressErrorLabel): IngressChange<K>;
  tick(now: number): IngressChange<K>;
  drain(key: K): T | null;
  pump(transport: IngressTransport<K, T>): IngressAdmission[];

  value(key: K): Promise<T | null>;
  readiness(key: K): Promise<IngressReadinessLabel>;
  authority(key: K): Promise<IngressAuthority | null>;
  retry(key: K): Promise<IngressRetry | null>;
  accepted(): Promise<Array<IngressReceipt<K>>>;
  dropped(): Promise<Array<IngressReceipt<K>>>;
  errors(): Promise<Array<IngressReceipt<K>>>;
  schedule(): Promise<IngressScheduleValue>;

  valueHandle(key: K): AsyncComputed<T | null>;
  readinessHandle(key: K): AsyncComputed<IngressReadinessLabel>;
  authorityHandle(key: K): AsyncComputed<IngressAuthority | null>;
  retryHandle(key: K): AsyncComputed<IngressRetry | null>;
  acceptedHandle(): AsyncComputed<Array<IngressReceipt<K>>>;
  droppedHandle(): AsyncComputed<Array<IngressReceipt<K>>>;
  errorsHandle(): AsyncComputed<Array<IngressReceipt<K>>>;
  scheduleHandle(): AsyncComputed<IngressScheduleValue>;

  setTransport(kind: IngressTransportKindLabel): void;
  setPollInterval(interval: number): void;

  view(key: K): ScopeView | null;
  policy(): IngressPolicy;
  scopeKeys(): K[];
}
