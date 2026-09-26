import {
  IngressAdmissionKind,
  IngressCore,
  IngressDropReason,
  defaultIngressPolicy,
  ingressEnvelope,
} from "./ingress-core.js";
import { KeepLatest } from "./merge.js";

export const DURABLE_PROTOCOL_VERSION = 1;
export const DurableProjectionCompleteness = Object.freeze({ CompleteHistory: "complete_history" });
export const DurableProjectionHealth = Object.freeze({
  Healthy: "healthy",
  Lagging: "lagging",
  Drifted: "drifted",
});
export const DurableHostOutcome = Object.freeze({
  Committed: "committed",
  Duplicate: "duplicate",
  Conflict: "conflict",
  Rejected: "rejected",
});

/** Five-tier declaration: this binding implements Core and Client only. */
export const DURABLE_CAPABILITIES = Object.freeze({
  core: true,
  client: true,
  durable_host: false,
  distributed_host: false,
  accelerated_host: false,
});

function positiveUint32(value, name) {
  if (!Number.isInteger(value) || value < 1 || value > 0xffffffff) {
    throw new TypeError(`${name} must be a positive uint32`);
  }
  return value;
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function payloadBytes(payload) {
  if (!(payload instanceof Uint8Array) && !Array.isArray(payload)) {
    throw new TypeError("payload must be a Uint8Array or byte array");
  }
  const values = Array.from(payload);
  values.forEach((value, index) => {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new TypeError(`payload[${index}] must be a byte`);
    }
  });
  return values;
}

/** Validate and normalize the canonical durable client envelope v1. */
export function durableIngressEnvelope(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("durable envelope must be an object");
  }
  // Required to fail before payload inspection by the shared corpus.
  if (value.protocol_version !== DURABLE_PROTOCOL_VERSION) {
    throw new TypeError("unsupported_protocol_version");
  }
  if (typeof value.message_id !== "string" || value.message_id.length === 0) {
    throw new TypeError("invalid_message_id");
  }
  if (
    !Number.isInteger(value.schema_version) ||
    value.schema_version < 1 ||
    value.schema_version > 0xffffffff
  ) {
    throw new TypeError("invalid_schema_version");
  }
  if (
    !Number.isInteger(value.codec_version) ||
    value.codec_version < 1 ||
    value.codec_version > 0xffffffff
  ) {
    throw new TypeError("invalid_codec_version");
  }
  return Object.freeze({
    protocol_version: DURABLE_PROTOCOL_VERSION,
    message_id: value.message_id,
    schema_version: value.schema_version,
    codec_version: value.codec_version,
    payload: Object.freeze(payloadBytes(value.payload)),
  });
}

export function encodeDurableIngressEnvelope(value) {
  return new TextEncoder().encode(JSON.stringify(durableIngressEnvelope(value)));
}

export function decodeDurableIngressEnvelope(bytes) {
  return durableIngressEnvelope(JSON.parse(new TextDecoder().decode(bytes)));
}

function validatePubAck(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("transport publish must return a broker PubAck object");
  }
  return Object.freeze({
    stream: nonEmptyString(value.stream, "PubAck.stream"),
    sequence: positiveUint32(value.sequence, "PubAck.sequence"),
    duplicate: Boolean(value.duplicate),
  });
}

function validateHostReceipt(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("host receipt must be an object");
  }
  if (value.protocol_version !== DURABLE_PROTOCOL_VERSION)
    throw new TypeError("unsupported_protocol_version");
  if (!Object.values(DurableHostOutcome).includes(value.outcome)) {
    throw new TypeError("invalid durable host receipt outcome");
  }
  return Object.freeze({
    protocol_version: DURABLE_PROTOCOL_VERSION,
    receipt_id: nonEmptyString(value.receipt_id, "receipt_id"),
    message_id: nonEmptyString(value.message_id, "message_id"),
    outcome: value.outcome,
    owner_position:
      Number.isSafeInteger(value.owner_position) && value.owner_position >= 0
        ? value.owner_position
        : (() => {
            throw new TypeError("owner_position must be a non-negative safe integer");
          })(),
  });
}

/** Compare the portable projection fingerprint equality class. */
export function compareDurableProjectionFingerprints(left, right) {
  for (const value of [left, right]) {
    nonEmptyString(value?.projection_id, "projection_id");
    if (!Number.isSafeInteger(value.source_position) || value.source_position < 0) {
      throw new TypeError("source_position must be a non-negative safe integer");
    }
    if (typeof value.fingerprint !== "string" || !/^[0-9a-f]+$/.test(value.fingerprint)) {
      throw new TypeError("fingerprint must be lowercase hexadecimal");
    }
    if (!["complete_history", "latest_state_only"].includes(value.completeness)) {
      throw new TypeError("invalid projection completeness");
    }
    if (value.may_authorize_transition !== false) {
      throw new TypeError("projection fingerprint is advisory");
    }
  }
  const same_source =
    left.projection_id === right.projection_id && left.source_position === right.source_position;
  const same_fingerprint = left.fingerprint === right.fingerprint;
  const same_completeness = left.completeness === right.completeness;
  return Object.freeze({
    same_source,
    same_fingerprint,
    same_completeness,
    equivalent: same_source && same_fingerprint && same_completeness,
  });
}

