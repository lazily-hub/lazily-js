import type { IngressAdmission } from "./ingress-core.js";

export const DURABLE_PROTOCOL_VERSION: 1;
export const DurableProjectionCompleteness: Readonly<{ CompleteHistory: "complete_history" }>;
export const DurableProjectionHealth: Readonly<{
  Healthy: "healthy";
  Lagging: "lagging";
  Drifted: "drifted";
}>;
export const DurableHostOutcome: Readonly<{
  Committed: "committed";
  Duplicate: "duplicate";
  Conflict: "conflict";
  Rejected: "rejected";
}>;
export type DurableCapabilities = Readonly<{
  core: true;
  client: true;
  durable_host: false;
  distributed_host: false;
  accelerated_host: false;
}>;
export const DURABLE_CAPABILITIES: DurableCapabilities;

export type DurableIngressEnvelope = {
  protocol_version: 1;
  message_id: string;
  schema_version: number;
  codec_version: number;
  payload: Uint8Array | readonly number[];
};
export type DurableBrokerPubAck = Readonly<{
  stream: string;
  sequence: number;
  duplicate: boolean;
}>;
export type DurableHostReceipt = {
  protocol_version: 1;
  receipt_id: string;
  message_id: string;
  outcome: "committed" | "duplicate" | "conflict" | "rejected";
  owner_position: number;
};
export type DurableProjectionFingerprint = {
  projection_id: string;
  source_position: number;
  fingerprint: string;
  completeness: "complete_history" | "latest_state_only";
  may_authorize_transition: false;
};
export type DurableProjectionFingerprintComparison = Readonly<{
  same_source: boolean;
  same_fingerprint: boolean;
  same_completeness: boolean;
  equivalent: boolean;
}>;
export type DurableProjectionEvent<T = unknown> = {
  protocol_version: 1;
  owner_id: string;
  generation: number;
  source_position: number;
  projection_version: number;
  schema_version: number;
  codec_version: number;
  completeness: "complete_history";
  entries: T;
  source_fingerprint: string;
  projection_fingerprint: string;
  health: "healthy" | "lagging" | "drifted";
  may_authorize_transition: false;
};
export interface DurableSubscription {
  next(): Promise<Uint8Array>;
  close(): void | Promise<void>;
}
export interface DurableNATSTransport {
  publish(subject: string, payload: Uint8Array): Promise<DurableBrokerPubAck> | DurableBrokerPubAck;
  subscribe(subject: string): DurableSubscription;
}
export function durableIngressEnvelope(value: DurableIngressEnvelope): Readonly<{
  protocol_version: 1;
  message_id: string;
  schema_version: number;
  codec_version: number;
  payload: readonly number[];
}>;
export function encodeDurableIngressEnvelope(value: DurableIngressEnvelope): Uint8Array;
export function decodeDurableIngressEnvelope(
  bytes: Uint8Array,
): ReturnType<typeof durableIngressEnvelope>;
export function compareDurableProjectionFingerprints(
  left: DurableProjectionFingerprint,
  right: DurableProjectionFingerprint,
): DurableProjectionFingerprintComparison;
export class DurableClient<T = unknown> {
  constructor(transport: DurableNATSTransport);
  publishIngress(subject: string, envelope: DurableIngressEnvelope): Promise<DurableBrokerPubAck>;
  subscribe(subject: string): DurableSubscription;
  observeIngress(envelope: DurableIngressEnvelope): "first" | "duplicate" | "conflict";
  observedMessageIds(): string[];
  observeHostReceipt(receipt: DurableHostReceipt): "recorded" | "duplicate";
  hostReceipt(receiptId: string): Readonly<DurableHostReceipt> | null;
  observeProjection(projection: DurableProjectionEvent<T>): IngressAdmission;
  projection(ownerId: string): Readonly<DurableProjectionEvent<T>> | null;
  appliedSourcePositions(ownerId: string): number[];
}
export { IngressAdmissionKind, IngressDropReason } from "./ingress-core.js";
