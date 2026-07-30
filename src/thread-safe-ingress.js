// ThreadSafeIngressCell — the `Send + Sync` flavor of the transport-agnostic
// reactive ingress family (`#designimplementtransport`).
//
// Same admission algebra as `IngressCell` (`./ingress-core.js`); what this shell
// owns is the locking discipline, and it is the reason the flavor exists as its
// own type rather than a flag:
//
//  * The core is guarded by its OWN mutex, not the context's. A reader's compute
//    body runs while the context lock is held (every `ThreadSafeContext`
//    operation is a critical section) and then takes the core lock. So a mutator
//    that invalidated while still holding the core lock would acquire the two in
//    the opposite order and deadlock. Every op below therefore takes the core
//    lock, computes the invalidation set, RELEASES it, and only then writes the
//    graph.
//  * Invalidation fans out through ONE `clearComputeds` call, which
//    `ThreadSafeContext` runs as a single critical section. One admission is one
//    frontier walk, so no other realm observes "new value, old authority" — the
//    partial fan-out a generation handoff must never expose.
//
// Mirrors `lazily-rs/src/thread_safe_ingress.rs`.

import {
  IngressCore,
  IngressReceiptChannel,
  IngressTransportKind,
  defaultIngressPolicy,
  ingressChangeIsEmpty,
  ingressSchedule,
} from "./ingress-core.js";
import { KeepLatest } from "./merge.js";
import { AtomicMutex } from "./thread-safe.js";

export {
  InProcIngress,
  IngressAdmissionKind,
  IngressConfigError,
  IngressCore,
  IngressDropReason,
  IngressError,
  IngressLifecycle,
  IngressReadiness,
  IngressReceiptChannel,
  IngressTransportKind,
  ScopeView,
  defaultIngressPolicy,
  ingressEnvelope,
  ingressSchedule,
  isDelivered,
  receiptChannel,
} from "./ingress-core.js";

function requireThreadSafeContext(ctx) {
  if (
    !ctx ||
    typeof ctx.computed !== "function" ||
    typeof ctx.get !== "function" ||
    typeof ctx.source !== "function" ||
    typeof ctx.clearComputeds !== "function"
  ) {
    throw new TypeError("ThreadSafeIngressCell requires a lazily ThreadSafeContext");
  }
}

/**
 * The `Send + Sync` keyed reactive ingress: one admission plane per key, with
 * readiness, authority, and retry as derives rather than calls, and every core
 * transition serialized by a mutex the graph never holds.
 */
export class ThreadSafeIngressCell {
  /**
   * @param {import("./thread-safe.js").ThreadSafeContext} ctx
   * @param {{
   *   policy?: object,
   *   merge?: {merge: (old: unknown, op: unknown) => unknown, conflates: boolean},
   *   transport?: string,
   *   pollInterval?: number,
   *   mutex?: AtomicMutex,
   * }} [options]
   */
  constructor(ctx, options = {}) {
    requireThreadSafeContext(ctx);
    // Validate before minting any graph node: a rejected policy must leave no
    // reader behind.
    this._core = new IngressCore(
      { ...defaultIngressPolicy(), ...(options.policy ?? {}) },
      options.merge ?? KeepLatest,
    );
    this._ctx = ctx;
    // The core's own lock. Deliberately NOT the context's: see the file header.
    this._mutex = options.mutex ?? new AtomicMutex();
    /** @type {Map<unknown, {value: object, readiness: object, authority: object, retry: object}>} */
    this._scopeReaders = new Map();
    this._accepted = ctx.computed(() => this._locked(() => this._core.receipts(IngressReceiptChannel.Accepted)));
    this._dropped = ctx.computed(() => this._locked(() => this._core.receipts(IngressReceiptChannel.Dropped)));
    this._errors = ctx.computed(() => this._locked(() => this._core.receipts(IngressReceiptChannel.Error)));
    this._transportKind = ctx.source(options.transport ?? IngressTransportKind.EventChannel);
    this._pollInterval = ctx.source(options.pollInterval ?? 1000);
    this._schedule = ctx.computed((cx) =>
      ingressSchedule(cx.get(this._transportKind), cx.get(this._pollInterval)),
    );
  }

  /** The mutex guarding the admission core. */
  get mutex() {
    return this._mutex;
  }

  _locked(body) {
    return this._mutex.runExclusive(body);
  }

  // -- readers --------------------------------------------------------------

  /**
   * Mint (or return) one scope's four readers. Idempotent, so a consumer may
   * hold a handle for a key that has not opened yet.
   */
  _ensureReaders(key) {
    let readers = this._scopeReaders.get(key);
    if (readers === undefined) {
      readers = {
        value: this._ctx.computed(() => this._locked(() => this._core.peek(key))),
        readiness: this._ctx.computed(() => this._locked(() => this._core.readiness(key))),
        authority: this._ctx.computed(() => this._locked(() => this._core.authority(key))),
        retry: this._ctx.computed(() => this._locked(() => this._core.retry(key))),
      };
      this._scopeReaders.set(key, readers);
    }
    return readers;
  }