function validateProjection(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("projection event must be an object");
  }
  if (value.protocol_version !== DURABLE_PROTOCOL_VERSION)
    throw new TypeError("unsupported_protocol_version");
  if (value.completeness !== DurableProjectionCompleteness.CompleteHistory) {
    throw new TypeError("durable projection client requires complete_history");
  }
  if (value.may_authorize_transition !== false) {
    throw new TypeError("advisory projection may not authorize transitions");
  }
  if (!Object.values(DurableProjectionHealth).includes(value.health)) {
    throw new TypeError("invalid durable projection health");
  }
  return Object.freeze({
    ...value,
    owner_id: nonEmptyString(value.owner_id, "owner_id"),
    generation: positiveUint32(value.generation, "generation"),
    source_position: positiveUint32(value.source_position, "source_position"),
    projection_version: positiveUint32(value.projection_version, "projection_version"),
    schema_version: positiveUint32(value.schema_version, "schema_version"),
    codec_version: positiveUint32(value.codec_version, "codec_version"),
    source_fingerprint: nonEmptyString(value.source_fingerprint, "source_fingerprint"),
    projection_fingerprint: nonEmptyString(value.projection_fingerprint, "projection_fingerprint"),
  });
}

/** Lightweight durable Client adapter over an injected NATS-compatible seam. */
export class DurableClient {
  constructor(transport) {
    if (
      transport === null ||
      typeof transport !== "object" ||
      typeof transport.publish !== "function" ||
      typeof transport.subscribe !== "function"
    ) {
      throw new TypeError("transport must provide publish and subscribe");
    }
    this.transport = transport;
    this.projections = new IngressCore(defaultIngressPolicy(), KeepLatest);
    this.latest = new Map();
    this.receipts = new Map();
    this.messages = new Map();
    this.deliveryOrder = [];
    this.projectionIdentities = new Map();
    this.appliedProjectionPositions = new Map();
  }

  /** Returns only the broker's PubAck, never a synthetic host receipt. */
  async publishIngress(subject, envelope) {
    nonEmptyString(subject, "subject");
    const ack = await this.transport.publish(subject, encodeDurableIngressEnvelope(envelope));
    return validatePubAck(ack);
  }

  subscribe(subject) {
    nonEmptyString(subject, "subject");
    return this.transport.subscribe(subject);
  }

  /** Preserve transport observation order while classifying identity repeats. */
  observeIngress(value) {
    const envelope = durableIngressEnvelope(value);
    this.deliveryOrder.push(envelope.message_id);
    const encoded = JSON.stringify(envelope);
    const prior = this.messages.get(envelope.message_id);
    if (prior === undefined) {
      this.messages.set(envelope.message_id, encoded);
      return "first";
    }
    return prior === encoded ? "duplicate" : "conflict";
  }

  observedMessageIds() {
    return [...this.deliveryOrder];
  }

  observeHostReceipt(value) {
    const receipt = validateHostReceipt(value);
    const prior = this.receipts.get(receipt.receipt_id);
    if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(receipt)) {
      throw new Error(`conflicting durable receipt for ${receipt.receipt_id}`);
    }
    this.receipts.set(receipt.receipt_id, receipt);
    return prior === undefined ? "recorded" : "duplicate";
  }

  hostReceipt(receiptId) {
    return this.receipts.get(receiptId) ?? null;
  }

  observeProjection(value) {
    const projection = validateProjection(value);
    const identity = `${projection.owner_id}\u0000${projection.generation}\u0000${projection.source_position}`;
    const fingerprint = JSON.stringify([
      projection.source_fingerprint,
      projection.projection_fingerprint,
      projection.schema_version,
      projection.codec_version,
    ]);
    const priorFingerprint = this.projectionIdentities.get(identity);
    if (priorFingerprint !== undefined && priorFingerprint !== fingerprint) {
      throw new Error(
        `conflicting durable projection at ${projection.owner_id}/${projection.source_position}`,
      );
    }
    this.projectionIdentities.set(identity, fingerprint);
    const before = this.projections.authority(projection.owner_id)?.deliveredThrough ?? -1;
    const { admission } = this.projections.admit(
      ingressEnvelope(
        projection.owner_id,
        projection.generation,
        projection.source_position - 1,
        projection.source_position,
        projection,
      ),
    );
    const after = this.projections.authority(projection.owner_id)?.deliveredThrough ?? before;
    if (after > before) {
      const applied = this.appliedProjectionPositions.get(projection.owner_id) ?? [];
      for (let sequence = before + 1; sequence <= after; sequence += 1) applied.push(sequence + 1);
      this.appliedProjectionPositions.set(projection.owner_id, applied);
    }
    const { drained } = this.projections.drain(projection.owner_id);
    if (drained !== null) this.latest.set(projection.owner_id, drained);
    return admission;
  }

  projection(ownerId) {
    return this.latest.get(ownerId) ?? null;
  }

  appliedSourcePositions(ownerId) {
    return [...(this.appliedProjectionPositions.get(ownerId) ?? [])];
  }
}

export { IngressAdmissionKind, IngressDropReason };
