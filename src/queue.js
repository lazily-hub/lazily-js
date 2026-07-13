// Reactive queue: QueueCell + pluggable QueueStorage backend (#lzqueue).
//
// Pure logic — no reactive graph. Like the keyed collections
// (`./collections.js`), this is compute that every binding MUST implement; the
// conformance/collections/queuecell_*.json fixtures pin behavior. To make a
// queue live-reactive, wrap its ops in a `Context` (cells/slots/effects) and
// use the returned `invalidates` matrix to drive reader-kind invalidation —
// see `lazily-spec/cell-model.md` § "Reactive queues" and the distributed-queue
// PRD for the shell / storage split.
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
// `isFull` reader (unbounded, `capacity() → null`). A conforming backend MUST
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

// ---------------------------------------------------------------------------
// VecDequeStorage — the reference unbounded/bounded backend.
// ---------------------------------------------------------------------------

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
    this.#capacity =
      initial.capacity === undefined || initial.capacity === null
        ? null
        : initial.capacity;
    this.#closed = Boolean(initial.closed);
    if (this.#capacity !== null && this.#capacity <= 0) {
      throw new RangeError("VecDequeStorage capacity must be > 0");
    }
    Object.freeze(this);
  }

  #capacity;
  #closed;

  static from(initial) {
    return new VecDequeStorage(initial);
  }

  /**
   * Append `value` to the tail.
   * @returns {null | "Full" | "Closed"} `null` on success, else the error label.
   */
  tryPush(value) {
    if (this.#closed) {
      return QueuePushError.Closed;
    }
    if (this.#capacity !== null && this.elements.length >= this.#capacity) {
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
      return this.#closed ? QueuePopError.Closed : QueuePopError.Empty;
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
    return this.#capacity;
  }

  /** @returns {boolean} */
  isClosed() {
    return this.#closed;
  }

  /** Close the queue. Idempotent and terminal. */
  close() {
    this.#closed = true;
  }

  /** @returns {{ elements: unknown[], capacity: number | null, closed: boolean }} */
  snapshot() {
    return {
      elements: [...this.elements],
      capacity: this.#capacity,
      closed: this.#closed,
    };
  }
}

// ---------------------------------------------------------------------------
// QueueCell — the reactive shell (pure logic).
// ---------------------------------------------------------------------------

/**
 * A reactive FIFO queue — SPSC primitive with an MPSC usage rule (`#lzqueue`).
 *
 * Pure logic: wraps a pluggable `QueueStorage` backend and, after each op,
 * reports which reader kinds (`head` / `len` / `is_empty` / `is_full` /
 * `closed`) changed via the returned `invalidates` matrix. Wire the matrix to a
 * reactive `Context` to make the queue live-reactive. The reader-kind
 * independence law — a push to a non-empty queue does NOT invalidate the `head`
 * reader, a pop does — falls out of the transition predicates this shell
 * computes (derivable kinds by value-diff; `head` by op direction, so no `peek`
 * is required). `peek`/`capacity` are optional storage capabilities.
 */
export class QueueCell {
  /**
   * @param {{ elements?: unknown[], capacity?: number | null, closed?: boolean }} [initial]
   *   Passed to the default `VecDequeStorage` when no `storage` is given.
   * @param {object} [storage] A duck-typed `QueueStorage` backend. Defaults to
   *   a `VecDequeStorage` built from `initial`.
   */
  constructor(initial = {}, storage) {
    this.#storage = storage ?? new VecDequeStorage(initial);
    this.#prev = this.#snapshot();
    Object.freeze(this);
  }

  #storage;
  #prev;

  static from(initial, storage) {
    return new QueueCell(initial, storage);
  }

  // -- internal: reader-kind state + invalidation diff ----------------------

