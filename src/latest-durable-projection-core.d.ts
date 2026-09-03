export type LatestDurableUpsertKind =
  "accepted" | "unchanged" | "already_durable" | "stale_epoch" | "epoch_conflict";
export const LatestDurableUpsert: Readonly<{
  Accepted: "accepted";
  Unchanged: "unchanged";
  AlreadyDurable: "already_durable";
  StaleEpoch: "stale_epoch";
  EpochConflict: "epoch_conflict";
}>;

export type LatestDurableClaimKind = "claimed" | "empty" | "busy" | "stale_generation";
export const LatestDurableClaim: Readonly<{
  Claimed: "claimed";
  Empty: "empty";
  Busy: "busy";
  StaleGeneration: "stale_generation";
}>;

export type LatestDurableAckKind = "advanced" | "unchanged" | "unknown_epoch" | "stale_generation";
export const LatestDurableAck: Readonly<{
  Advanced: "advanced";
  Unchanged: "unchanged";
  UnknownEpoch: "unknown_epoch";
  StaleGeneration: "stale_generation";
}>;

export type LatestDurableFailureKind =
  "pending" | "superseded" | "unknown_epoch" | "stale_generation";
export const LatestDurableFailure: Readonly<{
  Pending: "pending";
  Superseded: "superseded";
  UnknownEpoch: "unknown_epoch";
  StaleGeneration: "stale_generation";
}>;

export type LatestDurableReconnectKind = "advanced" | "unchanged" | "stale_generation";
export const LatestDurableReconnect: Readonly<{
  Advanced: "advanced";
  Unchanged: "unchanged";
  StaleGeneration: "stale_generation";
}>;

export type LatestDurableDesired<V> = Readonly<{ epoch: number; value: V }>;
export type LatestDurableEnvelope<K, V> = Readonly<{
  generation: number;
  key: K;
  epoch: number;
  value: V;
}>;
export type LatestDurableEntry<K, V> = Readonly<{
  key: K;
  desired: LatestDurableDesired<V> | null;
  inflight: LatestDurableEnvelope<K, V> | null;
  durableThrough: number | null;
}>;
export type LatestDurableEntryView<K, V> = Omit<LatestDurableEntry<K, V>, "key">;
export type LatestDurableSnapshot<K, V> = Readonly<{
  generation: number;
  entries: readonly LatestDurableEntry<K, V>[];
}>;

export type LatestDurableUpsertOutcome = Readonly<{ kind: LatestDurableUpsertKind }>;
export type LatestDurableClaimOutcome<K, V> =
  | Readonly<{ kind: "claimed"; envelope: LatestDurableEnvelope<K, V> }>
  | Readonly<{ kind: "stale_generation"; current: number }>
  | Readonly<{ kind: "empty" | "busy" }>;
export type LatestDurableAckOutcome =
  | Readonly<{ kind: "advanced" | "unchanged"; durableThrough: number }>
  | Readonly<{ kind: "stale_generation"; current: number }>
  | Readonly<{ kind: "unknown_epoch" }>;
export type LatestDurableFailureOutcome =
  | Readonly<{ kind: "pending" | "superseded" | "unknown_epoch" }>
  | Readonly<{ kind: "stale_generation"; current: number }>;
export type LatestDurableReconnectOutcome =
  | Readonly<{
      kind: "advanced";
      generation: number;
      requeued: number;
      superseded: number;
    }>
  | Readonly<{ kind: "unchanged"; generation: number }>
  | Readonly<{ kind: "stale_generation"; current: number }>;

export class LatestDurableProjectionCore<K = string, V = unknown> {
  constructor(generation?: number);
  readonly generation: number;
  readonly version: number;
  entry(key: K): LatestDurableEntryView<K, V> | null;
  snapshot(): LatestDurableSnapshot<K, V>;
  upsertDesired(key: K, epoch: number, value: V): LatestDurableUpsertOutcome;
  claim(key: K, generation: number): LatestDurableClaimOutcome<K, V>;
  ackApplied(key: K, generation: number, epoch: number): LatestDurableAckOutcome;
  failRetryable(key: K, generation: number, epoch: number): LatestDurableFailureOutcome;
  reconnect(newGeneration: number): LatestDurableReconnectOutcome;
}
