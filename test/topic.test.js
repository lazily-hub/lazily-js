import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { assertKey, subBlock } from "./support/assert-key.js";

import { TopicCell, TopicDurability } from "../src/queue.js";
import { Context } from "../src/reactive.js";

import { specPath } from "./spec-corpus.cjs";

const specCollections = specPath("collections");

function loadFixture(name) {
  const path = join(specCollections, name);
  assert.ok(existsSync(path), `missing spec fixture ${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function runFixture(fixture) {
  const ctx = new Context();
  const topic = new TopicCell(ctx, fixture.initial);
  const probes = new Map();
  function probeFor(id) {
    let probe = probes.get(id);
    if (probe === undefined) {
      probe = { count: 0 };
      probe.node = ctx.computed((cx) => {
        probe.count += 1;
        return topic.readStream(id, cx);
      });
      ctx.get(probe.node);
      probes.set(id, probe);
    }
    return probe;
  }
  for (let i = 0; i < fixture.steps.length; i++) {
    const step = fixture.steps[i];
    const op = step.op;
    for (const id of Object.keys(step.expected.invalidates ?? {})) probeFor(id);
    const countsBefore = new Map(Array.from(probes, ([id, probe]) => [id, probe.count]));
    let result;
    switch (op.type) {
      case "publish":
        result = topic.publish(op.value);
        break;
      case "advance":
        result = topic.advance(op.subscriber);
        break;
      case "subscribe":
        result = topic.subscribe(op.subscriber, op.durability);
        break;
      case "disconnect":
        result = topic.disconnect(op.subscriber);
        break;
      case "reconnect":
        result = topic.reconnect(op.subscriber);
        break;
      case "restart":
        result = topic.restart(op.subscriber);
        break;
      case "gc":
        result = topic.gc();
        break;
      default:
        throw new Error(`unknown TopicCell op: ${op.type}`);
    }

    const expected = step.expected;
    assertKey(expected, "base_offset", topic.baseOffset(), `step ${i}: base_offset`);
    assertKey(expected, "elements", topic.elements(), `step ${i}: elements`);
    assertKey(expected, "subscriptions", topic.subscriptions(), `step ${i}: subscriptions`);
    if ("reads" in expected) {
      // Descended (#lzsubblockkeyset): the child tracker owns every subscriber
      // the fixture lists, so one added upstream is unconsumed rather than
      // skipped by a loop that visits only today's keys.
      const reads = subBlock(expected, "reads");
      for (const id of Object.keys(reads)) {
        assertKey(reads, id, topic.readStream(id), `step ${i}: reads.${id}`);
      }
    }
    for (const probe of probes.values()) ctx.get(probe.node);
    // The whole-object equality IS the key-set check, in both directions
    // (#lzsubblockkeyset): a subscriber the fixture adds and this report omits,
    // and one the report grows that the fixture omits, each fail here. The probe
    // loop below then reads the same object the comparison consumed.
    const invalidates = assertKey(
      expected,
      "invalidates",
      result.invalidates,
      `step ${i}: invalidates`,
    );
    for (const [id, invalidated] of Object.entries(invalidates)) {
      assert.equal(
        probeFor(id).count > countsBefore.get(id),
        invalidated,
        `step ${i}: reactive subscriber reader ${id} recomputation`,
      );
    }
    if ("returns" in step) assert.equal(result.returns, step.returns, `step ${i}: returns`);
  }
}

test("TopicCell conformance: broadcast cursor isolation", () => {
  runFixture(loadFixture("topiccell_broadcast_cursor_isolation.json"));
});

test("TopicCell conformance: durable replay and GC", () => {
  runFixture(loadFixture("topiccell_durable_replay_gc.json"));
});

test("TopicCell conformance: ephemeral lifecycle", () => {
  runFixture(loadFixture("topiccell_ephemeral_lifecycle.json"));
});

test("TopicCell conformance: offline and tail bounds", () => {
  runFixture(loadFixture("topiccell_offline_tail_bounds.json"));
});

test("TopicCell snapshot round-trip preserves durable cursors", () => {
  const ctx = new Context();
  const topic = new TopicCell(ctx);
  topic.subscribe("durable", TopicDurability.Durable);
  topic.publish("a");
  topic.disconnect("durable");
  const restored = TopicCell.from(new Context(), topic.snapshot());
  assert.equal(restored.subscription("durable").cursor, 0);
  restored.reconnect("durable");
  assert.deepEqual(restored.readStream("durable"), ["a"]);
});
