// Reactive queue family — single-threaded flavor (#lzqueue, #lztopiccell,
// #lzworkqueue).
//
// The transition algebra lives in `./queue-core.js` and is graph-agnostic; this
// file is the `Context`-bound shell. It mints dependency-free Computed reader
// kinds and, after each op, clears exactly the readers the core reported as
// dirtied — in one frontier walk, so no subscriber observes one reader kind
// updated while a sibling still reads stale.
//
// The same three cores back `./thread-safe-queue.js` and `./async-queue.js`
// (#lzqueuefamilyflavors), which is what makes "the three flavors obey ONE
// contract" structural rather than three copies agreeing by hand.
//
// QueueCell is specified as a single-producer / single-consumer (SPSC)
// primitive; MPSC (multi-producer) is a *usage rule* on the same type —
// multiple producers push inside one logical batch, and the batch boundary
// serializes the pushes into a deterministic order. There is no separate
// MPSCQueueCell type (`lazily-spec/cell-model.md` § "QueueCell — SPSC
// primitive with MPSC usage rule").
//
// Invalidation is scoped to **reader kind**, not individual positions. A push
// invalidates `len` / `is_empty` readers (and `head` when transitioning from
// empty, `is_full` when transitioning onto capacity); a pop invalidates `head`
// / `len` / `is_empty` readers (and `is_full` when transitioning off capacity).
// The `invalidates` matrix returned by each mutating op reports exactly which
// reader kinds changed — the core reader-kind independence law, which mirrors
// the `PartialEq` guard the reactive bindings implement for free.

import { QueueCore, TopicCore, WorkQueueCore, VecDequeStorage } from "./queue-core.js";

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

// ---------------------------------------------------------------------------
// QueueCell — the single-threaded reactive shell.
// ---------------------------------------------------------------------------

/**
 * A reactive FIFO queue — SPSC primitive with an MPSC usage rule (#lzqueue).
 *
 * Wraps a pluggable `QueueStorage` backend through `QueueCore` and, after each
 * op, reports which reader kinds (`head` / `len` / `is_empty` / `is_full` /
 * `closed`) changed via the returned `invalidates` matrix. The reader-kind
 * independence law — a push to a non-empty queue does NOT invalidate the `head`
 * reader, a pop does — is the core's; this shell only projects it onto a graph.
 * `peek`/`capacity` are optional storage capabilities.
 */
export class QueueCell {
  /**
   * @param {import("./reactive.js").Context} ctx
   * @param {{ elements?: unknown[], capacity?: number | null, closed?: boolean }} [initial]
   *   Passed to the default `VecDequeStorage` when no `storage` is given.
   * @param {object} [storage] A duck-typed `QueueStorage` backend. Defaults to
   *   a `VecDequeStorage` built from `initial`.
   */
  constructor(ctx, initial = {}, storage) {
    requireContext(ctx);
    this._ctx = ctx;
    this._core = new QueueCore(storage ?? new VecDequeStorage(initial));
    this._readers = {
      head: ctx.computed(() => this._core.peek()),
      len: ctx.computed(() => this._core.len()),
      is_empty: ctx.computed(() => this._core.isEmpty()),
      is_full: ctx.computed(() => this._core.isFull()),
      closed: ctx.computed(() => this._core.isClosed()),
    };
    Object.freeze(this);
  }

  static from(ctx, initial, storage) {
    return new QueueCell(ctx, initial, storage);
  }

  /** The graph-agnostic core, for callers composing on the algebra directly. */
  get core() {
    return this._core;
  }

  _apply(result) {
    clearChanged(this._ctx, this._readers, result.invalidates);
    return result;
  }

  // -- mutating ops ---------------------------------------------------------

  /**
   * Append `value` to the tail.
   * @returns {{ returns: null | "Full" | "Closed", invalidates: QueueInvalidates }}
   *   On rejection (`Full` / `Closed`) the queue state is unchanged and the
   *   `invalidates` matrix is all-false.
   */
  tryPush(value) {
    return this._apply(this._core.tryPush(value));
  }

