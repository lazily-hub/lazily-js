import type { AsyncComputed, AsyncContext } from "./reactive-async.js";
import type { Computed, Context, SlotHandle } from "./reactive.js";
import type { AtomicMutex, ThreadSafeContext } from "./thread-safe.js";
import type {
  LatestDurableAckOutcome,
  LatestDurableClaimOutcome,
  LatestDurableEntryView,
  LatestDurableFailureOutcome,
  LatestDurableReconnectOutcome,
  LatestDurableSnapshot,
  LatestDurableUpsertOutcome,
} from "./latest-durable-projection-core.js";

export * from "./latest-durable-projection-core.js";

export class LatestDurableProjection<K = string, V = unknown> {
  constructor(ctx: Context, generation?: number);
  readonly generationState: Computed<number>;
  readonly snapshotState: Computed<LatestDurableSnapshot<K, V>>;
  entryState(key: K): Computed<LatestDurableEntryView<K, V> | null>;
  upsertDesired(key: K, epoch: number, value: V): LatestDurableUpsertOutcome;
  claim(key: K, generation: number): LatestDurableClaimOutcome<K, V>;
  ackApplied(key: K, generation: number, epoch: number): LatestDurableAckOutcome;
  failRetryable(key: K, generation: number, epoch: number): LatestDurableFailureOutcome;
  reconnect(newGeneration: number): LatestDurableReconnectOutcome;
}

export class ThreadSafeLatestDurableProjection<K = string, V = unknown> {
  constructor(ctx: ThreadSafeContext, generation?: number, options?: { mutex?: AtomicMutex });
  readonly mutex: AtomicMutex;
  readonly generationState: SlotHandle<number>;
  readonly snapshotState: SlotHandle<LatestDurableSnapshot<K, V>>;
  entryState(key: K): SlotHandle<LatestDurableEntryView<K, V> | null>;
  upsertDesired(key: K, epoch: number, value: V): LatestDurableUpsertOutcome;
  claim(key: K, generation: number): LatestDurableClaimOutcome<K, V>;
  ackApplied(key: K, generation: number, epoch: number): LatestDurableAckOutcome;
  failRetryable(key: K, generation: number, epoch: number): LatestDurableFailureOutcome;
  reconnect(newGeneration: number): LatestDurableReconnectOutcome;
}

export class AsyncLatestDurableProjection<K = string, V = unknown> {
  constructor(ctx: AsyncContext, generation?: number);
  readonly generationState: AsyncComputed<number>;
  readonly snapshotState: AsyncComputed<LatestDurableSnapshot<K, V>>;
  entryState(key: K): AsyncComputed<LatestDurableEntryView<K, V> | null>;
  upsertDesired(key: K, epoch: number, value: V): LatestDurableUpsertOutcome;
  claim(key: K, generation: number): LatestDurableClaimOutcome<K, V>;
  ackApplied(key: K, generation: number, epoch: number): LatestDurableAckOutcome;
  failRetryable(key: K, generation: number, epoch: number): LatestDurableFailureOutcome;
  reconnect(newGeneration: number): LatestDurableReconnectOutcome;
}
