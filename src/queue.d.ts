// Reactive queue: QueueCell + pluggable QueueStorage backend (#lzqueue).
// Pure logic — no reactive graph. See queue.js for the reader-kind invalidation
// contract and the shell / storage split.

export type QueuePushErrorLabel = "Full" | "Closed";
export type QueuePopErrorLabel = "Empty" | "Closed";

export const QueuePushError: Readonly<{ Full: "Full"; Closed: "Closed" }>;
export const QueuePopError: Readonly<{ Empty: "Empty"; Closed: "Closed" }>;

/** The reader-kind invalidation matrix returned by every mutating op. */
export type QueueInvalidates = {
  head: boolean;
  len: boolean;
  is_empty: boolean;
  is_full: boolean;
  closed: boolean;
};

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
  peek(): unknown;
  len(): number;
  capacity(): number | null;
  isClosed(): boolean;
  close(): void;
  snapshot(): QueueStorageSnapshot;
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

/** A reactive FIFO queue — SPSC primitive with an MPSC usage rule. */
export class QueueCell {
  constructor(initial?: QueueInitial, storage?: QueueStorage);
  static from(initial?: QueueInitial, storage?: QueueStorage): QueueCell;
  tryPush(value: unknown): QueuePushResult;
  tryPop(): QueuePopResult;
  close(): QueueCloseResult;
  head(): unknown;
  len(): number;
  isEmpty(): boolean;
  isFull(): boolean;
  isClosed(): boolean;
  capacity(): number | null;
  elements(): unknown[];
}
