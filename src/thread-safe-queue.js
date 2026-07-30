// The `Send + Sync` flavor of the queue family (`#lzqueuefamilyflavors`):
// ThreadSafeQueueCell / ThreadSafeTopicCell / ThreadSafeWorkQueueCell.
//
// Same algebra as the single-threaded shells — literally the same
// `QueueCore` / `TopicCore` / `WorkQueueCore` from `./queue-core.js`. What this
// file owns is the locking discipline, and it is the reason each flavor exists
// as its own type rather than as a flag:
//
//  * The core is guarded by its OWN mutex, not the context's. A reader's compute
//    body runs while the context lock is held (every `ThreadSafeContext`
//    operation is a critical section) and then takes the core lock. So a mutator
//    that invalidated while still holding the core lock would acquire the two in
//    the opposite order, and two realms doing both at once deadlock. Every op
//    below therefore takes the core lock, computes the transition, RELEASES it,
//    and only then writes the graph.
//  * Invalidation fans out through ONE `clearComputeds` call, which
//    `ThreadSafeContext` runs as a single critical section. One op is one
//    frontier walk, so no other realm observes `len` decremented while `is_full`
//    still reads stale — the torn observation the reader-kind matrix exists to
//    rule out.
//
// Mirrors `lazily-rs/src/thread_safe_queue.rs`, `thread_safe_topic.rs` and
// `thread_safe_work_queue.rs`.

import {
  QueueCore,
  TopicCore,
  VecDequeStorage,
  WorkQueueCore,
} from "./queue-core.js";
import { AtomicMutex } from "./thread-safe.js";

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

function requireThreadSafeContext(ctx, what) {
  if (
    !ctx ||
    typeof ctx.computed !== "function" ||
    typeof ctx.get !== "function" ||
    typeof ctx.clearComputeds !== "function" ||
    typeof ctx.mutex !== "object"
  ) {
    throw new TypeError(`${what} requires a lazily ThreadSafeContext`);
  }
}

function readNode(ctx, node, cx) {
  return cx === undefined ? ctx.get(node) : cx.get(node);
}

// ---------------------------------------------------------------------------
// ThreadSafeQueueCell
// ---------------------------------------------------------------------------

/**
 * The `Send + Sync` reactive FIFO. Reader kinds invalidate independently: a push
 * onto a non-empty queue never touches `head`, a pop always does.
 */
export class ThreadSafeQueueCell {
  /**
   * @param {import("./thread-safe.js").ThreadSafeContext} ctx
   * @param {{ elements?: unknown[], capacity?: number | null, closed?: boolean }} [initial]
   * @param {object} [storage] duck-typed `QueueStorage`; defaults to `VecDequeStorage`.
   * @param {AtomicMutex} [mutex] the CORE lock. Deliberately not the context's.
   */
  constructor(ctx, initial = {}, storage, mutex) {
    requireThreadSafeContext(ctx, "ThreadSafeQueueCell");
    this._ctx = ctx;
    this._core = new QueueCore(storage ?? new VecDequeStorage(initial));
    this._mutex = mutex ?? new AtomicMutex();
    this._readers = {
      head: ctx.computed(() => this._locked(() => this._core.peek())),
      len: ctx.computed(() => this._locked(() => this._core.len())),
      is_empty: ctx.computed(() => this._locked(() => this._core.isEmpty())),
      is_full: ctx.computed(() => this._locked(() => this._core.isFull())),
      closed: ctx.computed(() => this._locked(() => this._core.isClosed())),
    };
  }

  static from(ctx, initial, storage, mutex) {
    return new ThreadSafeQueueCell(ctx, initial, storage, mutex);
  }

  /** The mutex guarding the queue core. */
  get mutex() {
    return this._mutex;
  }

  _locked(body) {
    return this._mutex.runExclusive(body);
  }

  /**
   * Apply one core-reported invalidation set with the CORE LOCK ALREADY
   * RELEASED, in a single frontier walk.
   */
  _apply(result) {
    const changed = [];
    for (const [kind, didChange] of Object.entries(result.invalidates)) {
      if (didChange) changed.push(this._readers[kind]);
    }
    if (changed.length > 0) this._ctx.clearComputeds(changed);
    return result;
  }

  tryPush(value) {
    return this._apply(this._locked(() => this._core.tryPush(value)));
  }

  tryPop() {
    return this._apply(this._locked(() => this._core.tryPop()));
  }

  close() {
    return this._apply(this._locked(() => this._core.close()));
  }

  head(cx) {
    return readNode(this._ctx, this._readers.head, cx);
  }

  len(cx) {
    return readNode(this._ctx, this._readers.len, cx);
  }

  isEmpty(cx) {
    return readNode(this._ctx, this._readers.is_empty, cx);
  }

  isFull(cx) {
    return readNode(this._ctx, this._readers.is_full, cx);
  }

  isClosed(cx) {
    return readNode(this._ctx, this._readers.closed, cx);
  }

  capacity() {
    return this._locked(() => this._core.capacity());
  }

  elements() {
    return this._locked(() => this._core.elements());
  }

  /** The four derived reader kinds plus `closed`, for graph-level probes. */
  readerHandles() {
    return { ...this._readers };
  }
}

// ---------------------------------------------------------------------------
// ThreadSafeTopicCell
// ---------------------------------------------------------------------------

/**
 * The `Send + Sync` broadcast topic. One reader per subscriber id, minted
 * lazily and cleared exactly when that subscriber's unread suffix moves.
 */