  /**
   * Remove and return the head element. Pop on a closed *non-empty* queue
   * drains (returns the next element); only closed+empty yields `Closed`.
   * @returns {{ returns: unknown | "Empty" | "Closed", invalidates: QueueInvalidates }}
   */
  tryPop() {
    return this._apply(this._core.tryPop());
  }

  /**
   * Close the queue. Idempotent (no-op on an already-closed queue) and
   * terminal. After close, `tryPush` returns `Closed`; `tryPop` drains and
   * returns `Closed` only once empty.
   * @returns {{ returns: null, invalidates: QueueInvalidates }}
   *   The `closed` reader is invalidated only on the open → closed transition.
   */
  close() {
    return this._apply(this._core.close());
  }

  // -- reader-kind reads (current state, non-mutating) ----------------------

  /**
   * Current head value, or `null` when empty. `peek` is an optional storage
   * capability: a backend without it (a raw channel) has no `head` reader, so
   * this returns `null` — exactly as an unbounded backend's `isFull` is always
   * `false`.
   */
  head(cx) {
    return readComputed(this._ctx, this._readers.head, cx);
  }

  /** Number of buffered elements. */
  len(cx) {
    return readComputed(this._ctx, this._readers.len, cx);
  }

  /** Whether the queue is empty. */
  isEmpty(cx) {
    return readComputed(this._ctx, this._readers.is_empty, cx);
  }

  /**
   * Whether the queue is at capacity (the backpressure signal). Always `false`
   * for an unbounded backend.
   */
  isFull(cx) {
    return readComputed(this._ctx, this._readers.is_full, cx);
  }

  /** Whether the queue has been closed. */
  isClosed(cx) {
    return readComputed(this._ctx, this._readers.closed, cx);
  }

  /** The backend's capacity, or `null` if unbounded. */
  capacity() {
    return this._core.capacity();
  }

  /**
   * Snapshot the buffered elements in FIFO order. There is no reactive
   * random-access `queue[N]` reader; per-position reactivity is the domain of
   * `SourceMap`, not `QueueCell`.
   * @returns {unknown[]}
   */
  elements() {
    return this._core.elements();
  }
}

// ---------------------------------------------------------------------------
// TopicCell — broadcast log with independent subscriber cursors (#lztopiccell)
// ---------------------------------------------------------------------------

/**
 * Broadcast topic: every subscriber receives every published element using an
 * independent, non-destructive cursor. Mutating operations return the exact
 * per-subscriber invalidation matrix used by the canonical fixtures.
 */
export class TopicCell {
  /**
   * @param {import("./reactive.js").Context} ctx
   * @param {{
   *   base_offset?: number,
   *   elements?: unknown[],
   *   subscriptions?: Record<string, {cursor: number, durability: "durable" | "ephemeral", connected: boolean}>
   * }} [initial]
   */
  constructor(ctx, initial = {}) {
    requireContext(ctx);
    this._ctx = ctx;
    this._core = new TopicCore(initial);
    this._readers = new Map();
  }

  static from(ctx, initial = {}) {
    return new TopicCell(ctx, initial);
  }

  /** The graph-agnostic core. */
  get core() {
    return this._core;
  }

