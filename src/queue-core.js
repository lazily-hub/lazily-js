// Queue-family cores — the graph-agnostic transition algebra shared by all
// three flavors (`#lzqueuefamilyflavors`).
//
// Same split `ingress-core.js` makes for the ingress family, and for the same
// reason: invalidation is a graph WRITE, so the core performs none. Every
// mutator returns which reader kinds the transition dirtied, and each shell
// clears exactly that set on its own graph. Three shells, one algebra — that is
// what makes "the three flavors obey ONE contract" a structural fact rather
// than a claim three copies of the code have to keep agreeing on.
//
// Nothing in this file touches a Context, a mutex, or a promise. Mirrors
// `lazily-rs/src/topic_core.rs` and `lazily-rs/src/work_queue_core.rs`
// (lazily-rs keeps the queue transition predicates in its shells; JS hoists them
// here so the three JS shells cannot drift).

// ---------------------------------------------------------------------------
// Error sentinels — observable rejection labels (distinct observable signals).
// `Full` and `Closed` are the two push-rejection reasons; `Empty` and `Closed`
// are the two pop-rejection reasons. These match the cross-language conformance
// fixture `returns` labels (`lazily-spec/conformance/collections/queuecell_*`).
// ---------------------------------------------------------------------------

export const QueuePushError = Object.freeze({
  /** Bounded backend at capacity (reject policy on the default backend). */
  Full: "Full",
  /** Queue is closed; push is rejected regardless of capacity. Terminal. */
  Closed: "Closed",
});

export const QueuePopError = Object.freeze({
  /** Queue is open but contains no elements. */
  Empty: "Empty",
  /** Queue is closed and empty (drained). Distinct from `Empty`. */
  Closed: "Closed",
});

/** The five `QueueCell` reader kinds, in matrix order. */
export const QUEUE_READER_KINDS = Object.freeze([
  "head",
  "len",
  "is_empty",
  "is_full",
  "closed",
]);

/** The four `WorkQueueCell` reader kinds, in matrix order. */
export const WORK_QUEUE_READER_KINDS = Object.freeze([
  "pending_len",
  "is_empty",
  "in_flight_len",
  "dead_letter_len",
]);

/** @returns {{head: boolean, len: boolean, is_empty: boolean, is_full: boolean, closed: boolean}} */
export function emptyQueueInvalidates() {
  return { head: false, len: false, is_empty: false, is_full: false, closed: false };
}

/** @returns {{pending_len: boolean, is_empty: boolean, in_flight_len: boolean, dead_letter_len: boolean}} */
export function emptyWorkQueueInvalidates() {
  return {
    pending_len: false,
    is_empty: false,
    in_flight_len: false,
    dead_letter_len: false,
  };
}

// ---------------------------------------------------------------------------
// QueueStorage contract (duck-typed).
// ---------------------------------------------------------------------------
//
// The shell / storage split keeps the reactive shell storage-agnostic. The
// default backend is `VecDequeStorage` (unbounded or bounded array-backed
// FIFO).
//
// Minimal required contract: a backend MUST implement `tryPush` / `tryPop` /
// `len` / `isClosed` / `close`. `peek` and `capacity` are OPTIONAL capabilities
// (default: absent) — a raw channel that satisfies only the five required
// methods is fully conforming; it simply has no `head` reader (no `peek`) and no
// `isFull` reader (unbounded, `capacity() -> null`). A conforming backend MUST
// also:
//
// 1. FIFO order — `tryPop()` returns elements in `tryPush()` order.
// 2. Cardinality compatibility — native producer/consumer shape is a superset
//    of SPSC; MPSC usage requires a multi-writer backend.
// 3. Bounded contract (optional) — a bounded backend's `capacity()` returns a
//    number and `tryPush()` returns `QueuePushError.Full` at capacity.
// 4. Position identity — invalidation is phrased over reader kind, not storage
//    indices; the shell layers its own logical reader-kind derivations above
//    storage.

/**
 * The reference `QueueStorage` backend: an array-backed FIFO, optionally
 * bounded. Serializes as a JSON array (element order = FIFO order) per
 * `lazily-spec/cell-model.md` § "Wire and snapshot shape".
 */
export class VecDequeStorage {
  /**
   * @param {{ elements?: unknown[], capacity?: number | null, closed?: boolean }} [initial]
   */
  constructor(initial = {}) {
    this.elements = Array.isArray(initial.elements) ? [...initial.elements] : [];
    this._capacity =
      initial.capacity === undefined || initial.capacity === null ? null : initial.capacity;
    this._closed = Boolean(initial.closed);
    if (this._capacity !== null && this._capacity <= 0) {
      throw new RangeError("VecDequeStorage capacity must be > 0");
    }
    Object.seal(this);
  }

