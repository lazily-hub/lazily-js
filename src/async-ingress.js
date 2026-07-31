// AsyncIngressCell — the AsyncContext flavor of the transport-agnostic reactive
// ingress family (`#designimplementtransport`).
//
// Admission is NOT async-coloured. Whether an envelope is admissible is a
// function of the fence, the watermark, the reorder buffer, and the observed
// clock — state the graph does not own and nothing has to await. So every
// mutator below (`admit`, `open`, `suspend`, `reconnect`, `close`, `fail`,
// `tick`, `drain`, `pump`) is synchronous and returns a plain value, exactly as
// in the other two flavors. Awaiting belongs to the transport, and the transport
// is outside the primitive by construction.
//
// What IS async-coloured here is reader materialization, and only because this
// binding's `AsyncContext` offers no synchronous compute constructor: its derived
// nodes are built with `computedAsync` and read with `getAsync`. That is the same
// single async obligation `async-reactive-family.js` carries and the same one
// `test/collections-family-conformance.test.js` records for the map family — it
// is a property of the JS async graph, not of the ingress algebra. (lazily-rs's
// `AsyncIngressCell` uses a synchronous compute on the async graph and so returns
// plain values from its readers too.)
//
// Multi-root invalidation goes through `AsyncContext#clearComputeds`, which marks
// every root before any microtask runs, so an effect reading several kinds still
// observes them together: a generation handoff must never be visible as "new
// value, old authority".
//
// Mirrors `lazily-rs/src/async_ingress.rs`.

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
  ingressEnvelope,
  ingressSchedule,
  isDelivered,
  receiptChannel,
} from "./ingress-core.js";

function requireAsyncContext(ctx) {
  if (
    !ctx ||
    typeof ctx.computedAsync !== "function" ||
    typeof ctx.getAsync !== "function" ||
    typeof ctx.source !== "function" ||
    typeof ctx.clearComputeds !== "function"
  ) {
    throw new TypeError("AsyncIngressCell requires a lazily AsyncContext");
  }
}

/**
 * A keyed, lifecycle-scoped reactive ingress on the async graph. Mutators are
 * synchronous; reads resolve through `getAsync`.
 */
export class AsyncIngressCell {
  /**
   * @param {import("./reactive-async.js").AsyncContext} ctx
   * @param {{
   *   policy?: object,
   *   merge?: {merge: (old: unknown, op: unknown) => unknown, conflates: boolean},
   *   transport?: string,
   *   pollInterval?: number,
   * }} [options]
   */
  constructor(ctx, options = {}) {
    requireAsyncContext(ctx);
    // Validate before minting any graph node: a rejected policy must leave no
    // reader behind.
    this._core = new IngressCore(
      { ...defaultIngressPolicy(), ...(options.policy ?? {}) },
      options.merge ?? KeepLatest,
    );
    this._ctx = ctx;
    /** @type {Map<unknown, {value: object, readiness: object, authority: object, retry: object}>} */
    this._scopeReaders = new Map();
    this._accepted = ctx.computedAsync(async () =>
      this._core.receipts(IngressReceiptChannel.Accepted),
    );
    this._dropped = ctx.computedAsync(async () =>
      this._core.receipts(IngressReceiptChannel.Dropped),
    );
    this._errors = ctx.computedAsync(async () => this._core.receipts(IngressReceiptChannel.Error));
    this._transportKind = ctx.source(options.transport ?? IngressTransportKind.EventChannel);
    this._pollInterval = ctx.source(options.pollInterval ?? 1000);
    this._schedule = ctx.computedAsync(async (cx) =>
      ingressSchedule(cx.get(this._transportKind), cx.get(this._pollInterval)),
    );
  }

  // -- readers --------------------------------------------------------------

  /** Mint (or return) one scope's four readers. Idempotent. */
  _ensureReaders(key) {
    let readers = this._scopeReaders.get(key);
    if (readers === undefined) {
      readers = {
        value: this._ctx.computedAsync(async () => this._core.peek(key)),
        readiness: this._ctx.computedAsync(async () => this._core.readiness(key)),
        authority: this._ctx.computedAsync(async () => this._core.authority(key)),
        retry: this._ctx.computedAsync(async () => this._core.retry(key)),
      };
      this._scopeReaders.set(key, readers);
    }
    return readers;
  }

  /** Apply one core-reported invalidation set in a single synchronous walk. */
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

  // -- mutating ops (synchronous: admission is not async-coloured) -----------

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

  /** Suspend a scope, retaining its window and watermark. */
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

  /** Advance logical time. Only horizon crossings are invalidated. */
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

  // -- reactive reads (async-coloured: see the file header) ------------------

  /** @returns {Promise<unknown>} the coalesced window, or null when empty. */
  value(key) {
    return this._ctx.getAsync(this._ensureReaders(key).value);
  }

  /** @returns {Promise<string>} derived readiness. */
  readiness(key) {
    return this._ctx.getAsync(this._ensureReaders(key).readiness);
  }

  /** @returns {Promise<object | null>} derived authority. */
  authority(key) {
    return this._ctx.getAsync(this._ensureReaders(key).authority);
  }

  /** @returns {Promise<object | null>} derived retry decision. */
  retry(key) {
    return this._ctx.getAsync(this._ensureReaders(key).retry);
  }

  /** @returns {Promise<Array<object>>} accepted receipts, oldest first. */
  accepted() {
    return this._ctx.getAsync(this._accepted);
  }

  /** @returns {Promise<Array<object>>} dropped receipts, oldest first. */
  dropped() {
    return this._ctx.getAsync(this._dropped);
  }

  /** @returns {Promise<Array<object>>} error receipts, oldest first. */
  errors() {
    return this._ctx.getAsync(this._errors);
  }

  /** @returns {Promise<object>} the derived delivery schedule. */
  schedule() {
    return this._ctx.getAsync(this._schedule);
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
    return this._core.view(key);
  }

  policy() {
    return this._core.policy();
  }

  scopeKeys() {
    return this._core.scopeKeys();
  }
}