  #snapshot() {
    const len = this.#storage.len();
    const cap = this.#storage.capacity?.() ?? null;
    return {
      len,
      is_empty: len === 0,
      is_full: cap !== null && len >= cap,
      closed: this.#storage.isClosed(),
    };
  }

  /**
   * Diff the derivable reader-kinds (len / is_empty / is_full / closed) against
   * the previous snapshot. `head` is NOT derived here — it depends on op
   * *direction*, not just `len`, and deriving it would require `peek()`, which is
   * now an optional storage capability (`relaycell-backpressure-analysis.md`
   * §4.1). The caller passes `headChanged` from the transition predicate: a pop
   * always changes head; a push changes it only from empty. This keeps the
   * minimal storage contract (`tryPush`/`tryPop`/`len`/`isClosed`/`close`) free
   * of `peek`.
   * @param {boolean} headChanged
   */
  #diff(next, headChanged) {
    const prev = this.#prev;
    const invalidates = {
      head: headChanged,
      len: prev.len !== next.len,
      is_empty: prev.is_empty !== next.is_empty,
      is_full: prev.is_full !== next.is_full,
      closed: prev.closed !== next.closed,
    };
    this.#prev = next;
    return invalidates;
  }

  // -- mutating ops ---------------------------------------------------------

  /**
   * Append `value` to the tail.
   * @returns {{ returns: null | "Full" | "Closed", invalidates: QueueInvalidates }}
   *   On rejection (`Full` / `Closed`) the queue state is unchanged and the
   *   `invalidates` matrix is all-false.
   */
  tryPush(value) {
    const lenBefore = this.#storage.len();
    const err = this.#storage.tryPush(value);
    if (err !== null) {
      return { returns: err, invalidates: emptyInvalidates() };
    }
    // Head changes on a push only when the queue was empty (the new element
    // becomes the head); a push to a non-empty queue leaves head untouched —
    // the reader-kind independence law.
    const headChanged = lenBefore === 0;
    return { returns: null, invalidates: this.#diff(this.#snapshot(), headChanged) };
  }

  /**
   * Remove and return the head element. Pop on a closed *non-empty* queue
   * drains (returns the next element); only closed+empty yields `Closed`.
   * @returns {{ returns: unknown | "Empty" | "Closed", invalidates: QueueInvalidates }}
   */
  tryPop() {
    const value = this.#storage.tryPop();
    if (value === QueuePopError.Empty || value === QueuePopError.Closed) {
      return { returns: value, invalidates: emptyInvalidates() };
    }
    // A successful pop always advances the head (to the next element or empty).
    return { returns: value, invalidates: this.#diff(this.#snapshot(), true) };
  }

  /**
   * Close the queue. Idempotent (no-op on an already-closed queue) and
   * terminal. After close, `tryPush` returns `Closed`; `tryPop` drains and
   * returns `Closed` only once empty.
   * @returns {{ returns: null, invalidates: QueueInvalidates }}
   *   The `closed` reader is invalidated only on the open → closed transition.
   */
  close() {
    if (this.#storage.isClosed()) {
      return { returns: null, invalidates: emptyInvalidates() };
    }
    this.#storage.close();
    // Close touches only `closed`; head is unchanged.
    return { returns: null, invalidates: this.#diff(this.#snapshot(), false) };
  }

  // -- reader-kind reads (current state, non-mutating) ----------------------

  /**
   * Current head value, or `null` when empty. `peek` is an optional storage
   * capability: a backend without it (a raw channel) has no `head` reader, so
   * this returns `null` — exactly as an unbounded backend's `isFull` is always
   * `false`.
   */
  head() {
    return this.#storage.peek?.() ?? null;
  }

  /** Number of buffered elements. */
  len() {
    return this.#storage.len();
  }

  /** Whether the queue is empty. */
  isEmpty() {
    return this.#storage.len() === 0;
  }

  /**
   * Whether the queue is at capacity (the backpressure signal). Always `false`
   * for an unbounded backend.
   */
  isFull() {
    const cap = this.#storage.capacity?.() ?? null;
    return cap !== null && this.#storage.len() >= cap;
  }

  /** Whether the queue has been closed. */
  isClosed() {
    return this.#storage.isClosed();
  }

  /** The backend's capacity, or `null` if unbounded. */
  capacity() {
    return this.#storage.capacity?.() ?? null;
  }

  /**
   * Snapshot the buffered elements in FIFO order. There is no reactive
   * random-access `queue[N]` reader; per-position reactivity is the domain of
   * `CellMap`, not `QueueCell`.
   * @returns {unknown[]}
   */
  elements() {
    if (typeof this.#storage.elements === "function") {
      return this.#storage.elements();
    }
    return this.#storage.snapshot().elements;
  }
}

// ---------------------------------------------------------------------------
// Future primitives (stubs) — documented, not in v1 conformance.
// ---------------------------------------------------------------------------
//
// TopicCell (SPMC broadcast / MPMC pub-sub) and WorkQueueCell (true MPMC with
// exclusive handoff) are genuinely distinct primitives — they differ in
// *invalidation model and handoff semantics*, not producer/consumer
// cardinality (see `lazily-spec/cell-model.md` § "Future queue primitives").
//
// - TopicCell — every subscriber receives every pushed element; each subscriber
//   keeps its own cursor; GC bounded by the slowest cursor. Lands with the
//   distributed-queue PRD Phase 3. Formal stub: lazily-formal/TopicCell.lean.
//
// - WorkQueueCell — N consumers compete for elements; each element delivered to
//   exactly one consumer (exclusive handoff). Requires an authority (leader) to
//   serialize pop-assignment; pure CRDT cannot provide it. Lands with the
//   distributed-queue PRD Phase 2 (consensus core). Formal stub:
//   lazily-formal/WorkQueueCell.lean.

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** @returns {QueueInvalidates} */
function emptyInvalidates() {
  return { head: false, len: false, is_empty: false, is_full: false, closed: false };
}
