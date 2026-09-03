import assert from "node:assert/strict";
import test from "node:test";

import { AsyncContext } from "../src/reactive-async.js";
import { Context } from "../src/reactive.js";
import { ThreadSafeContext } from "../src/thread-safe.js";
import { LatestDurableProjectionCore } from "../src/latest-durable-projection-core.js";
import {
  AsyncLatestDurableProjection,
  LatestDurableProjection,
  ThreadSafeLatestDurableProjection,
} from "../src/latest-durable-projection.js";
import { assertBlock } from "./support/assert-key.js";
import { recordScenario } from "./support/scenario.js";
import { loadFixture } from "./spec-corpus.cjs";

const fixture = loadFixture("egress", "latest_durable_projection.json");

function runOperation(target, operation) {
  switch (operation.type) {
    case "upsert_desired":
      return target.upsertDesired(operation.key, operation.epoch, operation.value);
    case "claim":
      return target.claim(operation.key, operation.generation);
    case "ack_applied":
      return target.ackApplied(operation.key, operation.generation, operation.epoch);
    case "fail_retryable":
      return target.failRetryable(operation.key, operation.generation, operation.epoch);
    case "reconnect":
      return target.reconnect(operation.generation);
    default:
      throw new Error(`unknown latest-durable operation ${operation.type}`);
  }
}

function wireOutcome(operation, outcome) {
  const kindKey = {
    upsert_desired: "upsert",
    claim: "claim",
    ack_applied: "ack",
    fail_retryable: "failure",
    reconnect: "reconnect",
  }[operation.type];
  const result = { [kindKey]: outcome.kind };
  if (outcome.envelope !== undefined) result.envelope = outcome.envelope;
  if (outcome.current !== undefined) result.current = outcome.current;
  if (outcome.durableThrough !== undefined) result.durable_through = outcome.durableThrough;
  if (outcome.generation !== undefined) result.generation = outcome.generation;
  if (outcome.requeued !== undefined) result.requeued = outcome.requeued;
  if (outcome.superseded !== undefined) result.superseded = outcome.superseded;
  return result;
}

function wireSnapshot(snapshot) {
  return {
    generation: snapshot.generation,
    entries: snapshot.entries.map((entry) => ({
      key: entry.key,
      desired: entry.desired,
      inflight: entry.inflight,
      durable_through: entry.durableThrough,
    })),
  };
}

const families = [
  {
    name: "core",
    create: (generation) => {
      const projection = new LatestDurableProjectionCore(generation);
      return { projection, snapshot: () => projection.snapshot() };
    },
  },
  {
    name: "sync reactive",
    create: (generation) => {
      const ctx = new Context();
      const projection = new LatestDurableProjection(ctx, generation);
      return { projection, snapshot: () => ctx.get(projection.snapshotState) };
    },
  },
  {
    name: "thread-safe reactive",
    create: (generation) => {
      const ctx = new ThreadSafeContext();
      const projection = new ThreadSafeLatestDurableProjection(ctx, generation);
      return { projection, snapshot: () => ctx.get(projection.snapshotState) };
    },
  },
  {
    name: "async reactive",
    create: (generation) => {
      const ctx = new AsyncContext();
      const projection = new AsyncLatestDurableProjection(ctx, generation);
      return { projection, snapshot: () => ctx.getAsync(projection.snapshotState) };
    },
  },
];

for (const family of families) {
  test(`${family.name} replays LatestDurableProjectionCore conformance`, async () => {
    let steps = 0;
    for (const scenario of fixture.scenarios) {
      recordScenario(scenario);
      const target = family.create(scenario.generation);
      for (const step of scenario.steps) {
        const outcome = runOperation(target.projection, step.op);
        assert.deepEqual(wireOutcome(step.op, outcome), step.returns, `${scenario.id}: outcome`);
        assertBlock(step.expected, wireSnapshot(await target.snapshot()), `${scenario.id}: state`);
        steps += 1;
      }
    }
    assert.ok(steps > 0);
  });
}

test("the latest durable core exposes all rejection and retry outcomes", () => {
  const projection = new LatestDurableProjectionCore(3);
  assert.equal(projection.claim("doc", 2).kind, "stale_generation");
  assert.equal(projection.upsertDesired("doc", 2, "B").kind, "accepted");
  assert.equal(projection.upsertDesired("doc", 2, "B").kind, "unchanged");
  assert.equal(projection.upsertDesired("doc", 2, "different").kind, "epoch_conflict");
  assert.equal(projection.upsertDesired("doc", 1, "A").kind, "stale_epoch");
  assert.equal(projection.claim("doc", 3).kind, "claimed");
  assert.equal(projection.ackApplied("doc", 3, 99).kind, "unknown_epoch");
  assert.equal(projection.failRetryable("doc", 3, 2).kind, "pending");
  assert.equal(projection.claim("doc", 3).kind, "claimed");
  assert.equal(projection.ackApplied("doc", 3, 2).kind, "advanced");
  assert.equal(projection.upsertDesired("doc", 2, "B").kind, "already_durable");
  assert.equal(projection.ackApplied("doc", 3, 2).kind, "unchanged");
  assert.equal(projection.reconnect(2).kind, "stale_generation");
  assert.equal(projection.reconnect(3).kind, "unchanged");
});
