import type { Compute, Computed, Context, Effect } from "./reactive.js";
import type { EgressEnvelope, EgressPolicy, EgressRetry } from "./egress-core.js";
import type { EgressShell, EgressTransport } from "./egress-shell.js";

export * from "./egress-core.js";
export type { EgressTransport } from "./egress-shell.js";

/** Reactive egress over the single-threaded `Context` (`#lzegress`). */
export declare class EgressCell<T = unknown> extends EgressShell<T> {
  constructor(ctx: Context, generation: number, policy?: Partial<EgressPolicy>);
  pending(cx?: Compute): EgressEnvelope<T>[];
  inflight(cx?: Compute): EgressEnvelope<T>[];
  ackedThrough(cx?: Compute): number | null;
  retry(cx?: Compute): EgressRetry | null;
  pendingHandle(): Computed<EgressEnvelope<T>[]>;
  inflightHandle(): Computed<EgressEnvelope<T>[]>;
  ackedThroughHandle(): Computed<number | null>;
  retryHandle(): Computed<EgressRetry | null>;
  /** Attach one transport Effect at the current producer generation. */
  attachTransport(transport: EgressTransport<T>): Effect;
}
