// Graph-agnostic queue-family cores shared by all three execution flavors.

export type QueuePushErrorLabel = "Full" | "Closed";
export type QueuePopErrorLabel = "Empty" | "Closed";

export const QueuePushError: Readonly<{ Full: "Full"; Closed: "Closed" }>;
export const QueuePopError: Readonly<{ Empty: "Empty"; Closed: "Closed" }>;

/** The reader-kind invalidation matrix returned by every mutating queue op. */
export type QueueInvalidates = {
  head: boolean;
  len: boolean;
  is_empty: boolean;
  is_full: boolean;
  closed: boolean;
};

export type WorkQueueInvalidates = {
  pending_len: boolean;
  is_empty: boolean;
  in_flight_len: boolean;
  dead_letter_len: boolean;
};

export const QUEUE_READER_KINDS: readonly (keyof QueueInvalidates)[];
export const WORK_QUEUE_READER_KINDS: readonly (keyof WorkQueueInvalidates)[];

export function emptyQueueInvalidates(): QueueInvalidates;
export function emptyWorkQueueInvalidates(): WorkQueueInvalidates;

/** Result of a push op (`returns` is the error label, or `null` on success). */
export type QueuePushResult = {
  returns: null | QueuePushErrorLabel;
  invalidates: QueueInvalidates;
};

/** Result of a pop op (`returns` is the element, or the error label). */
export type QueuePopResult = {
  returns: unknown | QueuePopErrorLabel;
  invalidates: QueueInvalidates;
};

/** Result of a close op. */
export type QueueCloseResult = {
  returns: null;
  invalidates: QueueInvalidates;
};

/** A duck-typed `QueueStorage` backend. */
export type QueueStorage = {
  tryPush(value: unknown): null | QueuePushErrorLabel;
  tryPop(): unknown | QueuePopErrorLabel;
  peek?(): unknown;
  len(): number;
  capacity?(): number | null;
  isClosed(): boolean;
  close(): void;
  snapshot?(): QueueStorageSnapshot;
};

export type QueueStorageSnapshot = {
  elements: unknown[];
  capacity: number | null;
  closed: boolean;
};

export type QueueInitial = {
  elements?: unknown[];
  capacity?: number | null;
  closed?: boolean;
};

/** The reference `QueueStorage` backend (unbounded or bounded array FIFO). */
export class VecDequeStorage {
  constructor(initial?: QueueInitial);
  elements: unknown[];
  static from(initial?: QueueInitial): VecDequeStorage;
  tryPush(value: unknown): null | QueuePushErrorLabel;
  tryPop(): unknown | QueuePopErrorLabel;
  peek(): unknown;
  len(): number;
  capacity(): number | null;
  isClosed(): boolean;
  close(): void;
  snapshot(): QueueStorageSnapshot;
}

/** The graph-agnostic FIFO algebra: state plus the reader-kind transitions. */
export class QueueCore {
  constructor(storage?: QueueStorage, initial?: QueueInitial);
  readonly storage: QueueStorage;
  tryPush(value: unknown): QueuePushResult;
  tryPop(): QueuePopResult;
  close(): QueueCloseResult;
  peek(): unknown;
  len(): number;
  isEmpty(): boolean;
  isFull(): boolean;
  isClosed(): boolean;
  capacity(): number | null;
  elements(): unknown[];
}

export type TopicDurabilityLabel = "durable" | "ephemeral";
export const TopicDurability: Readonly<{ Durable: "durable"; Ephemeral: "ephemeral" }>;

export type TopicSubscribeOutcomeLabel = "Created" | "Reconnected" | "AlreadyConnected";
export const TopicSubscribeOutcome: Readonly<{
  Created: "Created";
  Reconnected: "Reconnected";
  AlreadyConnected: "AlreadyConnected";
}>;

export type TopicSubscriptionSnapshot = {
  cursor: number;
  durability: TopicDurabilityLabel;
  connected: boolean;
};

export type TopicInitial = {
  base_offset?: number;
  elements?: unknown[];
  subscriptions?: Record<string, TopicSubscriptionSnapshot>;
};

export type TopicMutationResult = {
  returns: unknown;
  invalidates: Record<string, boolean>;
  offset?: number;
};

/** The graph-agnostic broadcast-log algebra with per-subscriber cursors. */
export class TopicCore {
  constructor(initial?: TopicInitial);
  subscribe(id: string, durability: TopicDurabilityLabel): TopicMutationResult;
  reconnect(id: string): TopicMutationResult;
  disconnect(id: string): TopicMutationResult;
  publish(value: unknown): TopicMutationResult;
  advance(id: string): TopicMutationResult;
  restart(id: string): TopicMutationResult;
  gc(): TopicMutationResult;
  readStream(id: string): unknown[];
  baseOffset(): number;
  endOffset(): number;
  elements(): unknown[];
  subscriptionIds(): string[];
  subscription(id: string): TopicSubscriptionSnapshot | null;
  subscriptions(): Record<string, TopicSubscriptionSnapshot>;
  snapshot(): Required<TopicInitial>;
}

export type WorkQueueItem<T = unknown> = { item_id: number; value: T; attempts: number };

export type WorkQueueDelivery<T = unknown> = {
  delivery_id: number;
  item_id: number;
  value: T;
  worker: string;
  attempt: number;
  deadline: number;
};

export type WorkQueueDeadLetter<T = unknown> = {
  item_id: number;
  value: T;
  attempts: number;
  reason: "nack" | "expired";
};

export const WorkQueueDeadLetterReason: Readonly<{ Nack: "nack"; Expired: "expired" }>;

export type WorkQueueConfig = { visibility_timeout: number; max_deliveries: number };

/** The graph-agnostic competing-consumer lease algebra. */
export class WorkQueueCore<T = unknown> {
  constructor(config: WorkQueueConfig);
  push(value: T): { returns: number; invalidates: WorkQueueInvalidates };
  claim(
    worker: string,
    now: number,
  ): { returns: WorkQueueDelivery<T> | null; invalidates: WorkQueueInvalidates };
  ack(worker: string, deliveryId: number): { returns: boolean; invalidates: WorkQueueInvalidates };
  nack(worker: string, deliveryId: number): { returns: boolean; invalidates: WorkQueueInvalidates };
  reapExpired(now: number): { returns: number; invalidates: WorkQueueInvalidates };
  pendingLen(): number;
  isEmpty(): boolean;
  inFlightLen(): number;
  deadLetterLen(): number;
  pendingItems(): WorkQueueItem<T>[];
  inFlightDeliveries(): WorkQueueDelivery<T>[];
  deadLetterItems(): WorkQueueDeadLetter<T>[];
}
