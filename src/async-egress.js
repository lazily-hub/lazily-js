// AsyncEgressCell — the AsyncContext flavor of the transport-agnostic reactive
// egress family (`#lzegress`).
//
// Delivery authority is NOT async-coloured: `enqueue`, `claim`, `ack`, `fail`,
// `retryNow` and `reconnect` are synchronous and return plain values, exactly as
// in the other two flavors. Only the transport attachment is async-coloured —
// `attachTransport` installs one `effectAsync` whose `send` may return a
// Promise, and a send in flight never holds any lock.
//
// Reader materialization is awaited (`getAsync`) only because this binding's
// `AsyncContext` offers no synchronous compute constructor; the compute bodies
// themselves are synchronous reads of the core. That is the same single async
// obligation `async-ingress.js` and `async-reactive-family.js` carry, a property
// of the JS async graph rather than of the egress algebra. (lazily-rs's
// `AsyncEgressCell` uses a synchronous compute on the async graph and returns
// plain values from its readers.)
//
// Mirrors `lazily-rs/src/async_egress.rs`.

import { EgressClaimKind } from "./egress-core.js";
import { EgressShell } from "./egress-shell.js";

export {
  EgressAckKind,
  EgressClaimKind,
  EgressConfigError,
  EgressCore,
  EgressFailureKind,
  EgressReconnectKind,
  EgressRetryActionKind,
  defaultEgressPolicy,
  egressChangeIsEmpty,
} from "./egress-core.js";

function requireAsyncContext(ctx) {
  if (
    !ctx ||
    typeof ctx.computedAsync !== "function" ||
    typeof ctx.getAsync !== "function" ||
    typeof ctx.effectAsync !== "function" ||
    typeof ctx.clearComputeds !== "function"
  ) {
    throw new TypeError("AsyncEgressCell requires a lazily AsyncContext");
  }
}

/** Reactive egress over `AsyncContext`; transitions stay synchronous. */
export class AsyncEgressCell extends EgressShell {
  /**
   * @param {import("./reactive-async.js").AsyncContext} ctx
   * @param {number} generation
   * @param {object} [policy]
   */
  constructor(ctx, generation, policy = {}) {
    requireAsyncContext(ctx);
    super(ctx, generation, policy, { asyncReaders: true, mutex: null });
  }

  pending(cx) {
    return (cx ?? this._ctx).getAsync(this._pending);
  }

  inflight(cx) {
    return (cx ?? this._ctx).getAsync(this._inflight);
  }

  ackedThrough(cx) {
    return (cx ?? this._ctx).getAsync(this._ackedThrough);
  }

  retry(cx) {
    return (cx ?? this._ctx).getAsync(this._retry);
  }

  /**
   * Attach one async transport Effect at the current producer generation.
   * `transport.send(envelope)` may return `true`/`false` or a Promise of one.
   * Every claimed envelope is settled by this run even if a newer run superseded
   * it mid-send (a refused send is still recorded through `fail`); the run only
   * stops claiming once superseded.
   */
  attachTransport(transport) {
    if (!transport || typeof transport.send !== "function") {
      throw new TypeError("attachTransport requires a transport with a send(envelope) method");
    }
    const generation = this.generation;
    const pending = this._pending;
    const inflight = this._inflight;
    return this._ctx.effectAsync(async (cx) => {
      await cx.getAsync(inflight);
      if ((await cx.getAsync(pending)).length === 0) return;
      while (!cx.signal.aborted) {
        const claim = this.claim(generation);
        if (claim.kind !== EgressClaimKind.Claimed) break;
        if ((await transport.send(claim.envelope)) !== true) {
          this.fail(generation, claim.envelope.sequence);
          break;
        }
      }
    });
  }
}