  static from(initial) {
    return new VecDequeStorage(initial);
  }

  /**
   * Append `value` to the tail.
   * @returns {null | "Full" | "Closed"} `null` on success, else the error label.
   */
  tryPush(value) {
    if (this._closed) {
      return QueuePushError.Closed;
    }
    if (this._capacity !== null && this.elements.length >= this._capacity) {
      return QueuePushError.Full;
    }
    this.elements.push(value);
    return null;
  }

  /**
   * Remove and return the head element.
   * @returns {unknown | "Empty" | "Closed"} the element, or the error label.
   */
  tryPop() {
    if (this.elements.length === 0) {
      return this._closed ? QueuePopError.Closed : QueuePopError.Empty;
    }
    return this.elements.shift();
  }

  /** @returns {unknown} the head element, or `null` when empty. */
  peek() {
    return this.elements.length === 0 ? null : this.elements[0];
  }

  /** @returns {number} */
  len() {
    return this.elements.length;
  }

  /** @returns {number | null} the bounded capacity, or `null` if unbounded. */
  capacity() {
    return this._capacity;
  }

  /** @returns {boolean} */
  isClosed() {
    return this._closed;
  }

  /** Close the queue. Idempotent and terminal. */
  close() {
    this._closed = true;
  }

  /** @returns {{ elements: unknown[], capacity: number | null, closed: boolean }} */
  snapshot() {
    return {
      elements: [...this.elements],
      capacity: this._capacity,
      closed: this._closed,
    };
  }
}

// ---------------------------------------------------------------------------
// QueueCore — FIFO transition algebra over a pluggable QueueStorage.
// ---------------------------------------------------------------------------

/**
 * The graph-agnostic `QueueCell` algebra: a `QueueStorage` backend plus the
 * reader-kind transition predicates. Every mutator returns
 * `{returns, invalidates}`; the caller owns the graph write.
 *
 * The reader-kind independence law — a push to a non-empty queue does NOT
 * invalidate the `head` reader, a pop does — lives here, so all three flavors
 * inherit it instead of restating it.
 */
export class QueueCore {
  /**
   * @param {object} [storage] duck-typed `QueueStorage`; defaults to
   *   `VecDequeStorage` built from `initial`.
   * @param {{ elements?: unknown[], capacity?: number | null, closed?: boolean }} [initial]
   */
  constructor(storage, initial = {}) {
    this.storage = storage ?? new VecDequeStorage(initial);
    this._prev = this._observe();
  }

  _observe() {
    const len = this.storage.len();
    const cap = this.storage.capacity?.() ?? null;
    return {
      len,
      is_empty: len === 0,
      is_full: cap !== null && len >= cap,
      closed: this.storage.isClosed(),
    };
  }

  /**
   * Diff the derivable reader-kinds (len / is_empty / is_full / closed) against
   * the previous observation. `head` is NOT derived here — it depends on op
   * *direction*, not just `len`, and deriving it would require `peek()`, which
   * is an optional storage capability (`relaycell-backpressure-analysis.md`
   * §4.1). The caller passes `headChanged` from the transition predicate: a pop
   * always changes head; a push changes it only from empty. This keeps the
   * minimal storage contract (`tryPush`/`tryPop`/`len`/`isClosed`/`close`) free
   * of `peek`.
   * @param {boolean} headChanged
   */
  _diff(headChanged) {
    const prev = this._prev;
    const next = this._observe();
    const invalidates = {
      head: headChanged,
      len: prev.len !== next.len,
      is_empty: prev.is_empty !== next.is_empty,
      is_full: prev.is_full !== next.is_full,
      closed: prev.closed !== next.closed,
    };
    this._prev = next;
    return invalidates;
  }

  /** Append `value` to the tail. Rejection leaves state and matrix untouched. */
  tryPush(value) {
    const lenBefore = this.storage.len();
    const err = this.storage.tryPush(value);
    if (err !== null) {
      return { returns: err, invalidates: emptyQueueInvalidates() };
    }
    // Head changes on a push only when the queue was empty (the new element
    // becomes the head); a push to a non-empty queue leaves head untouched —
    // the reader-kind independence law.
    return { returns: null, invalidates: this._diff(lenBefore === 0) };
  }

  /**
   * Remove and return the head element. Pop on a closed *non-empty* queue
   * drains; only closed+empty yields `Closed`.
   */
  tryPop() {
    const value = this.storage.tryPop();
    if (value === QueuePopError.Empty || value === QueuePopError.Closed) {
      return { returns: value, invalidates: emptyQueueInvalidates() };
    }
    // A successful pop always advances the head (to the next element or empty).
    return { returns: value, invalidates: this._diff(true) };
  }

