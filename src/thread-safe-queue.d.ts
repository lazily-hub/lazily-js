import type { AtomicMutex, ThreadSafeContext } from "./thread-safe.js";
import type { Compute } from "./reactive.js";
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

// The `Send + Sync` flavor of the queue family. Same algebra as ./queue.js —
// what differs is that the core is behind its own mutex and every mutator
// releases it before writing the graph.

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

/** The `Send + Sync` reactive FIFO. */
export class ThreadSafeQueueCell {
  constructor(
    ctx: ThreadSafeContext,
    initial?: QueueInitial,
    storage?: QueueStorage,
    mutex?: AtomicMutex,
  );
  static from(
    ctx: ThreadSafeContext,
    initial?: QueueInitial,
    storage?: QueueStorage,
    mutex?: AtomicMutex,
  ): ThreadSafeQueueCell;
  /** The mutex guarding the queue core (never the context's). */
  readonly mutex: AtomicMutex;
  tryPush(value: unknown): QueuePushResult;
  tryPop(): QueuePopResult;
  close(): QueueCloseResult;
  head(cx?: Compute): unknown;
  len(cx?: Compute): number;
  isEmpty(cx?: Compute): boolean;
  isFull(cx?: Compute): boolean;
  isClosed(cx?: Compute): boolean;
  capacity(): number | null;
  elements(): unknown[];
  readerHandles(): Record<string, unknown>;
}

/** The `Send + Sync` broadcast topic. */
export class ThreadSafeTopicCell {
  constructor(ctx: ThreadSafeContext, initial?: TopicInitial, mutex?: AtomicMutex);
  static from(
    ctx: ThreadSafeContext,
    initial?: TopicInitial,
    mutex?: AtomicMutex,
  ): ThreadSafeTopicCell;
  readonly mutex: AtomicMutex;
  subscribe(id: string, durability: TopicDurabilityLabel): TopicMutationResult;
  reconnect(id: string): TopicMutationResult;
  disconnect(id: string): TopicMutationResult;
  publish(value: unknown): TopicMutationResult;
  advance(id: string): TopicMutationResult;
  restart(id: string): TopicMutationResult;
  gc(): TopicMutationResult;
  readStream(id: string, cx?: Compute): unknown[];
  read(id: string, cx?: Compute): unknown;
  baseOffset(): number;
  endOffset(): number;
  elements(): unknown[];
  subscription(id: string): TopicSubscriptionSnapshot | null;
  subscriptions(): Record<string, TopicSubscriptionSnapshot>;
  snapshot(): Required<TopicInitial>;
  readerHandle(id: string): unknown;
}

/** The `Send + Sync` competing-consumer work queue. */
export class ThreadSafeWorkQueueCell<T = unknown> {
  constructor(ctx: ThreadSafeContext, config: WorkQueueConfig, mutex?: AtomicMutex);
  readonly mutex: AtomicMutex;
  push(value: T): { returns: number; invalidates: WorkQueueInvalidates };
  claim(
    worker: string,
    now: number,
  ): { returns: WorkQueueDelivery<T> | null; invalidates: WorkQueueInvalidates };
  ack(worker: string, deliveryId: number): { returns: boolean; invalidates: WorkQueueInvalidates };
  nack(worker: string, deliveryId: number): { returns: boolean; invalidates: WorkQueueInvalidates };
  reapExpired(now: number): { returns: number; invalidates: WorkQueueInvalidates };
  pendingLen(cx?: Compute): number;
  isEmpty(cx?: Compute): boolean;
  inFlightLen(cx?: Compute): number;
  deadLetterLen(cx?: Compute): number;
  pendingItems(): WorkQueueItem<T>[];
  inFlightDeliveries(): WorkQueueDelivery<T>[];
  deadLetterItems(): WorkQueueDeadLetter<T>[];
  readerHandles(): Record<string, unknown>;
}
