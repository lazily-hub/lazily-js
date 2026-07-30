import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertKey, assertKeyWith } from "./support/assert-key.js";

import { TopicCell, TopicDurability } from "../src/queue.js";
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
      assertKeyWith(expected, "reads", (reads) => {
        for (const [id, stream] of Object.entries(reads)) {
          assert.deepEqual(topic.readStream(id), stream, `step ${i}: reads.${id}`);
        }
      });
    }
    for (const probe of probes.values()) ctx.get(probe.node);
    assertKeyWith(expected, "invalidates", (invalidates) => {
      assert.deepEqual(result.invalidates, invalidates, `step ${i}: invalidates`);
      for (const [id, invalidated] of Object.entries(invalidates)) {
        assert.equal(
          probeFor(id).count > countsBefore.get(id),
          invalidated,
          `step ${i}: reactive subscriber reader ${id} recomputation`,
        );
      }
    });
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