  /** Close the queue. Idempotent and terminal; touches only `closed`. */
  close() {
    if (this.storage.isClosed()) {
      return { returns: null, invalidates: emptyQueueInvalidates() };
    }
    this.storage.close();
    return { returns: null, invalidates: this._diff(false) };
  }

  // -- projections (no graph, no dependency registration) -------------------

  peek() {
    return this.storage.peek?.() ?? null;
  }

  len() {
    return this.storage.len();
  }

  isEmpty() {
    return this.storage.len() === 0;
  }

  isFull() {
    const cap = this.storage.capacity?.() ?? null;
    return cap !== null && this.storage.len() >= cap;
  }

  isClosed() {
    return this.storage.isClosed();
  }

  capacity() {
    return this.storage.capacity?.() ?? null;
  }

  elements() {
    if (typeof this.storage.elements === "function") {
      return this.storage.elements();
    }
    if (Array.isArray(this.storage.elements)) {
      return [...this.storage.elements];
    }
    return this.storage.snapshot().elements;
  }
}

// ---------------------------------------------------------------------------
// TopicCore — broadcast log with independent subscriber cursors.
// ---------------------------------------------------------------------------

export const TopicDurability = Object.freeze({
  Durable: "durable",
  Ephemeral: "ephemeral",
});

export const TopicSubscribeOutcome = Object.freeze({
  Created: "Created",
  Reconnected: "Reconnected",
  AlreadyConnected: "AlreadyConnected",
});

/**
 * The graph-agnostic `TopicCell` algebra. `invalidates` is keyed by subscriber
 * id rather than by a fixed reader-kind list, because a topic's reader set IS
 * its subscriber set.
 */
export class TopicCore {
  /**
   * @param {{
   *   base_offset?: number,
   *   elements?: unknown[],
   *   subscriptions?: Record<string, {cursor: number, durability: "durable" | "ephemeral", connected: boolean}>
   * }} [initial]
   */
  constructor(initial = {}) {
    this._baseOffset = initial.base_offset ?? 0;
    this._elements = Array.from(initial.elements ?? []);
    this._subscriptions = new Map();
    if (!Number.isSafeInteger(this._baseOffset) || this._baseOffset < 0) {
      throw new RangeError("TopicCell base_offset must be a non-negative safe integer");
    }
    const end = this.endOffset();
    for (const [id, raw] of Object.entries(initial.subscriptions ?? {})) {
      if (!Number.isSafeInteger(raw.cursor) || raw.cursor < this._baseOffset || raw.cursor > end) {
        throw new RangeError(`TopicCell cursor for ${id} is outside the retained offset range`);
      }
      if (
        raw.durability !== TopicDurability.Durable &&
        raw.durability !== TopicDurability.Ephemeral
      ) {
        throw new TypeError(`invalid TopicCell durability for ${id}`);
      }
      if (typeof raw.connected !== "boolean") {
        throw new TypeError(`TopicCell connected flag for ${id} must be boolean`);
      }
      if (raw.durability === TopicDurability.Ephemeral && !raw.connected) {
        throw new TypeError(`disconnected ephemeral TopicCell subscription ${id} must be removed`);
      }
      this._subscriptions.set(id, {
        cursor: raw.cursor,
        durability: raw.durability,
        connected: raw.connected,
      });
    }
  }

  _allFalse() {
    return Object.fromEntries(Array.from(this._subscriptions.keys(), (id) => [id, false]));
  }

  _only(id, changed) {
    const invalidates = this._allFalse();
    invalidates[id] = changed;
    return invalidates;
  }

  /** Create at tail, or reconnect an existing durable identity in place. */
  subscribe(id, durability) {
    const existing = this._subscriptions.get(id);
    if (existing) {
      if (existing.connected) {
        return {
          returns: TopicSubscribeOutcome.AlreadyConnected,
          invalidates: this._allFalse(),
        };
      }
      existing.connected = true;
      return {
        returns: TopicSubscribeOutcome.Reconnected,
        invalidates: this._only(id, true),
      };
    }
    if (durability !== TopicDurability.Durable && durability !== TopicDurability.Ephemeral) {
      throw new TypeError(`invalid TopicCell durability for ${id}`);
    }
    this._subscriptions.set(id, {
      cursor: this.endOffset(),
      durability,
      connected: true,
    });
    return { returns: TopicSubscribeOutcome.Created, invalidates: this._only(id, true) };
  }

