import type {
  EgressAck,
  EgressClaim,
  EgressFailure,
  EgressPolicy,
  EgressReconnect,
  EgressRetryAction,
} from "./egress-core.js";

/** The transport seam egress owns: `send` returns true when the transport accepted the attempt. */
export interface EgressTransport<T = unknown> {
  send(envelope: import("./egress-core.js").EgressEnvelope<T>): boolean;
}

/** The async transport seam: `send` may resolve asynchronously. */
export interface AsyncEgressTransport<T = unknown> {
  send(envelope: import("./egress-core.js").EgressEnvelope<T>): boolean | Promise<boolean>;
}

/** Mutators and projections shared by every egress flavor. */
export declare class EgressShell<T = unknown> {
  readonly generation: number;
  readonly nextSequence: number;
  policy(): Readonly<EgressPolicy>;
  enqueue(payload: T): number;
  claim(generation: number): EgressClaim<T>;
  ack(generation: number, through: number): EgressAck;
  fail(generation: number, sequence: number): EgressFailure;
  retryNow(generation: number, sequence: number): EgressRetryAction;
  reconnect(generation: number): EgressReconnect;
}
