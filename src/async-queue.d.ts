import type { AsyncComputeContext, AsyncComputed, AsyncContext } from "./reactive-async.js";
import type {
  QueueCloseResult,
  QueueInitial,
  QueuePopResult,
  QueuePushResult,
  QueueStorage,
  TopicDurabilityLabel,
  TopicInitial,
  TopicMutationResult,
  TopicSubscriptionSnapshot,
  WorkQueueConfig,
  WorkQueueDeadLetter,
  WorkQueueDelivery,
  WorkQueueInvalidates,
  WorkQueueItem,
} from "./queue-core.js";

// The `AsyncContext` flavor of the queue family. Mutators are synchronous —
// ordering is not async-coloured; only reader materialization is, because this
// binding's async graph has no synchronous compute constructor.

export type {
  QueueCloseResult,
  QueueInitial,
  QueueInvalidates,
  QueuePopErrorLabel,
  QueuePopResult,
  QueuePushErrorLabel,
  QueuePushResult,
  QueueStorage,
  QueueStorageSnapshot,
  TopicDurabilityLabel,
  TopicInitial,
  TopicMutationResult,
  TopicSubscribeOutcomeLabel,
  TopicSubscriptionSnapshot,
  WorkQueueConfig,
  WorkQueueDeadLetter,
  WorkQueueDelivery,
  WorkQueueInvalidates,
  WorkQueueItem,
} from "./queue-core.js";

export {
  QUEUE_READER_KINDS,
  QueueCore,
  QueuePopError,
  QueuePushError,
  TopicCore,
  TopicDurability,
  TopicSubscribeOutcome,
  VecDequeStorage,
  WORK_QUEUE_READER_KINDS,
  WorkQueueCore,
  WorkQueueDeadLetterReason,
  emptyQueueInvalidates,
  emptyWorkQueueInvalidates,
} from "./queue-core.js";

/** The `AsyncContext` reactive FIFO. Reads resolve through `getAsync`. */
export class AsyncQueueCell {
  constructor(ctx: AsyncContext, initial?: QueueInitial, storage?: QueueStorage);
  static from(
    ctx: AsyncContext,
    initial?: QueueInitial,
    storage?: QueueStorage,
  ): AsyncQueueCell;
  tryPush(value: unknown): QueuePushResult;
  tryPop(): QueuePopResult;
  close(): QueueCloseResult;
  head(cx?: AsyncComputeContext): Promise<unknown>;
  len(cx?: AsyncComputeContext): Promise<number>;
  isEmpty(cx?: AsyncComputeContext): Promise<boolean>;
  isFull(cx?: AsyncComputeContext): Promise<boolean>;
  isClosed(cx?: AsyncComputeContext): Promise<boolean>;
  capacity(): number | null;
  elements(): unknown[];
  readerHandles(): Record<string, AsyncComputed<unknown>>;
}

/** The `AsyncContext` broadcast topic. */
export class AsyncTopicCell {
  constructor(ctx: AsyncContext, initial?: TopicInitial);
  static from(ctx: AsyncContext, initial?: TopicInitial): AsyncTopicCell;
  subscribe(id: string, durability: TopicDurabilityLabel): TopicMutationResult;
  reconnect(id: string): TopicMutationResult;
  disconnect(id: string): TopicMutationResult;
  publish(value: unknown): TopicMutationResult;
  advance(id: string): TopicMutationResult;
  restart(id: string): TopicMutationResult;
  gc(): TopicMutationResult;
  readStream(id: string, cx?: AsyncComputeContext): Promise<unknown[]>;
  read(id: string, cx?: AsyncComputeContext): Promise<unknown>;
  baseOffset(): number;
  endOffset(): number;
  elements(): unknown[];
  subscription(id: string): TopicSubscriptionSnapshot | null;
  subscriptions(): Record<string, TopicSubscriptionSnapshot>;
  snapshot(): Required<TopicInitial>;
  readerHandle(id: string): AsyncComputed<unknown[]>;
}

/** The `AsyncContext` competing-consumer work queue. */
export class AsyncWorkQueueCell<T = unknown> {
  constructor(ctx: AsyncContext, config: WorkQueueConfig);
  push(value: T): { returns: number; invalidates: WorkQueueInvalidates };
  claim(
    worker: string,
    now: number,
  ): { returns: WorkQueueDelivery<T> | null; invalidates: WorkQueueInvalidates };
  ack(worker: string, deliveryId: number): { returns: boolean; invalidates: WorkQueueInvalidates };
  nack(worker: string, deliveryId: number): { returns: boolean; invalidates: WorkQueueInvalidates };
  reapExpired(now: number): { returns: number; invalidates: WorkQueueInvalidates };
  pendingLen(cx?: AsyncComputeContext): Promise<number>;
  isEmpty(cx?: AsyncComputeContext): Promise<boolean>;
  inFlightLen(cx?: AsyncComputeContext): Promise<number>;
  deadLetterLen(cx?: AsyncComputeContext): Promise<number>;
  pendingItems(): WorkQueueItem<T>[];
  inFlightDeliveries(): WorkQueueDelivery<T>[];
  deadLetterItems(): WorkQueueDeadLetter<T>[];
  readerHandles(): Record<string, AsyncComputed<unknown>>;
}