  /** Reconnect a durable identity; unknown ids are created at the current tail. */
  reconnect(id) {
    return this.subscribe(id, TopicDurability.Durable);
  }

  /** Durable ids remain offline; ephemeral ids are removed. */
  disconnect(id) {
    const sub = this._subscriptions.get(id);
    if (!sub || !sub.connected) {
      return { returns: null, invalidates: this._allFalse() };
    }
    // Computed while the id is still present, so a removed ephemeral subscriber
    // still reports its own final transition.
    const invalidates = this._only(id, true);
    if (sub.durability === TopicDurability.Ephemeral) {
      this._subscriptions.delete(id);
    } else {
      sub.connected = false;
    }
    return { returns: null, invalidates };
  }

  /** Append one element without moving any cursor. */
  publish(value) {
    const offset = this.endOffset();
    this._elements.push(value);
    const invalidates = Object.fromEntries(
      Array.from(this._subscriptions, ([id, sub]) => [id, sub.connected && sub.cursor <= offset]),
    );
    return { returns: null, offset, invalidates };
  }

  /** Advance only the named connected cursor by one. */
  advance(id) {
    const sub = this._subscriptions.get(id);
    if (!sub || !sub.connected || sub.cursor >= this.endOffset()) {
      return { returns: null, invalidates: this._allFalse() };
    }
    const value = this._elements[sub.cursor - this._baseOffset];
    sub.cursor += 1;
    return { returns: value, invalidates: this._only(id, true) };
  }

  /** Process restart is observational: persisted durable state is unchanged. */
  restart(_id) {
    return { returns: null, invalidates: this._allFalse() };
  }

  /** Remove only the prefix below the minimum durable absolute cursor. */
  gc() {
    const durable = Array.from(this._subscriptions.values())
      .filter((sub) => sub.durability === TopicDurability.Durable)
      .map((sub) => sub.cursor);
    const frontier = durable.length === 0 ? this.endOffset() : Math.min(...durable);
    const removed = frontier - this._baseOffset;
    this._elements.splice(0, removed);
    this._baseOffset = frontier;
    return { returns: removed, invalidates: this._allFalse() };
  }

  // -- projections ----------------------------------------------------------

  /** The unread suffix for a connected subscriber (empty when offline). */
  readStream(id) {
    const sub = this._subscriptions.get(id);
    if (!sub || !sub.connected) return [];
    return this._elements.slice(Math.max(0, sub.cursor - this._baseOffset));
  }

  baseOffset() {
    return this._baseOffset;
  }

  endOffset() {
    return this._baseOffset + this._elements.length;
  }

  elements() {
    return Array.from(this._elements);
  }

  subscriptionIds() {
    return Array.from(this._subscriptions.keys());
  }

  subscription(id) {
    const sub = this._subscriptions.get(id);
    return sub ? { ...sub } : null;
  }

  subscriptions() {
    return Object.fromEntries(Array.from(this._subscriptions, ([id, sub]) => [id, { ...sub }]));
  }

  snapshot() {
    return {
      base_offset: this._baseOffset,
      elements: this.elements(),
      subscriptions: this.subscriptions(),
    };
  }
}

// ---------------------------------------------------------------------------
// WorkQueueCore — competing consumers with exclusive leases.
// ---------------------------------------------------------------------------

export const WorkQueueDeadLetterReason = Object.freeze({
  Nack: "nack",
  Expired: "expired",
});

/**
 * The graph-agnostic `WorkQueueCell` algebra: pending FIFO, in-flight leases
 * keyed by delivery id, and a dead-letter tail.
 *
 * This is the portable local-authority lifecycle. The owning instance
 * serializes `claim`; a distributed/HA host puts that decision behind its
 * leader or consensus log while preserving the same operation outcomes.
 */
export class WorkQueueCore {
  /** @param {{visibility_timeout: number, max_deliveries: number}} config */
  constructor(config) {
    if (
      !config ||
      !Number.isSafeInteger(config.visibility_timeout) ||
      config.visibility_timeout <= 0
    ) {
      throw new RangeError("visibility_timeout must be a positive safe integer");
    }
    if (!Number.isSafeInteger(config.max_deliveries) || config.max_deliveries < 1) {
      throw new RangeError("max_deliveries must be at least one");
    }
    this._visibilityTimeout = config.visibility_timeout;
    this._maxDeliveries = config.max_deliveries;
    this._pending = [];
    this._inFlight = new Map();
    this._deadLetters = [];
    this._nextItemId = 0;
    this._nextDeliveryId = 0;
  }

