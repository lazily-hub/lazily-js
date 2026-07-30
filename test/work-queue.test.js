import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertKey, assertKeyWith } from "./support/assert-key.js";

import { WorkQueueCell } from "../src/queue.js";
import { Context } from "../src/reactive.js";

const here = dirname(fileURLToPath(import.meta.url));
const specCollections = join(here, "..", "..", "lazily-spec", "conformance", "collections");

function loadFixture(name) {
  const path = join(specCollections, name);
  assert.ok(existsSync(path), `missing spec fixture ${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function runFixture(fixture) {
  const ctx = new Context();
  const queue = new WorkQueueCell(ctx, fixture.config);
  const probes = {};
  for (const [kind, read] of Object.entries({
    pending_len: (cx) => queue.pendingLen(cx),
    is_empty: (cx) => queue.isEmpty(cx),
    in_flight_len: (cx) => queue.inFlightLen(cx),
    dead_letter_len: (cx) => queue.deadLetterLen(cx),
  })) {
    const probe = { count: 0 };
    probe.node = ctx.computed((cx) => {
      probe.count += 1;
      return read(cx);
    });
    ctx.get(probe.node);
    probes[kind] = probe;
  }
  for (let i = 0; i < fixture.steps.length; i++) {
    const step = fixture.steps[i];
    const op = step.op;
    const countsBefore = Object.fromEntries(
      Object.entries(probes).map(([kind, probe]) => [kind, probe.count]),
    );
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
    for (const probe of Object.values(probes)) ctx.get(probe.node);
    assertKeyWith(step.expected, "invalidates", (invalidates) => {
      assert.deepEqual(result.invalidates, invalidates, `step ${i}: invalidates`);
      for (const [kind, invalidated] of Object.entries(invalidates)) {
        assert.equal(
          probes[kind].count > countsBefore[kind],
          invalidated,
          `step ${i}: reactive reader ${kind} recomputation`,
        );
      }
    });
    assertKey(step.expected, "pending", queue.pendingItems(), `step ${i}: pending`);
    assertKey(step.expected, "in_flight", queue.inFlightDeliveries(), `step ${i}: in_flight`);
    assertKey(
      step.expected,
      "dead_letters",
      queue.deadLetterItems(),
      `step ${i}: dead_letters`,
    );
    assertKey(
      step.expected,
      "reads",
      {
        pending_len: queue.pendingLen(),
        is_empty: queue.isEmpty(),
        in_flight_len: queue.inFlightLen(),
        dead_letter_len: queue.deadLetterLen(),
      },
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
  assert.throws(
    () => new WorkQueueCell(new Context(), { visibility_timeout: 0, max_deliveries: 1 }),
    RangeError,
  );
  assert.throws(
    () => new WorkQueueCell(new Context(), { visibility_timeout: 1, max_deliveries: 0 }),
    RangeError,
  );
});
