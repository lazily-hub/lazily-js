// IngressCell — the single-threaded flavor of the transport-agnostic reactive
// ingress family (`#designimplementtransport`).
//
// The admission algebra lives in the flavor-neutral `./ingress-core.js`; this
// shell adds only the reactivity — four guarded Computed reader kinds per keyed
// scope, three receipt readers, and a derived schedule, minted on *this*
// context's graph.
//
// Readiness, authority, and retry are derives, not refresh calls. Nothing here
// polls a connection to find out whether it is healthy: readiness, authority,
// and retry are Computeds over scope state, so a consumer that reads readiness
// is a graph dependent of exactly the transitions that can change it — and a
// transition that cannot (a buffered out-of-order envelope, a tick inside the
// freshness horizon, an empty drain) invalidates nothing. The core returns the
// invalidation set for every transition and this shell clears precisely that
// set, in ONE clearComputeds frontier walk, so no reader ever observes "new
// value, old authority" — the partial fan-out a generation handoff must never
// expose.
//
// Four reader kinds per scope rather than one: collapsing them would make an
// error deepen a backoff *and* re-render a value that did not change.
//
// There are no observers here. The reader kinds are dependency-free Computeds
// cleared by the graph's own frontier walk, exactly as the queue family's reader
// kinds are — no listener list, no subscription set, nothing that survives an
// invalidation.

import {
  IngressCore,
  IngressReceiptChannel,
  IngressTransportKind,
  defaultIngressPolicy,
  ingressChangeIsEmpty,
  ingressSchedule,
} from "./ingress-core.js";
import { KeepLatest } from "./merge.js";

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
  emptyIngressChange,
  ingressChangeIsEmpty,
  ingressEnvelope,
  ingressSchedule,
  isDelivered,
  receiptChannel,
} from "./ingress-core.js";

function requireSyncContext(ctx) {
  if (
    !ctx ||
    typeof ctx.computed !== "function" ||
    typeof ctx.get !== "function" ||
    typeof ctx.source !== "function" ||
    typeof ctx.clearComputeds !== "function"
  ) {
    throw new TypeError("IngressCell requires a lazily Context");
  }
}

/**
 * A keyed, lifecycle-scoped reactive ingress: one admission plane per key, with
 * readiness, authority, and retry as derives rather than calls.
 */
export class IngressCell {
  /**
   * @param {import("./reactive.js").Context} ctx
   * @param {{
   *   policy?: object,
   *   merge?: {merge: (old: unknown, op: unknown) => unknown, conflates: boolean},
   *   transport?: string,
   *   pollInterval?: number,
   * }} [options]
   *   `pollInterval` is retained even for an event channel so a later
   *   `setTransport(BoundedPolling)` has a bound to fall back to rather than
   *   inventing one.
   */
  constructor(ctx, options = {}) {
    requireSyncContext(ctx);
    // Build the core FIRST: the Conflate-vs-merge validation must run before any
    // graph node is minted, so a rejected policy leaves no reader behind.
    this._core = new IngressCore(
      { ...defaultIngressPolicy(), ...(options.policy ?? {}) },
      options.merge ?? KeepLatest,
    );
    this._ctx = ctx;
    /** @type {Map<unknown, {value: object, readiness: object, authority: object, retry: object}>} */
    this._scopeReaders = new Map();
    this._accepted = ctx.computed(() => this._core.receipts(IngressReceiptChannel.Accepted));
    this._dropped = ctx.computed(() => this._core.receipts(IngressReceiptChannel.Dropped));
    this._errors = ctx.computed(() => this._core.receipts(IngressReceiptChannel.Error));
    this._transportKind = ctx.source(options.transport ?? IngressTransportKind.EventChannel);
    this._pollInterval = ctx.source(options.pollInterval ?? 1000);
    this._schedule = ctx.computed((cx) =>
      ingressSchedule(cx.get(this._transportKind), cx.get(this._pollInterval)),
    );
  }

  // -- readers --------------------------------------------------------------

