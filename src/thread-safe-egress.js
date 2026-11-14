// ThreadSafeEgressCell — the `Send + Sync` flavor of the transport-agnostic
// reactive egress family (`#lzegress`).
//
// Delivery authority stays in the shared `EgressCore`; what this shell owns is
// the locking discipline:
//
//  * The core is guarded by its OWN mutex, not the context's. A reader's compute
//    body runs while the context lock is held and then takes the core lock, so a
//    mutator that invalidated while still holding the core lock would acquire the
//    two in the opposite order. Every op therefore takes the core lock, computes
//    the invalidation set, RELEASES it, and only then writes the graph.
//  * Invalidation fans out through ONE `clearComputeds` call, which
//    `ThreadSafeContext` runs as a single critical section, so no other realm
//    observes `pending` and `inflight` disagreeing about a claimed envelope.
//  * One attached transport Effect per incarnation, exactly as in the
//    single-threaded flavor.
//
// Mirrors `lazily-rs/src/thread_safe_egress.rs`.

import { EgressShell, attachSyncTransport } from "./egress-shell.js";
import { AtomicMutex } from "./thread-safe.js";

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

function requireThreadSafeContext(ctx) {
  if (
    !ctx ||
    typeof ctx.computed !== "function" ||
    typeof ctx.get !== "function" ||
    typeof ctx.effect !== "function" ||
    typeof ctx.isSet !== "function" ||
    typeof ctx.clearComputeds !== "function"
  ) {
    throw new TypeError("ThreadSafeEgressCell requires a lazily ThreadSafeContext");
  }
}

/** Reactive egress over `ThreadSafeContext`, the core serialized by its own mutex. */
export class ThreadSafeEgressCell extends EgressShell {
  /**
   * @param {import("./thread-safe.js").ThreadSafeContext} ctx
   * @param {number} generation
   * @param {object} [policy]
   * @param {{mutex?: AtomicMutex}} [options]
   */
  constructor(ctx, generation, policy = {}, options = {}) {
    requireThreadSafeContext(ctx);
    super(ctx, generation, policy, {
      asyncReaders: false,
      mutex: options.mutex ?? new AtomicMutex(),
    });
  }

  /** The mutex guarding the delivery core. */
  get mutex() {
    return this._mutex;
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

  /** Attach one transport Effect at the current producer generation. */
  attachTransport(transport) {
    return attachSyncTransport(this, transport);
  }
}
