// The `AsyncContext` flavor of the queue family (`#lzqueuefamilyflavors`):
// AsyncQueueCell / AsyncTopicCell / AsyncWorkQueueCell.
//
// Same algebra as the other two flavors — literally the same
// `QueueCore` / `TopicCore` / `WorkQueueCore` from `./queue-core.js`.
//
// **Ordering is not async-coloured.** A queue's reader kinds derive from state
// the graph does not own — the FIFO, the subscriber cursors, the lease table —
// so nothing has to be awaited to decide what a push, an advance, or a reap
// changed. Every mutator below is therefore synchronous and returns a plain
// `{returns, invalidates}`, exactly as in the other two flavors.
//
// What IS async-coloured here is reader materialization, and only because this
// binding's `AsyncContext` offers no synchronous compute constructor: its
// derived nodes are built with `computedAsync` and read with `getAsync`. That is
// the same single async obligation `async-ingress.js` and
// `async-reactive-family.js` carry — a property of the JS async graph, not of
// the queue algebra. (lazily-rs's `AsyncQueueCell` uses a synchronous compute on
// the async graph and so returns plain values from its readers too.)
//
// Multi-root invalidation goes through `AsyncContext#clearComputeds`, which
// marks every root before any microtask runs, so an effect reading several
// reader kinds still observes them together: no subscriber sees `len`
// decremented while `is_full` still reads stale.
//
// Mirrors `lazily-rs/src/async_queue.rs`, `async_topic.rs` and
// `async_work_queue.rs`.

import { QueueCore, TopicCore, VecDequeStorage, WorkQueueCore } from "./queue-core.js";

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

function requireAsyncContext(ctx, what) {
  if (
    !ctx ||
    typeof ctx.computedAsync !== "function" ||
    typeof ctx.getAsync !== "function" ||
    typeof ctx.clearComputeds !== "function"
  ) {
    throw new TypeError(`${what} requires a lazily AsyncContext`);
  }
}

function readNode(ctx, node, cx) {
  return cx === undefined ? ctx.getAsync(node) : cx.getAsync(node);
}

// ---------------------------------------------------------------------------
// AsyncQueueCell
// ---------------------------------------------------------------------------

/**
 * The `AsyncContext` reactive FIFO. Mutators are synchronous; reader kinds
 * resolve through `getAsync` and invalidate independently.
 */
export class AsyncQueueCell {
  /**
   * @param {import("./reactive-async.js").AsyncContext} ctx
   * @param {{ elements?: unknown[], capacity?: number | null, closed?: boolean }} [initial]
   * @param {object} [storage] duck-typed `QueueStorage`; defaults to `VecDequeStorage`.
   */
  constructor(ctx, initial = {}, storage) {
    requireAsyncContext(ctx, "AsyncQueueCell");
    this._ctx = ctx;
    this._core = new QueueCore(storage ?? new VecDequeStorage(initial));
    this._readers = {
      head: ctx.computedAsync(async () => this._core.peek()),
      len: ctx.computedAsync(async () => this._core.len()),
      is_empty: ctx.computedAsync(async () => this._core.isEmpty()),
      is_full: ctx.computedAsync(async () => this._core.isFull()),
      closed: ctx.computedAsync(async () => this._core.isClosed()),
    };
  }

  static from(ctx, initial, storage) {
    return new AsyncQueueCell(ctx, initial, storage);
  }

  _apply(result) {
    const changed = [];
    for (const [kind, didChange] of Object.entries(result.invalidates)) {
      if (didChange) changed.push(this._readers[kind]);
    }
    if (changed.length > 0) this._ctx.clearComputeds(changed);
    return result;
  }

  tryPush(value) {
    return this._apply(this._core.tryPush(value));
  }

  tryPop() {
    return this._apply(this._core.tryPop());
  }

  close() {
    return this._apply(this._core.close());
  }

  /** @returns {Promise<unknown>} */
  head(cx) {
    return readNode(this._ctx, this._readers.head, cx);
  }

  /** @returns {Promise<number>} */
  len(cx) {
    return readNode(this._ctx, this._readers.len, cx);
  }

  /** @returns {Promise<boolean>} */
  isEmpty(cx) {
    return readNode(this._ctx, this._readers.is_empty, cx);
  }

  /** @returns {Promise<boolean>} */
  isFull(cx) {
    return readNode(this._ctx, this._readers.is_full, cx);
  }

  /** @returns {Promise<boolean>} */
  isClosed(cx) {
    return readNode(this._ctx, this._readers.closed, cx);
  }

  capacity() {
    return this._core.capacity();
  }

  elements() {
    return this._core.elements();
  }

  readerHandles() {
    return { ...this._readers };
  }
}

