import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { WorkQueueCell } from "../src/queue.js";

const here = dirname(fileURLToPath(import.meta.url));
const specCollections = join(here, "..", "..", "lazily-spec", "conformance", "collections");

function loadFixture(name) {
  const path = join(specCollections, name);
  assert.ok(existsSync(path), `missing spec fixture ${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function runFixture(fixture) {
  const queue = new WorkQueueCell(fixture.config);
  for (let i = 0; i < fixture.steps.length; i++) {
    const step = fixture.steps[i];
    const op = step.op;
    let result;
    switch (op.type) {
      case "push":
        result = queue.push(op.value);
        break;
      case "claim":
        result = queue.claim(op.worker, op.now);
        break;
      case "ack":
        result = queue.ack(op.worker, op.delivery_id);
        break;
      case "nack":
        result = queue.nack(op.worker, op.delivery_id);
        break;
      case "reap_expired":
        result = queue.reapExpired(op.now);
        break;
      default:
        throw new Error(`unknown WorkQueueCell op: ${op.type}`);
    }

    assert.deepEqual(result.returns, step.returns, `step ${i}: returns`);
    assert.deepEqual(result.invalidates, step.expected.invalidates, `step ${i}: invalidates`);
    assert.deepEqual(queue.pendingItems(), step.expected.pending, `step ${i}: pending`);
    assert.deepEqual(queue.inFlightDeliveries(), step.expected.in_flight, `step ${i}: in_flight`);
    assert.deepEqual(queue.deadLetterItems(), step.expected.dead_letters, `step ${i}: dead_letters`);
    assert.deepEqual(
      {
        pending_len: queue.pendingLen(),
        is_empty: queue.isEmpty(),
        in_flight_len: queue.inFlightLen(),
        dead_letter_len: queue.deadLetterLen(),
      },
      step.expected.reads,
      `step ${i}: reads`,
    );
  }
}

test("WorkQueueCell conformance: exclusive competing delivery", () => {
  runFixture(loadFixture("workqueue_competing_delivery.json"));
});

test("WorkQueueCell conformance: lease expiry and DLQ", () => {
  runFixture(loadFixture("workqueue_lease_deadletter.json"));
});

test("WorkQueueCell validates lifecycle configuration", () => {
  assert.throws(() => new WorkQueueCell({ visibility_timeout: 0, max_deliveries: 1 }), RangeError);
  assert.throws(() => new WorkQueueCell({ visibility_timeout: 1, max_deliveries: 0 }), RangeError);
});