  /**
   * Mint (or return) one scope's four readers. Idempotent, so a consumer may
   * hold a handle for a key that has not opened yet — an unknown scope reads
   * `unknown`/null rather than throwing.
   */
  _ensureReaders(key) {
    let readers = this._scopeReaders.get(key);
    if (readers === undefined) {
      readers = {
        value: this._ctx.computed(() => this._core.peek(key)),
        readiness: this._ctx.computed(() => this._core.readiness(key)),
        authority: this._ctx.computed(() => this._core.authority(key)),
        retry: this._ctx.computed(() => this._core.retry(key)),
      };
      this._scopeReaders.set(key, readers);
    }
    return readers;
  }

  /**
   * Apply one core-reported invalidation set. Every affected reader is cleared
   * in a SINGLE frontier walk, so an effect reading several kinds runs against a
   * consistent snapshot: a generation handoff must never be visible as "new
   * value, old authority".
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
    return this._apply(this._core.open(key, generation));
  }

  /** Admit one decoded envelope. Returns the admission outcome. */
  admit(envelope) {
    const { change, admission } = this._core.admit(envelope);
    this._apply(change);
    return admission;
  }

  /**
   * Suspend a scope, retaining its window and watermark. Returns the replay
   * request a reconnect will need, or null when there was nothing to suspend.
   */
  suspend(key) {
    const { change, replay } = this._core.suspend(key);
    this._apply(change);
    return replay;
  }

  /** Reconnect a scope at `generation`, clearing its error streak. */
  reconnect(key, generation) {
    const { change, replay } = this._core.reconnect(key, generation);
    this._apply(change);
    return replay;
  }

  /** Close a scope. It admits nothing and claims no authority until reopened. */
  close(key) {
    return this._apply(this._core.close(key));
  }

  /** Record a transport/decode failure, deepening the scope's backoff. */
  fail(key, error) {
    return this._apply(this._core.fail(key, error));
  }

  /**
   * Advance logical time. Only scopes that CROSSED the freshness horizon are
   * invalidated.
   */
  tick(now) {
    return this._apply(this._core.tick(now));
  }

  /** Drain a scope's coalesced window. Returns null for an empty window. */
  drain(key) {
    const { change, drained } = this._core.drain(key);
    this._apply(change);
    return drained;
  }

  /**
   * Admit everything `transport` has decoded, then ask it to replay any gap
   * still open. Returns the admission outcomes in arrival order.
   *
   * This is the only method that touches a transport, and it makes no decision
   * of its own: the gap it replays is the one the algebra reports.
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
      const view = this._core.view(key);
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

  /** Reactive read: the coalesced window awaiting drain, or null when empty. */
  value(key, cx) {
    return this._read(this._ensureReaders(key).value, cx);
  }

  /** Reactive read: derived readiness. */
  readiness(key, cx) {
    return this._read(this._ensureReaders(key).readiness, cx);
  }

  /** Reactive read: derived authority, or null for a closed/unknown scope. */
  authority(key, cx) {
    return this._read(this._ensureReaders(key).authority, cx);
  }

  /** Reactive read: derived retry decision, or null while healthy. */
  retry(key, cx) {
    return this._read(this._ensureReaders(key).retry, cx);
  }

  /** Reactive read: accepted receipts, oldest first. */
  accepted(cx) {
    return this._read(this._accepted, cx);
  }

  /** Reactive read: dropped receipts, oldest first. */
  dropped(cx) {
    return this._read(this._dropped, cx);
  }

  /** Reactive read: error receipts, oldest first. */
  errors(cx) {
    return this._read(this._errors, cx);
  }

  /** Reactive read: the derived delivery schedule. */
  schedule(cx) {
    return this._read(this._schedule, cx);
  }

  _read(handle, cx) {
    return cx === undefined ? this._ctx.get(handle) : cx.get(handle);
  }

  // -- handles, for composing further derives -------------------------------

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

  /**
   * Retune the transport live: falling back from an event channel to bounded
   * polling is a source write, so every schedule dependent reacts.
   */
  setTransport(kind) {
    this._ctx.set(this._transportKind, kind);
  }

  /** Retune the poll bound live. */
  setPollInterval(interval) {
    this._ctx.set(this._pollInterval, interval);
  }

  // -- non-reactive projections, for assertions and diagnostics -------------

  /** Read-only projection of a scope, or null when unknown. */
  view(key) {
    return this._core.view(key);
  }

  /** The bounds in force. */
  policy() {
    return this._core.policy();
  }

  /** Every known scope key. */
  scopeKeys() {
    return this._core.scopeKeys();
  }
}