// ---------------------------------------------------------------------------
// AsyncTopicCell
// ---------------------------------------------------------------------------

/**
 * The `AsyncContext` broadcast topic. One reader per subscriber id; a cleared
 * reader always propagates, because `computedAsync` carries no memo guard and
 * connection identity is observable even when the unread suffix is the same
 * empty array on both sides of a transition.
 */
export class AsyncTopicCell {
  /**
   * @param {import("./reactive-async.js").AsyncContext} ctx
   * @param {object} [initial]
   */
  constructor(ctx, initial = {}) {
    requireAsyncContext(ctx, "AsyncTopicCell");
    this._ctx = ctx;
    this._core = new TopicCore(initial);
    this._readers = new Map();
  }

  static from(ctx, initial = {}) {
    return new AsyncTopicCell(ctx, initial);
  }

  _reader(id) {
    let reader = this._readers.get(id);
    if (reader === undefined) {
      reader = this._ctx.computedAsync(async () => this._core.readStream(id));
      this._readers.set(id, reader);
    }
    return reader;
  }

  _apply(result) {
    const readers = [];
    for (const [id, changed] of Object.entries(result.invalidates)) {
      if (changed) readers.push(this._reader(id));
    }
    if (readers.length > 0) this._ctx.clearComputeds(readers);
    return result;
  }

  subscribe(id, durability) {
    return this._apply(this._core.subscribe(id, durability));
  }

  reconnect(id) {
    return this._apply(this._core.reconnect(id));
  }

  disconnect(id) {
    return this._apply(this._core.disconnect(id));
  }

  publish(value) {
    return this._apply(this._core.publish(value));
  }

  advance(id) {
    return this._apply(this._core.advance(id));
  }

  restart(id) {
    return this._apply(this._core.restart(id));
  }

  gc() {
    return this._apply(this._core.gc());
  }

  /** @returns {Promise<unknown[]>} */
  readStream(id, cx) {
    return readNode(this._ctx, this._reader(id), cx);
  }

  /** @returns {Promise<unknown>} */
  async read(id, cx) {
    const stream = await this.readStream(id, cx);
    return stream[0] ?? null;
  }

  baseOffset() {
    return this._core.baseOffset();
  }

  endOffset() {
    return this._core.endOffset();
  }

  elements() {
    return this._core.elements();
  }

  subscription(id) {
    return this._core.subscription(id);
  }

  subscriptions() {
    return this._core.subscriptions();
  }

  snapshot() {
    return this._core.snapshot();
  }

  readerHandle(id) {
    return this._reader(id);
  }
}

// ---------------------------------------------------------------------------
// AsyncWorkQueueCell
// ---------------------------------------------------------------------------

/** The `AsyncContext` competing-consumer work queue. */
export class AsyncWorkQueueCell {
  /**
   * @param {import("./reactive-async.js").AsyncContext} ctx
   * @param {{visibility_timeout: number, max_deliveries: number}} config
   */
  constructor(ctx, config) {
    requireAsyncContext(ctx, "AsyncWorkQueueCell");
    this._ctx = ctx;
    this._core = new WorkQueueCore(config);
    this._readers = {
      pending_len: ctx.computedAsync(async () => this._core.pendingLen()),
      is_empty: ctx.computedAsync(async () => this._core.isEmpty()),
      in_flight_len: ctx.computedAsync(async () => this._core.inFlightLen()),
      dead_letter_len: ctx.computedAsync(async () => this._core.deadLetterLen()),
    };
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
    return this._apply(this._core.push(value));
  }

  claim(worker, now) {
    return this._apply(this._core.claim(worker, now));
  }

  ack(worker, deliveryId) {
    return this._apply(this._core.ack(worker, deliveryId));
  }

  nack(worker, deliveryId) {
    return this._apply(this._core.nack(worker, deliveryId));
  }

  reapExpired(now) {
    return this._apply(this._core.reapExpired(now));
  }

  /** @returns {Promise<number>} */
  pendingLen(cx) {
    return readNode(this._ctx, this._readers.pending_len, cx);
  }

  /** @returns {Promise<boolean>} */
  isEmpty(cx) {
    return readNode(this._ctx, this._readers.is_empty, cx);
  }

  /** @returns {Promise<number>} */
  inFlightLen(cx) {
    return readNode(this._ctx, this._readers.in_flight_len, cx);
  }

  /** @returns {Promise<number>} */
  deadLetterLen(cx) {
    return readNode(this._ctx, this._readers.dead_letter_len, cx);
  }

  pendingItems() {
    return this._core.pendingItems();
  }

  inFlightDeliveries() {
    return this._core.inFlightDeliveries();
  }

  deadLetterItems() {
    return this._core.deadLetterItems();
  }

  readerHandles() {
    return { ...this._readers };
  }
}
