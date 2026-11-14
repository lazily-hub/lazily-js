import type { AtomicMutex, ThreadSafeContext } from "./thread-safe.js";
import type { Compute, EffectHandle, SlotHandle } from "./reactive.js";
import type { EgressEnvelope, EgressPolicy, EgressRetry } from "./egress-core.js";
import type { EgressShell, EgressTransport } from "./egress-shell.js";

export * from "./egress-core.js";
export type { EgressTransport } from "./egress-shell.js";

/** Reactive egress over `ThreadSafeContext`; the core is serialized by its own mutex. */
export declare class ThreadSafeEgressCell<T = unknown> extends EgressShell<T> {
  constructor(
    ctx: ThreadSafeContext,
    generation: number,
    policy?: Partial<EgressPolicy>,
    options?: { mutex?: AtomicMutex },
  );
  readonly mutex: AtomicMutex;
  pending(cx?: Compute): EgressEnvelope<T>[];
  inflight(cx?: Compute): EgressEnvelope<T>[];
  ackedThrough(cx?: Compute): number | null;
  retry(cx?: Compute): EgressRetry | null;
  pendingHandle(): SlotHandle<EgressEnvelope<T>[]>;
  inflightHandle(): SlotHandle<EgressEnvelope<T>[]>;
  ackedThroughHandle(): SlotHandle<number | null>;
  retryHandle(): SlotHandle<EgressRetry | null>;
  /** Attach one transport Effect at the current producer generation. */
  attachTransport(transport: EgressTransport<T>): EffectHandle;
}
