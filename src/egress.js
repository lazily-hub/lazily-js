// EgressCell — the single-threaded `Context` flavor of the transport-agnostic
// reactive egress family (`#lzegress`).
//
// The four delivery-state readers (`pending`, `inflight`, `ackedThrough`,
// `retry`) are Computeds over `EgressCore`; transport I/O lives in exactly one
// Effect per attachment (`attachTransport`). See `./egress-shell.js` for the
// invalidation discipline and `./egress-core.js` for the delivery authority.
//
// Mirrors `lazily-rs/src/egress.rs`; spec: lazily-spec/docs/transport-egress.md.

import { EgressShell, attachSyncTransport } from "./egress-shell.js";

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

function requireSyncContext(ctx) {
  if (
    !ctx ||
    typeof ctx.computed !== "function" ||
    typeof ctx.get !== "function" ||
    typeof ctx.effect !== "function" ||
    typeof ctx.clearComputeds !== "function"
  ) {
    throw new TypeError("EgressCell requires a lazily Context");
  }
}

/** Reactive egress over the single-threaded `Context`. */
export class EgressCell extends EgressShell {
  /**
   * @param {import("./reactive.js").Context} ctx
   * @param {number} generation the producer incarnation of the first attachment.
   * @param {object} [policy] merged over `defaultEgressPolicy()`.
   */
  constructor(ctx, generation, policy = {}) {
    requireSyncContext(ctx);
    super(ctx, generation, policy, { asyncReaders: false, mutex: null });
  }

  pending(cx) {
    return (cx ?? this._ctx).get(this._pending);
  }

  inflight(cx) {
    return (cx ?? this._ctx).get(this._inflight);
  }

  ackedThrough(cx) {
    return (cx ?? this._ctx).get(this._ackedThrough);
  }

  retry(cx) {
    return (cx ?? this._ctx).get(this._retry);
  }

  /**
   * Attach one transport Effect at the current producer generation.
   * `transport.send(envelope)` returns `true` when the transport accepted the
   * send attempt; domain delivery is proven later by `ack`. Anything else is a
   * failed send, recorded through `fail` (and parked for `retryNow`).
   */
  attachTransport(transport) {
    return attachSyncTransport(this, transport);
  }
}
