// Shared graph shell for the three reactive egress flavors (`#lzegress`).
//
// Internal module: the public entry points are `./egress.js` (EgressCell),
// `./thread-safe-egress.js` (ThreadSafeEgressCell) and `./async-egress.js`
// (AsyncEgressCell). One base keeps the projection, invalidation, and
// attachment logic identical across flavors; each flavor supplies only its
// context check, its reader constructor, and (thread-safe) the core's own lock.
//
// The shell owns no delivery decision. The four readers are Computeds over
// `EgressCore`; every mutator runs the core transition (under the core lock
// when there is one), RELEASES that lock, and only then invalidates exactly the
// reader kinds the core reported, in ONE `clearComputeds` frontier walk. A no-op
// or stale-generation transition reports an empty change and invalidates
// nothing.
//
// Transport I/O lives in exactly one Effect per attachment
// (`attachTransport`). The Effect captures the generation current when it
// attaches and passes it to every send-side transition, so after `reconnect`
// the old Effect stays attached but inert at the core's fence; the caller
// attaches one replacement Effect for the new incarnation, which replays the
// retained pending projection.

import { EgressClaimKind, EgressCore, egressChangeIsEmpty } from "./egress-core.js";

export class EgressShell {
  /**
   * @param {object} ctx
   * @param {number} generation
   * @param {object} policy
   * @param {{asyncReaders: boolean, mutex: {runExclusive: Function} | null}} flavor
   */
  constructor(ctx, generation, policy, { asyncReaders, mutex }) {
    // Validate before minting any graph node: a refused policy leaves no reader.
    this._core = new EgressCore(generation, policy ?? {});
    this._ctx = ctx;
    this._asyncReaders = asyncReaders;
    this._mutex = mutex;
    this._pending = this._computed(() => this._core.pending());
    this._inflight = this._computed(() => this._core.inflight());
    this._ackedThrough = this._computed(() => this._core.ackedThrough());
    this._retry = this._computed(() => this._core.retry());
  }

  _computed(read) {
    const locked = () => this._locked(read);
    return this._asyncReaders
      ? this._ctx.computedAsync(async () => locked())
      : this._ctx.computed(locked);
  }

  _locked(body) {
    return this._mutex === null ? body() : this._mutex.runExclusive(body);
  }

  /** Invalidate the reported reader kinds with the core lock already released. */
  _apply(change) {
    if (egressChangeIsEmpty(change)) return;
    const roots = [];
    if (change.pending) roots.push(this._pending);
    if (change.inflight) roots.push(this._inflight);
    if (change.ackedThrough) roots.push(this._ackedThrough);
    if (change.retry) roots.push(this._retry);
    this._ctx.clearComputeds(roots);
  }

  // -- non-reactive projections ---------------------------------------------

  /** The current producer generation. */
  get generation() {
    return this._locked(() => this._core.generation);
  }

  /** The next sequence `enqueue` will assign. */
  get nextSequence() {
    return this._locked(() => this._core.nextSequence);
  }

  policy() {
    return this._core.policy();
  }

  // -- mutating ops ---------------------------------------------------------

  /** Assign the next sequence to `payload`; returns that sequence. */
  enqueue(payload) {
    const { change, sequence } = this._locked(() => this._core.enqueue(payload));
    this._apply(change);
    return sequence;
  }

  /** Claim the oldest pending envelope for the attachment at `generation`. */
  claim(generation) {
    const { change, claim } = this._locked(() => this._core.claim(generation));
    this._apply(change);
    return claim;
  }

  /** Cumulatively acknowledge every sequence at or below `through`. */
  ack(generation, through) {
    const { change, ack } = this._locked(() => this._core.ack(generation, through));
    this._apply(change);
    return ack;
  }

  /** Record a failed send of the in-flight `sequence`. */
  fail(generation, sequence) {
    const { change, failure } = this._locked(() => this._core.fail(generation, sequence));
    this._apply(change);
    return failure;
  }

  /** Return the parked `sequence` to pending once its backoff elapsed. */
  retryNow(generation, sequence) {
    const { change, action } = this._locked(() => this._core.retryNow(generation, sequence));
    this._apply(change);
    return action;
  }

  /** Advance the producer generation, fencing the old attachment. */
  reconnect(generation) {
    const { change, reconnect } = this._locked(() => this._core.reconnect(generation));
    this._apply(change);
    return reconnect;
  }

  // -- handles --------------------------------------------------------------

  pendingHandle() {
    return this._pending;
  }

  inflightHandle() {
    return this._inflight;
  }

  ackedThroughHandle() {
    return this._ackedThrough;
  }

  retryHandle() {
    return this._retry;
  }
}

/**
 * The synchronous attachment Effect shared by the two synchronous flavors.
 * `inflight` is a dependency even though the core is the authority: an
 * acknowledgement reopens the send window and must re-run this same Effect.
 */
export function attachSyncTransport(shell, transport) {
  if (!transport || typeof transport.send !== "function") {
    throw new TypeError("attachTransport requires a transport with a send(envelope) method");
  }
  const generation = shell.generation;
  const pending = shell.pendingHandle();
  const inflight = shell.inflightHandle();
  return shell._ctx.effect((cx) => {
    cx.get(inflight);
    if (cx.get(pending).length === 0) return;
    for (;;) {
      const claim = shell.claim(generation);
      if (claim.kind !== EgressClaimKind.Claimed) break;
      if (transport.send(claim.envelope) !== true) {
        shell.fail(generation, claim.envelope.sequence);
        break;
      }
    }
  });
}