  _counts() {
    return {
      pending: this._pending.length,
      in_flight: this._inFlight.size,
      dead_letters: this._deadLetters.length,
    };
  }

  _invalidatesFrom(before) {
    const after = this._counts();
    return {
      pending_len: before.pending !== after.pending,
      is_empty: (before.pending === 0) !== (after.pending === 0),
      in_flight_len: before.in_flight !== after.in_flight,
      dead_letter_len: before.dead_letters !== after.dead_letters,
    };
  }

  _validateNow(now) {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RangeError("now must be a non-negative safe integer");
    }
  }

  _failDelivery(delivery, reason) {
    if (delivery.attempt < this._maxDeliveries) {
      this._pending.push({
        item_id: delivery.item_id,
        value: delivery.value,
        attempts: delivery.attempt,
      });
    } else {
      this._deadLetters.push({
        item_id: delivery.item_id,
        value: delivery.value,
        attempts: delivery.attempt,
        reason,
      });
    }
  }

  /** Append a pending item and return its stable item id. */
  push(value) {
    const before = this._counts();
    if (this._nextItemId >= Number.MAX_SAFE_INTEGER) throw new RangeError("item id exhausted");
    const itemId = this._nextItemId;
    this._nextItemId += 1;
    this._pending.push({ item_id: itemId, value, attempts: 0 });
    return { returns: itemId, invalidates: this._invalidatesFrom(before) };
  }

  /** Claim the oldest pending item for one worker. */
  claim(worker, now) {
    this._validateNow(now);
    if (this._pending.length === 0) {
      return { returns: null, invalidates: emptyWorkQueueInvalidates() };
    }
    if (this._nextDeliveryId >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("delivery id exhausted");
    }
    const before = this._counts();
    const item = this._pending.shift();
    const deliveryId = this._nextDeliveryId;
    this._nextDeliveryId += 1;
    const delivery = {
      delivery_id: deliveryId,
      item_id: item.item_id,
      value: item.value,
      worker,
      attempt: item.attempts + 1,
      deadline: Math.min(Number.MAX_SAFE_INTEGER, now + this._visibilityTimeout),
    };
    this._inFlight.set(deliveryId, delivery);
    return { returns: { ...delivery }, invalidates: this._invalidatesFrom(before) };
  }

  /** Ack only the exact current delivery owned by `worker`. */
  ack(worker, deliveryId) {
    const delivery = this._inFlight.get(deliveryId);
    if (!delivery || delivery.worker !== worker) {
      return { returns: false, invalidates: emptyWorkQueueInvalidates() };
    }
    const before = this._counts();
    this._inFlight.delete(deliveryId);
    return { returns: true, invalidates: this._invalidatesFrom(before) };
  }

  /** Nack a delivery, requeueing at the tail or dead-lettering at the limit. */
  nack(worker, deliveryId) {
    const delivery = this._inFlight.get(deliveryId);
    if (!delivery || delivery.worker !== worker) {
      return { returns: false, invalidates: emptyWorkQueueInvalidates() };
    }
    const before = this._counts();
    this._inFlight.delete(deliveryId);
    this._failDelivery(delivery, WorkQueueDeadLetterReason.Nack);
    return { returns: true, invalidates: this._invalidatesFrom(before) };
  }

  /** Expire every lease with `deadline < now`, in delivery-id order. */
  reapExpired(now) {
    this._validateNow(now);
    const expired = Array.from(this._inFlight.values())
      .filter((delivery) => delivery.deadline < now)
      .sort((a, b) => a.delivery_id - b.delivery_id);
    if (expired.length === 0) {
      return { returns: 0, invalidates: emptyWorkQueueInvalidates() };
    }
    const before = this._counts();
    for (const delivery of expired) {
      this._inFlight.delete(delivery.delivery_id);
      this._failDelivery(delivery, WorkQueueDeadLetterReason.Expired);
    }
    return { returns: expired.length, invalidates: this._invalidatesFrom(before) };
  }

  // -- projections ----------------------------------------------------------

  pendingLen() {
    return this._pending.length;
  }

  isEmpty() {
    return this._pending.length === 0;
  }

  inFlightLen() {
    return this._inFlight.size;
  }

  deadLetterLen() {
    return this._deadLetters.length;
  }

  pendingItems() {
    return this._pending.map((item) => ({ ...item }));
  }

  inFlightDeliveries() {
    return Array.from(this._inFlight.values(), (delivery) => ({ ...delivery })).sort(
      (a, b) => a.delivery_id - b.delivery_id,
    );
  }

  deadLetterItems() {
    return this._deadLetters.map((item) => ({ ...item }));
  }
}