  /**
   * Apply one core-reported invalidation set, with the CORE LOCK ALREADY
   * RELEASED, in a single frontier walk.
   */
  _apply(change) {
    if (ingressChangeIsEmpty(change)) return change;
    const roots = [];
    for (const [key, scopeChange] of change.scopes) {
      const readers = this._ensureReaders(key);
      if (scopeChange.value) roots.push(readers.value);
      if (scopeChange.readiness) roots.push(readers.readiness);
      if (scopeChange.authority) roots.push(readers.authority);
      if (scopeChange.retry) roots.push(readers.retry);
    }
    if (change.acceptedReceipts) roots.push(this._accepted);
    if (change.droppedReceipts) roots.push(this._dropped);
    if (change.errorReceipts) roots.push(this._errors);
    if (roots.length > 0) this._ctx.clearComputeds(roots);
    return change;
  }

  // -- mutating ops ---------------------------------------------------------

  /** Open (or reopen) a keyed scope at `generation`. */
  open(key, generation) {
    return this._apply(this._locked(() => this._core.open(key, generation)));
  }

  /** Admit one decoded envelope. Returns the admission outcome. */
  admit(envelope) {
    const { change, admission } = this._locked(() => this._core.admit(envelope));
    this._apply(change);
    return admission;
  }

  /** Suspend a scope, retaining its window and watermark. */
  suspend(key) {
    const { change, replay } = this._locked(() => this._core.suspend(key));
    this._apply(change);
    return replay;
  }

  /** Reconnect a scope at `generation`, clearing its error streak. */
  reconnect(key, generation) {
    const { change, replay } = this._locked(() => this._core.reconnect(key, generation));
    this._apply(change);
    return replay;
  }

  /** Close a scope. It admits nothing and claims no authority until reopened. */
  close(key) {
    return this._apply(this._locked(() => this._core.close(key)));
  }

  /** Record a transport/decode failure, deepening the scope's backoff. */
  fail(key, error) {
    return this._apply(this._locked(() => this._core.fail(key, error)));
  }

  /** Advance logical time. Only horizon crossings are invalidated. */
  tick(now) {
    return this._apply(this._locked(() => this._core.tick(now)));
  }

  /** Drain a scope's coalesced window. Returns null for an empty window. */
  drain(key) {
    const { change, drained } = this._locked(() => this._core.drain(key));
    this._apply(change);
    return drained;
  }

  /**
   * Admit everything `transport` has decoded, then ask it to replay any gap
   * still open. Returns the admission outcomes in arrival order.
   */
  pump(transport) {
    const batch = transport.drain();
    const outcomes = [];
    const touched = [];
    for (const envelope of batch) {
      outcomes.push(this.admit(envelope));
      if (!touched.includes(envelope.key)) touched.push(envelope.key);
    }
    for (const key of touched) {
      const view = this.view(key);
      if (view !== null && view.hasGap()) {
        transport.requestReplay(key, {
          generation: view.generation,
          fromSequence: view.resumeFrom(),
        });
      }
    }
    return outcomes;
  }

  // -- reactive reads -------------------------------------------------------

  value(key, cx) {
    return this._read(this._ensureReaders(key).value, cx);
  }

  readiness(key, cx) {
    return this._read(this._ensureReaders(key).readiness, cx);
  }

  authority(key, cx) {
    return this._read(this._ensureReaders(key).authority, cx);
  }

  retry(key, cx) {
    return this._read(this._ensureReaders(key).retry, cx);
  }

  accepted(cx) {
    return this._read(this._accepted, cx);
  }

  dropped(cx) {
    return this._read(this._dropped, cx);
  }

  errors(cx) {
    return this._read(this._errors, cx);
  }

  schedule(cx) {
    return this._read(this._schedule, cx);
  }

  _read(handle, cx) {
    return cx === undefined ? this._ctx.get(handle) : cx.get(handle);
  }

  // -- handles --------------------------------------------------------------

  valueHandle(key) {
    return this._ensureReaders(key).value;
  }

  readinessHandle(key) {
    return this._ensureReaders(key).readiness;
  }

  authorityHandle(key) {
    return this._ensureReaders(key).authority;
  }

  retryHandle(key) {
    return this._ensureReaders(key).retry;
  }

  acceptedHandle() {
    return this._accepted;
  }

  droppedHandle() {
    return this._dropped;
  }

  errorsHandle() {
    return this._errors;
  }

  scheduleHandle() {
    return this._schedule;
  }

  // -- live retuning --------------------------------------------------------

  setTransport(kind) {
    this._ctx.set(this._transportKind, kind);
  }

  setPollInterval(interval) {
    this._ctx.set(this._pollInterval, interval);
  }

  // -- non-reactive projections ---------------------------------------------

  view(key) {
    return this._locked(() => this._core.view(key));
  }

  policy() {
    return this._locked(() => this._core.policy());
  }

  scopeKeys() {
    return this._locked(() => this._core.scopeKeys());
  }
}
