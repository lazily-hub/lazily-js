// The queue family replayed against ALL THREE execution flavors.
//
// Until `#lzqueuefamilyflavors` this file was a *ledger* rather than a replay:
// lazily-js shipped only the single-threaded flavor, so it greped `src/` to
// prove the other two were genuinely absent instead of quietly unscored. Both
// thread-safe and async flavors now exist, so the ledger's own instruction
// applies — flip the flags AND drive the corpus against every flavor.
//
// Three things keep this from reporting green while testing nothing:
//
//  1. Invalidation is measured by RECOMPUTE COUNT inside a reader's own compute
//     body, and asserted in BOTH directions. A step whose fixture says
//     `invalidates.head: false` FAILS if the flavor invalidated anyway, so
//     over-invalidation is as visible as under-invalidation.
//  2. Every replay returns its step count and each flavor asserts it equals the
//     corpus total. An absence guard proves the fixtures exist; only a positive
//     count proves this process opened and drove them.
//  3. The ledger greps `src/` in BOTH directions — a row cannot claim a flavor
//     whose class does not exist, and a class cannot exist unreplayed.
//
// Mirrors lazily-rs/tests/queue_family_conformance.rs.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Context } from "../src/reactive.js";
import { AsyncContext } from "../src/reactive-async.js";
import { ThreadSafeContext } from "../src/thread-safe.js";
import { QueueCell, TopicCell, WorkQueueCell } from "../src/queue.js";
import {
  ThreadSafeQueueCell,
  ThreadSafeTopicCell,
  ThreadSafeWorkQueueCell,
} from "../src/thread-safe-queue.js";
import { AsyncQueueCell, AsyncTopicCell, AsyncWorkQueueCell } from "../src/async-queue.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src");

const QUEUE_FIXTURES = [
  "queuecell_spsc_push_pop.json",
  "queuecell_popped_head_observation.json",
  "queuecell_mpsc_multi_writer.json",
  "queuecell_bounded_backpressure.json",
  "queuecell_closure_lifecycle.json",
];

const TOPIC_FIXTURES = [
  "topiccell_broadcast_cursor_isolation.json",
  "topiccell_durable_replay_gc.json",
  "topiccell_ephemeral_lifecycle.json",
  "topiccell_offline_tail_bounds.json",
];

const WORK_QUEUE_FIXTURES = [
  "workqueue_competing_delivery.json",
  "workqueue_lease_deadletter.json",
];

// Pinned so a fixture losing steps upstream cannot silently shrink the gate.
// Recomputed from the corpus below and asserted against these.
const EXPECTED_STEPS = { queue: 31, topic: 29, work_queue: 18 };
const EXPECTED_TOTAL_STEPS =
  EXPECTED_STEPS.queue + EXPECTED_STEPS.topic + EXPECTED_STEPS.work_queue;

// The marker is grepped, not imported: a ledger you cannot write until the work
// is done is no ledger at all.
const LEDGER = [
  { primitive: "QueueCell", flavor: "single-threaded", marker: "class QueueCell", shipped: true },
  {
    primitive: "QueueCell",
    flavor: "thread-safe",
    marker: "class ThreadSafeQueueCell",
    shipped: true,
  },
  { primitive: "QueueCell", flavor: "async", marker: "class AsyncQueueCell", shipped: true },
  { primitive: "TopicCell", flavor: "single-threaded", marker: "class TopicCell", shipped: true },
  {
    primitive: "TopicCell",
    flavor: "thread-safe",
    marker: "class ThreadSafeTopicCell",
    shipped: true,
  },
  { primitive: "TopicCell", flavor: "async", marker: "class AsyncTopicCell", shipped: true },
  {
    primitive: "WorkQueueCell",
    flavor: "single-threaded",
    marker: "class WorkQueueCell",
    shipped: true,
  },
  {
    primitive: "WorkQueueCell",
    flavor: "thread-safe",
    marker: "class ThreadSafeWorkQueueCell",
    shipped: true,
  },
  {
    primitive: "WorkQueueCell",
    flavor: "async",
    marker: "class AsyncWorkQueueCell",
    shipped: true,
  },
];

