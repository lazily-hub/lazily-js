import assert from "node:assert/strict";
import test from "node:test";

import {
  DURABLE_CAPABILITIES,
  DurableClient,
  DurableProjectionCompleteness,
  DurableProjectionHealth,
  compareDurableProjectionFingerprints,
  decodeDurableIngressEnvelope,
} from "../src/durable-client.js";
import { assertKey } from "./support/assert-key.js";
import { loadFixture } from "./spec-corpus.cjs";

const fixture = loadFixture("durable-client", "envelope_v1.json");

function transport() {
  return {
    publications: [],
    async publish(subject, payload) {
      this.publications.push({ subject, payload });
      return { stream: "INGRESS", sequence: 7, duplicate: false };
    },
    subscribe(subject) {
      return { subject, async next() {}, close() {} };
    },
  };
}

function projection(position, entries) {
  return {
    protocol_version: 1,
    owner_id: "sample-owner",
    generation: 1,
    source_position: position,
    projection_version: position,
    schema_version: 7,
    codec_version: 11,
    completeness: DurableProjectionCompleteness.CompleteHistory,
    entries,
    source_fingerprint: `source-${position}`,
    projection_fingerprint: `projection-${position}`,
    health: DurableProjectionHealth.Healthy,
    may_authorize_transition: false,
  };
}

test("replays all canonical durable client vector dimensions", async () => {
  const seam = transport();
  const client = new DurableClient(seam);
  for (const vector of fixture.envelope_vectors) {
    let ack = null;
    let reason = "accepted";
    try {
      ack = await client.publishIngress("sample.ingress", vector.envelope);
    } catch (error) {
      reason = error.message;
    }
    assertKey(vector.expected, "accepted", ack !== null);
    assertKey(vector.expected, "reason", reason);
    assertKey(vector.expected, "payload_decoded", ack !== null);
    if (ack !== null) {
      assert.deepEqual(ack, { stream: "INGRESS", sequence: 7, duplicate: false });
      assert.deepEqual(
        decodeDurableIngressEnvelope(seam.publications.at(-1).payload),
        vector.envelope,
      );
      assert.equal(client.hostReceipt("missing"), null);
    }
  }
  for (const vector of fixture.ordering_vectors) {
    const ordered = new DurableClient(transport());
    for (const [index, message_id] of vector.observed_message_ids.entries()) {
      ordered.observeIngress({
        protocol_version: 1,
        message_id,
        schema_version: 7,
        codec_version: 11,
        payload: [index],
      });
    }
    assertKey(vector, "expected_delivery_order", ordered.observedMessageIds());
    assertKey(vector, "owner_order_inferred", false);
  }
  for (const vector of fixture.projection_ordering_vectors) {
    const projected = new DurableClient(transport());
    const classifications = [];
    for (const position of vector.observed_source_positions) {
      const result = projected.observeProjection(projection(position, [position]));
      classifications.push(
        result.kind === "buffered"
          ? "buffered"
          : result.kind === "dropped"
            ? "duplicate"
            : "applied",
      );
    }
    assertKey(vector, "expected_delivery_classification", classifications);
    assertKey(
      vector,
      "expected_applied_positions",
      projected.appliedSourcePositions("sample-owner"),
    );
    assertKey(vector, "broker_order_authoritative", false);
    assertKey(vector, "may_authorize_transition", false);
  }
  for (const vector of fixture.dedup_vectors) {
    const dedup = new DurableClient(transport());
    assertKey(
      vector,
      "expected_classification",
      vector.deliveries.map((item) => dedup.observeIngress(item)),
    );
  }
  for (const vector of fixture.receipt_vectors) {
    assert.equal(client.observeHostReceipt(vector.receipt), "recorded");
    const actualReceipt = client.hostReceipt(vector.receipt.receipt_id);
    assert.deepEqual(
      Object.keys(actualReceipt).sort(),
      Object.keys(vector.expected_round_trip).sort(),
    );
    for (const key of Object.keys(vector.expected_round_trip)) {
      assertKey(vector.expected_round_trip, key, actualReceipt[key]);
    }
    assert.equal(client.observeHostReceipt(vector.receipt), "duplicate");
    assertKey(vector, "transport_ack_equivalent", false);
  }
  for (const vector of fixture.projection_fingerprint_vectors) {
    const actual = compareDurableProjectionFingerprints(vector.left, vector.right);
    for (const key of ["same_source", "same_fingerprint", "same_completeness", "equivalent"]) {
      assertKey(vector.expected, key, actual[key]);
    }
  }
});

test("same projection position with changed fingerprint is a conflict", () => {
  const client = new DurableClient(transport());
  client.observeProjection(projection(1, ["a"]));
  assert.throws(
    () =>
      client.observeProjection({
        ...projection(1, ["changed"]),
        projection_fingerprint: "changed",
      }),
    /conflicting durable projection/,
  );
  assert.throws(() =>
    client.observeProjection({ ...projection(2, ["b"]), may_authorize_transition: true }),
  );
  assert.throws(() =>
    client.observeProjection({ ...projection(2, ["b"]), completeness: "latest_state_only" }),
  );
});

test("binding declares exactly the Client durable tier", () => {
  assert.deepEqual(DURABLE_CAPABILITIES, {
    core: true,
    client: true,
    durable_host: false,
    distributed_host: false,
    accelerated_host: false,
  });
});
