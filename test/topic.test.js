import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { TopicCell, TopicDurability } from "../src/queue.js";

const here = dirname(fileURLToPath(import.meta.url));
const specCollections = join(here, "..", "..", "lazily-spec", "conformance", "collections");

function loadFixture(name) {
  const path = join(specCollections, name);
  assert.ok(existsSync(path), `missing spec fixture ${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function runFixture(fixture) {
  const topic = new TopicCell(fixture.initial);
  for (let i = 0; i < fixture.steps.length; i++) {
    const step = fixture.steps[i];
    const op = step.op;
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
    assert.equal(topic.baseOffset(), expected.base_offset, `step ${i}: base_offset`);
    assert.deepEqual(topic.elements(), expected.elements, `step ${i}: elements`);
    assert.deepEqual(topic.subscriptions(), expected.subscriptions, `step ${i}: subscriptions`);
    for (const [id, stream] of Object.entries(expected.reads ?? {})) {
      assert.deepEqual(topic.readStream(id), stream, `step ${i}: reads.${id}`);
    }
    assert.deepEqual(result.invalidates, expected.invalidates, `step ${i}: invalidates`);
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
  const topic = new TopicCell();
  topic.subscribe("durable", TopicDurability.Durable);
  topic.publish("a");
  topic.disconnect("durable");
  const restored = TopicCell.from(topic.snapshot());
  assert.equal(restored.subscription("durable").cursor, 0);
  restored.reconnect("durable");
  assert.deepEqual(restored.readStream("durable"), ["a"]);
});