function sources() {
  let out = "";
  const stack = [SRC];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        stack.push(path);
      } else if (entry.endsWith(".js")) {
        out += readFileSync(path, "utf8");
      }
    }
  }
  return out;
}

function fixtureDir() {
  for (const candidate of [
    join(here, "..", "..", "lazily-spec", "conformance", "collections"),
    join(here, "conformance", "collections"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function loadFixture(name) {
  const dir = fixtureDir();
  assert.ok(dir, "canonical collections fixtures not found — cannot prove the corpus was read");
  const path = join(dir, name);
  assert.ok(existsSync(path), `missing spec fixture ${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

// --- flavors ----------------------------------------------------------------
//
// Each flavor exposes the SAME surface to the replay: three constructors and a
// `probe(body)` that returns an async driver yielding the compute-body call
// count. The flavor axis lives here, in the runner — never in the corpus.

class SyncFlavor {
  name = "single-threaded";
  constructor() {
    this.ctx = new Context();
  }
  queue(initial) {
    return new QueueCell(this.ctx, initial);
  }
  topic(initial) {
    return new TopicCell(this.ctx, initial);
  }
  workQueue(config) {
    return new WorkQueueCell(this.ctx, config);
  }
  batch(run) {
    this.ctx.batch(run);
  }
  probe(body) {
    const state = { count: 0 };
    state.node = this.ctx.computed((cx) => {
      state.count += 1;
      return body(cx);
    });
    this.ctx.get(state.node);
    return async () => {
      this.ctx.get(state.node);
      return state.count;
    };
  }
}

class ThreadSafeFlavor {
  name = "thread-safe";
  constructor() {
    this.ctx = new ThreadSafeContext();
  }
  queue(initial) {
    return new ThreadSafeQueueCell(this.ctx, initial);
  }
  topic(initial) {
    return new ThreadSafeTopicCell(this.ctx, initial);
  }
  workQueue(config) {
    return new ThreadSafeWorkQueueCell(this.ctx, config);
  }
  batch(run) {
    this.ctx.batch(run);
  }
  probe(body) {
    const state = { count: 0 };
    state.node = this.ctx.computed((cx) => {
      state.count += 1;
      return body(cx);
    });
    this.ctx.get(state.node);
    return async () => {
      this.ctx.get(state.node);
      return state.count;
    };
  }
}

class AsyncFlavor {
  name = "async";
  constructor() {
    this.ctx = new AsyncContext();
  }
  queue(initial) {
    return new AsyncQueueCell(this.ctx, initial);
  }
  topic(initial) {
    return new AsyncTopicCell(this.ctx, initial);
  }
  workQueue(config) {
    return new AsyncWorkQueueCell(this.ctx, config);
  }
  batch(run) {
    this.ctx.batch(run);
  }
  probe(body) {
    const state = { count: 0 };
    // Reader materialization is the ONE async-coloured obligation here; the
    // admission/ordering algebra above it is not.
    state.node = this.ctx.computedAsync(async (cx) => {
      state.count += 1;
      return await body(cx);
    });
    return async () => {
      await this.ctx.getAsync(state.node);
      return state.count;
    };
  }
}

const FLAVORS = [SyncFlavor, ThreadSafeFlavor, AsyncFlavor];

// --- replays ----------------------------------------------------------------

async function replayQueue(flavor, name) {
  const fixture = loadFixture(name);
  const where = (i) => `${flavor.name} ${name} step ${i}`;
  const initial = fixture.initial ?? {};
  const q = flavor.queue({
    elements: initial.elements ?? [],
    capacity: initial.capacity ?? null,
    closed: Boolean(initial.closed),
  });

  const reads = {
    head: (cx) => q.head(cx),
    len: (cx) => q.len(cx),
    is_empty: (cx) => q.isEmpty(cx),
    is_full: (cx) => q.isFull(cx),
    closed: (cx) => q.isClosed(cx),
  };
  const drivers = {};
  for (const [kind, read] of Object.entries(reads)) {
    drivers[kind] = flavor.probe(read);
    await drivers[kind]();
  }

  const steps = fixture.steps ?? [];
  assert.ok(steps.length > 0, `${flavor.name} ${name}: no steps — a vacuous replay reports green`);

  for (const [i, step] of steps.entries()) {
    const before = {};
    for (const [kind, drive] of Object.entries(drivers)) before[kind] = await drive();

    const op = step.op;
    let result;
    switch (op.type) {
      case "push":
        result = q.tryPush(op.value);
        assert.equal(result.returns, null, `${where(i)}: push should succeed`);
        break;
      case "try_push":
        result = q.tryPush(op.value);
        break;
      case "pop":
      case "try_pop":
        result = q.tryPop();
        break;
      case "close":
        result = q.close();
        break;
      case "batch": {
        // MPSC: multiple producers push inside one logical batch. The queue
        // reports each push's own matrix while the graph defers its flush;
        // collapse them into their union, which is the net change the fixture
        // declares for the batch.
        const acc = { head: false, len: false, is_empty: false, is_full: false, closed: false };
        flavor.batch(() => {
          for (const inner of op.ops) {
            assert.equal(inner.type, "push", `${where(i)}: batch currently only wraps pushes`);
            const r = q.tryPush(inner.value);
            for (const k of Object.keys(acc)) if (r.invalidates[k]) acc[k] = true;
          }
        });
        result = { returns: null, invalidates: acc };
        break;
      }
      default:
        throw new Error(`unknown queue op type: ${op.type}`);
    }

    const expected = step.expected;
    if (Array.isArray(expected.elements)) {
      assert.deepEqual(q.elements(), expected.elements, `${where(i)}: elements`);
    }
    if ("head" in expected) assert.equal(await q.head(), expected.head, `${where(i)}: head`);
    if ("len" in expected) assert.equal(await q.len(), expected.len, `${where(i)}: len`);
    if ("is_empty" in expected) {
      assert.equal(await q.isEmpty(), expected.is_empty, `${where(i)}: is_empty`);
    }
    if ("is_full" in expected) {
      assert.equal(await q.isFull(), expected.is_full, `${where(i)}: is_full`);
    }
    if ("closed" in expected) {
      assert.equal(await q.isClosed(), expected.closed, `${where(i)}: closed`);
    }
    if ("returns" in step) {
      assert.equal(result.returns, step.returns, `${where(i)}: returns`);
    }

    // Per reader kind, in BOTH directions: the reported matrix AND the graph.
    const invalidates = expected.invalidates ?? {};
    const after = {};
    for (const [kind, drive] of Object.entries(drivers)) after[kind] = await drive();
    for (const kind of Object.keys(invalidates)) {
      assert.equal(result.invalidates[kind], invalidates[kind], `${where(i)}: invalidates.${kind}`);
      assert.equal(
        after[kind] > before[kind],
        invalidates[kind],
        `${where(i)}: reader ${kind} recomputation (want ${invalidates[kind]})`,
      );
    }
  }
  return steps.length;
}

async function replayTopic(flavor, name) {
  const fixture = loadFixture(name);
  const where = (i) => `${flavor.name} ${name} step ${i}`;
  const topic = flavor.topic(fixture.initial ?? {});

  const drivers = new Map();
  const driverFor = async (id) => {
    let drive = drivers.get(id);
    if (drive === undefined) {
      drive = flavor.probe((cx) => topic.readStream(id, cx));
      await drive();
      drivers.set(id, drive);
    }
    return drive;
  };

  const steps = fixture.steps ?? [];
  assert.ok(steps.length > 0, `${flavor.name} ${name}: no steps — a vacuous replay reports green`);

  for (const [i, step] of steps.entries()) {
    for (const id of Object.keys(step.expected.invalidates ?? {})) await driverFor(id);
    const before = new Map();
    for (const [id, drive] of drivers) before.set(id, await drive());

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
    assert.equal(topic.baseOffset(), expected.base_offset, `${where(i)}: base_offset`);
    assert.deepEqual(topic.elements(), expected.elements, `${where(i)}: elements`);
    assert.deepEqual(topic.subscriptions(), expected.subscriptions, `${where(i)}: subscriptions`);
    for (const [id, stream] of Object.entries(expected.reads ?? {})) {
      assert.deepEqual(await topic.readStream(id), stream, `${where(i)}: reads.${id}`);
    }
    assert.deepEqual(result.invalidates, expected.invalidates, `${where(i)}: invalidates`);
    if ("returns" in step) assert.equal(result.returns, step.returns, `${where(i)}: returns`);

    const after = new Map();
    for (const [id, drive] of drivers) after.set(id, await drive());
    for (const [id, invalidated] of Object.entries(expected.invalidates ?? {})) {
      assert.equal(
        after.get(id) > before.get(id),
        invalidated,
        `${where(i)}: subscriber reader ${id} recomputation (want ${invalidated})`,
      );
    }
  }
  return steps.length;
}

async function replayWorkQueue(flavor, name) {
  const fixture = loadFixture(name);
  const where = (i) => `${flavor.name} ${name} step ${i}`;
  assert.ok(
    fixture.config,
    `${name}: fixture carries no lease config — every binding would hardcode it out of band`,
  );
  const queue = flavor.workQueue(fixture.config);

  const reads = {
    pending_len: (cx) => queue.pendingLen(cx),
    is_empty: (cx) => queue.isEmpty(cx),
    in_flight_len: (cx) => queue.inFlightLen(cx),
    dead_letter_len: (cx) => queue.deadLetterLen(cx),
  };
  const drivers = {};
  for (const [kind, read] of Object.entries(reads)) {
    drivers[kind] = flavor.probe(read);
    await drivers[kind]();
  }

  const steps = fixture.steps ?? [];
  assert.ok(steps.length > 0, `${flavor.name} ${name}: no steps — a vacuous replay reports green`);

  for (const [i, step] of steps.entries()) {
    const before = {};
    for (const [kind, drive] of Object.entries(drivers)) before[kind] = await drive();

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

    const expected = step.expected;
    assert.deepEqual(result.returns, step.returns, `${where(i)}: returns`);
    assert.deepEqual(result.invalidates, expected.invalidates, `${where(i)}: invalidates`);
    assert.deepEqual(queue.pendingItems(), expected.pending, `${where(i)}: pending`);
    assert.deepEqual(queue.inFlightDeliveries(), expected.in_flight, `${where(i)}: in_flight`);
    assert.deepEqual(queue.deadLetterItems(), expected.dead_letters, `${where(i)}: dead_letters`);
    assert.deepEqual(
      {
        pending_len: await queue.pendingLen(),
        is_empty: await queue.isEmpty(),
        in_flight_len: await queue.inFlightLen(),
        dead_letter_len: await queue.deadLetterLen(),
      },
      expected.reads,
      `${where(i)}: reads`,
    );

    const after = {};
    for (const [kind, drive] of Object.entries(drivers)) after[kind] = await drive();
    for (const [kind, invalidated] of Object.entries(expected.invalidates)) {
      assert.equal(
        after[kind] > before[kind],
        invalidated,
        `${where(i)}: reader ${kind} recomputation (want ${invalidated})`,
      );
    }
  }
  return steps.length;
}

// --- the gate ---------------------------------------------------------------

for (const FlavorCls of FLAVORS) {
  const flavorName = new FlavorCls().name;

  test(`queue family / ${flavorName}: replays the whole corpus`, async () => {
    let queueSteps = 0;
    for (const name of QUEUE_FIXTURES) {
      queueSteps += await replayQueue(new FlavorCls(), name);
    }
    let topicSteps = 0;
    for (const name of TOPIC_FIXTURES) {
      topicSteps += await replayTopic(new FlavorCls(), name);
    }
    let workSteps = 0;
    for (const name of WORK_QUEUE_FIXTURES) {
      workSteps += await replayWorkQueue(new FlavorCls(), name);
    }

    // Only a positive, exact count proves this process drove the fixtures. An
    // "it exists" guard cannot tell a replay from an open-and-ignore.
    assert.equal(queueSteps, EXPECTED_STEPS.queue, `${flavorName}: QueueCell step count`);
    assert.equal(topicSteps, EXPECTED_STEPS.topic, `${flavorName}: TopicCell step count`);
    assert.equal(workSteps, EXPECTED_STEPS.work_queue, `${flavorName}: WorkQueueCell step count`);
    assert.equal(
      queueSteps + topicSteps + workSteps,
      EXPECTED_TOTAL_STEPS,
      `${flavorName}: total replayed steps`,
    );
  });
}

test("queue family: the corpus really holds the pinned number of steps", () => {
  const count = (names) =>
    names.reduce((acc, name) => acc + (loadFixture(name).steps ?? []).length, 0);
  assert.equal(count(QUEUE_FIXTURES), EXPECTED_STEPS.queue);
  assert.equal(count(TOPIC_FIXTURES), EXPECTED_STEPS.topic);
  assert.equal(count(WORK_QUEUE_FIXTURES), EXPECTED_STEPS.work_queue);
});

test("queue family: the invalidation probe discriminates", async () => {
  // The whole corpus leans on "probe count moved" meaning "the library cleared
  // the node". Pin that the probe can fail: a no-op op must NOT move it, and a
  // real transition must.
  for (const FlavorCls of FLAVORS) {
    const flavor = new FlavorCls();
    const q = flavor.queue({ elements: ["a"], capacity: null, closed: false });
    const drive = flavor.probe((cx) => q.head(cx));
    const base = await drive();

    // A push onto a NON-empty queue leaves head alone — reader-kind independence.
    q.tryPush("b");
    assert.equal(await drive(), base, `${flavor.name}: head recomputed on a push to non-empty`);

    // A pop always advances head.
    q.tryPop();
    assert.ok(
      (await drive()) > base,
      `${flavor.name}: head did NOT recompute on a pop — the probe cannot fail, so every ` +
        "invalidation assertion in this file would be vacuous",
    );
  }
});

test("queue family ledger: every recorded flavor really exists in src/", () => {
  const text = sources();
  assert.ok(text.length > 0, "read no sources from src/; the ledger check would be vacuous");

  for (const { primitive, flavor, marker, shipped } of LEDGER) {
    const defined = text.includes(marker);
    if (shipped) {
      assert.ok(
        defined,
        `${primitive} / ${flavor} is recorded as shipped but "${marker}" is not defined in ` +
          "src/ — the ledger claims coverage this package does not have",
      );
    } else {
      assert.ok(
        !defined,
        `${primitive} / ${flavor} now EXISTS in src/ ("${marker}") but the ledger still ` +
          "records it as unshipped, so the canonical corpus is not being replayed against " +
          "it. Fix: flip shipped AND extend the replay to drive it. Do NOT flip the flag " +
          "alone — that restores the false green this test prevents.",
      );
    }
  }
});

test("queue family ledger: is 3x3 and is not all skips", () => {
  // In a summary line, "skipped" and "passed" are indistinguishable.
  assert.equal(LEDGER.length, 9, "the ledger must cover 3 primitives x 3 flavors");
  assert.ok(
    LEDGER.every((row) => row.shipped),
    "an unshipped row is an unscored gap; flip it only with a replay behind it",
  );
  const flavors = new Set(LEDGER.map((row) => row.flavor));
  const primitives = new Set(LEDGER.map((row) => row.primitive));
  assert.equal(flavors.size, 3, "the ledger must name all three execution flavors");
  assert.equal(primitives.size, 3, "the ledger must name all three queue-family primitives");
  // The replay drives exactly the flavors the ledger names.
  assert.deepEqual(
    [...flavors].sort(),
    FLAVORS.map((F) => new F().name).sort(),
    "a flavor the ledger names is not driven by the replay above (or vice versa)",
  );
});

test("queue family: fixtures nest the matrix under expected, not on the step", () => {
  // lazily-rs's MAP runner once read `invalidates` off the step, so it was
  // always absent and the assertion never ran once. Pin the nesting here.
  let matricesSeen = 0;
  for (const name of [...QUEUE_FIXTURES, ...TOPIC_FIXTURES, ...WORK_QUEUE_FIXTURES]) {
    const fixture = loadFixture(name);
    (fixture.steps ?? []).forEach((step, i) => {
      assert.equal(
        step.invalidates,
        undefined,
        `${name} step ${i}: \`invalidates\` appears at STEP level; runners read ` +
          "expected.invalidates, so a step-level copy is silently ignored",
      );
      assert.ok(step.expected, `${name} step ${i}: no expected block`);
      if (step.expected.invalidates !== undefined) matricesSeen += 1;
    });
  }
  assert.ok(
    matricesSeen > 0,
    "no fixture carried an expected.invalidates matrix — the reader-kind independence " +
      "contract would be unasserted",
  );
});