export class ThreadSafeTopicCell {
  /**
   * @param {import("./thread-safe.js").ThreadSafeContext} ctx
   * @param {object} [initial]
   * @param {AtomicMutex} [mutex]
   */
  constructor(ctx, initial = {}, mutex) {
    requireThreadSafeContext(ctx, "ThreadSafeTopicCell");
    if (typeof ctx.computedRippleWhen !== "function") {
      throw new TypeError("ThreadSafeTopicCell requires ThreadSafeContext#computedRippleWhen");
    }
    this._ctx = ctx;
    this._core = new TopicCore(initial);
    this._mutex = mutex ?? new AtomicMutex();
    this._readers = new Map();
  }

  static from(ctx, initial = {}, mutex) {
    return new ThreadSafeTopicCell(ctx, initial, mutex);
  }

  get mutex() {
    return this._mutex;
  }

  _locked(body) {
    return this._mutex.runExclusive(body);
  }

  _reader(id) {
    let reader = this._readers.get(id);
    if (reader === undefined) {
      // Connection/cursor identity is observable even when the unread value is
      // the same empty array before and after a transition, so a cleared topic
      // reader must propagate rather than equality-suppress.
      reader = this._ctx.computedRippleWhen(
        () => this._locked(() => this._core.readStream(id)),
        () => true,
      );
      this._readers.set(id, reader);
    }
    return reader;
  }

  _apply(result) {
    const readers = [];
    for (const [id, changed] of Object.entries(result.invalidates)) {
      if (changed) readers.push(this._reader(id));
    }
    this._ctx.clearComputeds(readers);
    return result;
  }

  subscribe(id, durability) {
    return this._apply(this._locked(() => this._core.subscribe(id, durability)));
  }

  reconnect(id) {
    return this._apply(this._locked(() => this._core.reconnect(id)));
  }

  disconnect(id) {
    return this._apply(this._locked(() => this._core.disconnect(id)));
  }

  publish(value) {
    return this._apply(this._locked(() => this._core.publish(value)));
  }

  advance(id) {
    return this._apply(this._locked(() => this._core.advance(id)));
  }

  restart(id) {
    return this._apply(this._locked(() => this._core.restart(id)));
  }

  gc() {
    return this._apply(this._locked(() => this._core.gc()));
  }

  readStream(id, cx) {
    return readNode(this._ctx, this._reader(id), cx);
  }

  read(id, cx) {
    return this.readStream(id, cx)[0] ?? null;
  }

  baseOffset() {
    return this._locked(() => this._core.baseOffset());
  }

  endOffset() {
    return this._locked(() => this._core.endOffset());
  }

  elements() {
    return this._locked(() => this._core.elements());
  }

  subscription(id) {
    return this._locked(() => this._core.subscription(id));
  }

  subscriptions() {
    return this._locked(() => this._core.subscriptions());
  }

  snapshot() {
    return this._locked(() => this._core.snapshot());
  }

  readerHandle(id) {
    return this._reader(id);
  }
}

// ---------------------------------------------------------------------------
// ThreadSafeWorkQueueCell
// ---------------------------------------------------------------------------

/** The `Send + Sync` competing-consumer work queue. */
export class ThreadSafeWorkQueueCell {
  /**
   * @param {import("./thread-safe.js").ThreadSafeContext} ctx
   * @param {{visibility_timeout: number, max_deliveries: number}} config
   * @param {AtomicMutex} [mutex]
   */
  constructor(ctx, config, mutex) {
    requireThreadSafeContext(ctx, "ThreadSafeWorkQueueCell");
    this._ctx = ctx;
    this._core = new WorkQueueCore(config);
    this._mutex = mutex ?? new AtomicMutex();
    this._readers = {
      pending_len: ctx.computed(() => this._locked(() => this._core.pendingLen())),
      is_empty: ctx.computed(() => this._locked(() => this._core.isEmpty())),
      in_flight_len: ctx.computed(() => this._locked(() => this._core.inFlightLen())),
      dead_letter_len: ctx.computed(() => this._locked(() => this._core.deadLetterLen())),
    };
  }

  get mutex() {
    return this._mutex;
  }

  _locked(body) {
    return this._mutex.runExclusive(body);
  }

  _apply(result) {
    const changed = [];
    for (const [kind, didChange] of Object.entries(result.invalidates)) {
      if (didChange) changed.push(this._readers[kind]);
    }
    if (changed.length > 0) this._ctx.clearComputeds(changed);
    return result;
  }

  push(value) {
    return this._apply(this._locked(() => this._core.push(value)));
  }

  claim(worker, now) {
    return this._apply(this._locked(() => this._core.claim(worker, now)));
  }

  ack(worker, deliveryId) {
    return this._apply(this._locked(() => this._core.ack(worker, deliveryId)));
  }

  nack(worker, deliveryId) {
    return this._apply(this._locked(() => this._core.nack(worker, deliveryId)));
  }

  reapExpired(now) {
    return this._apply(this._locked(() => this._core.reapExpired(now)));
  }

  pendingLen(cx) {
    return readNode(this._ctx, this._readers.pending_len, cx);
  }

  isEmpty(cx) {
    return readNode(this._ctx, this._readers.is_empty, cx);
  }

  inFlightLen(cx) {
    return readNode(this._ctx, this._readers.in_flight_len, cx);
  }

  deadLetterLen(cx) {
    return readNode(this._ctx, this._readers.dead_letter_len, cx);
  }

  pendingItems() {
    return this._locked(() => this._core.pendingItems());
  }

  inFlightDeliveries() {
    return this._locked(() => this._core.inFlightDeliveries());
  }

  deadLetterItems() {
    return this._locked(() => this._core.deadLetterItems());
  }

  readerHandles() {
    return { ...this._readers };
  }
}