  _reader(id) {
    let reader = this._readers.get(id);
    if (reader === undefined) {
      // Connection/cursor identity is observable even when the unread value is
      // the same empty array before and after a transition, so a cleared topic
      // reader must propagate rather than equality-suppress.
      reader = this._ctx.computedRippleWhen(
        () => this._core.readStream(id),
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

  /** Create at tail, or reconnect an existing durable identity in place. */
  subscribe(id, durability) {
    return this._apply(this._core.subscribe(id, durability));
  }

  /** Reconnect a durable identity; unknown ids are created at the current tail. */
  reconnect(id) {
    return this._apply(this._core.reconnect(id));
  }

  /** Durable ids remain offline; ephemeral ids are removed. */
  disconnect(id) {
    return this._apply(this._core.disconnect(id));
  }

  /** Append one element without moving any cursor. */
  publish(value) {
    return this._apply(this._core.publish(value));
  }

  /** Unread suffix for a connected subscriber. */
  readStream(id, cx) {
    return readComputed(this._ctx, this._reader(id), cx);
  }

  /** Element at a subscriber cursor, or null at the tail/offline. */
  read(id, cx) {
    return this.readStream(id, cx)[0] ?? null;
  }

  /** Advance only the named connected cursor by one. */
  advance(id) {
    return this._apply(this._core.advance(id));
  }

  /** Process restart is observational: persisted durable state is unchanged. */
  restart(id) {
    return this._apply(this._core.restart(id));
  }

  /** Remove only the prefix below the minimum durable absolute cursor. */
  gc() {
    return this._apply(this._core.gc());
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
}

// ---------------------------------------------------------------------------
// WorkQueueCell — competing consumers with exclusive leases (#lzworkqueue)
// ---------------------------------------------------------------------------

/**
 * Pull-based competing-consumer work queue.
 *
 * This is the portable local-authority lifecycle. The owning instance
 * serializes `claim`; a distributed/HA host puts that decision behind its
 * leader or consensus log while preserving the same operation outcomes.
 */
export class WorkQueueCell {
  /**
   * @param {import("./reactive.js").Context} ctx
   * @param {{visibility_timeout: number, max_deliveries: number}} config
   */
  constructor(ctx, config) {
    requireContext(ctx);
    this._ctx = ctx;
    this._core = new WorkQueueCore(config);
    this._readers = {
      pending_len: ctx.computed(() => this._core.pendingLen()),
      is_empty: ctx.computed(() => this._core.isEmpty()),
      in_flight_len: ctx.computed(() => this._core.inFlightLen()),
      dead_letter_len: ctx.computed(() => this._core.deadLetterLen()),
    };
  }

  /** The graph-agnostic core. */
  get core() {
    return this._core;
  }

  _apply(result) {
    clearChanged(this._ctx, this._readers, result.invalidates);
    return result;
  }

  /** Append a pending item and return its stable item id. */
  push(value) {
    return this._apply(this._core.push(value));
  }

  /** Claim the oldest pending item for one worker. */
  claim(worker, now) {
    return this._apply(this._core.claim(worker, now));
  }

  /** Ack only the exact current delivery owned by `worker`. */
  ack(worker, deliveryId) {
    return this._apply(this._core.ack(worker, deliveryId));
  }

  /** Nack a delivery, requeueing at the tail or dead-lettering at the limit. */
  nack(worker, deliveryId) {
    return this._apply(this._core.nack(worker, deliveryId));
  }

  /** Expire every lease with `deadline < now`, in delivery-id order. */
  reapExpired(now) {
    return this._apply(this._core.reapExpired(now));
  }

  pendingLen(cx) {
    return readComputed(this._ctx, this._readers.pending_len, cx);
  }

  isEmpty(cx) {
    return readComputed(this._ctx, this._readers.is_empty, cx);
  }

  inFlightLen(cx) {
    return readComputed(this._ctx, this._readers.in_flight_len, cx);
  }

  deadLetterLen(cx) {
    return readComputed(this._ctx, this._readers.dead_letter_len, cx);
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
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function requireContext(ctx) {
  if (
    !ctx ||
    typeof ctx.computed !== "function" ||
    typeof ctx.get !== "function" ||
    typeof ctx.clearComputeds !== "function"
  ) {
    throw new TypeError("queue-family construction requires a lazily Context");
  }
}

function readComputed(ctx, reader, cx) {
  return cx === undefined ? ctx.get(reader) : cx.get(reader);
}

function clearChanged(ctx, readers, invalidates) {
  const changed = [];
  for (const [kind, didChange] of Object.entries(invalidates)) {
    if (didChange) changed.push(readers[kind]);
  }
  ctx.clearComputeds(changed);
}
