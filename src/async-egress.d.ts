import type {
  AsyncComputeContext,
  AsyncComputed,
  AsyncContext,
  AsyncEffectHandle,
} from "./reactive-async.js";
import type { EgressEnvelope, EgressPolicy, EgressRetry } from "./egress-core.js";
import type { AsyncEgressTransport, EgressShell } from "./egress-shell.js";

export * from "./egress-core.js";
export type { AsyncEgressTransport } from "./egress-shell.js";

/** Reactive egress over `AsyncContext`; transitions stay synchronous. */
export declare class AsyncEgressCell<T = unknown> extends EgressShell<T> {
  constructor(ctx: AsyncContext, generation: number, policy?: Partial<EgressPolicy>);
  pending(cx?: AsyncComputeContext): Promise<EgressEnvelope<T>[]>;
  inflight(cx?: AsyncComputeContext): Promise<EgressEnvelope<T>[]>;
  ackedThrough(cx?: AsyncComputeContext): Promise<number | null>;
  retry(cx?: AsyncComputeContext): Promise<EgressRetry | null>;
  pendingHandle(): AsyncComputed<EgressEnvelope<T>[]>;
  inflightHandle(): AsyncComputed<EgressEnvelope<T>[]>;
  ackedThroughHandle(): AsyncComputed<number | null>;
  retryHandle(): AsyncComputed<EgressRetry | null>;
  /** Attach one async-coloured transport Effect at the current producer generation. */
  attachTransport(transport: AsyncEgressTransport<T>): AsyncEffectHandle;
}
