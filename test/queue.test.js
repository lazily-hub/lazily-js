import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { QueueCell, QueuePopError, QueuePushError, VecDequeStorage } from "../src/queue.js";

const here = dirname(fileURLToPath(import.meta.url));
const specCollections = join(here, "..", "..", "lazily-spec", "conformance", "collections");

function loadFixture(name) {
  const path = join(specCollections, name);
  assert.ok(existsSync(path), `missing spec fixture ${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

// ---------------------------------------------------------------------------
// Fixture-driven conformance — replay every queuecell_*.json step, asserting
// observable state + the per-reader-kind invalidation matrix.
// ---------------------------------------------------------------------------

function buildInitial(initial) {
  return new QueueCell({
    elements: initial.elements ?? [],
    capacity: initial.capacity ?? null,
    closed: Boolean(initial.closed),
  });
}

function assertState(q, expected) {
  if (Array.isArray(expected.elements)) {
    assert.deepEqual(q.elements(), expected.elements, "elements mismatch");
  }
  if ("head" in expected) {
    assert.equal(q.head(), expected.head, "head mismatch");
  }
  if ("len" in expected) {
    assert.equal(q.len(), expected.len, "len mismatch");
  }
  if ("is_empty" in expected) {
    assert.equal(q.isEmpty(), expected.is_empty, "is_empty mismatch");
  }
  if ("is_full" in expected) {
    assert.equal(q.isFull(), expected.is_full, "is_full mismatch");
  }
  if ("closed" in expected) {
    assert.equal(q.isClosed(), expected.closed, "closed mismatch");
  }
}

function runFixture(fixture) {
  const q = buildInitial(fixture.initial);
  for (let i = 0; i < fixture.steps.length; i++) {
    const step = fixture.steps[i];
    const op = step.op;
    let result;

    switch (op.type) {
      case "push":
        result = q.tryPush(op.value);
        assert.equal(result.returns, null, `step ${i}: push should succeed`);
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
        // MPSC: multiple producers push inside one logical batch. The pure-logic
        // shell reports each push's own invalidation; in a live reactive graph
        // the caller groups them inside a Context.batch. Here we collapse the
        // batch into the union of per-push invalidations and assert the
        // end-state (the fixture's expected invalidates reflects the net change
        // across the whole batch).
        const acc = { head: false, len: false, is_empty: false, is_full: false, closed: false };
        for (const inner of op.ops) {
          assert.equal(inner.type, "push", "batch currently only wraps pushes");
          const r = q.tryPush(inner.value);
          for (const k of Object.keys(acc)) {
            if (r.invalidates[k]) {
              acc[k] = true;
            }
          }
        }
        result = { returns: null, invalidates: acc };
        break;
      }
      default:
        throw new Error(`unknown queue op type: ${op.type}`);
    }

    // Assert observable state.
    assertState(q, step.expected);

    // Assert the `returns` value (element or error label), if declared.
    if ("returns" in step) {
      assert.equal(result.returns, step.returns, `step ${i}: returns mismatch`);
    }

    // Assert the per-reader-kind invalidation matrix. A reader kind explicitly
    // present in the fixture's `invalidates` is asserted; absent kinds are not
    // asserted (fixtures that focus on one reader kind only declare that one).
    const invalidates = step.expected.invalidates ?? {};
    for (const kind of Object.keys(invalidates)) {
      assert.equal(
        result.invalidates[kind],
        invalidates[kind],
        `step ${i}: invalidates.${kind}`,
      );
    }
  }
}

test("queue conformance: queuecell_spsc_push_pop.json", () => {
  runFixture(loadFixture("queuecell_spsc_push_pop.json"));
});

test("queue conformance: queuecell_popped_head_observation.json", () => {
  runFixture(loadFixture("queuecell_popped_head_observation.json"));
});

test("queue conformance: queuecell_mpsc_multi_writer.json", () => {
  runFixture(loadFixture("queuecell_mpsc_multi_writer.json"));
});

test("queue conformance: queuecell_bounded_backpressure.json", () => {
  runFixture(loadFixture("queuecell_bounded_backpressure.json"));
});

test("queue conformance: queuecell_closure_lifecycle.json", () => {
  runFixture(loadFixture("queuecell_closure_lifecycle.json"));
});

// ---------------------------------------------------------------------------
// Unit tests — direct coverage of the storage adapter seam + edge cases.
// ---------------------------------------------------------------------------

test("VecDequeStorage: SPSC total FIFO", () => {
  const s = new VecDequeStorage();
  assert.equal(s.tryPush("a"), null);
  assert.equal(s.tryPush("b"), null);
  assert.equal(s.peek(), "a");
  assert.equal(s.len(), 2);
  assert.equal(s.tryPop(), "a");
  assert.equal(s.tryPop(), "b");
  assert.equal(s.tryPop(), QueuePopError.Empty);
  assert.equal(s.peek(), null);
});

test("VecDequeStorage: bounded reject-at-capacity", () => {
  const s = new VecDequeStorage({ capacity: 2 });
  assert.equal(s.capacity(), 2);
  assert.equal(s.tryPush(1), null);
  assert.equal(s.tryPush(2), null);
  assert.equal(s.tryPush(3), QueuePushError.Full);
  assert.equal(s.tryPop(), 1);
  assert.equal(s.tryPush(3), null);
  assert.equal(s.tryPop(), 2);
  assert.equal(s.tryPop(), 3);
});

test("VecDequeStorage: zero capacity is rejected", () => {
  assert.throws(() => new VecDequeStorage({ capacity: 0 }), RangeError);
});

test("QueueCell: closure drains then Closed-distinct-from-Empty", () => {
  const q = new QueueCell();
  assert.deepEqual(q.tryPush("a"), {
    returns: null,
    invalidates: { head: true, len: true, is_empty: true, is_full: false, closed: false },
  });
  // Second push to non-empty: head NOT invalidated (reader-kind independence).
  assert.deepEqual(q.tryPush("b").invalidates, {
    head: false,
    len: true,
    is_empty: false,
    is_full: false,
    closed: false,
  });

  // close → only `closed` reader invalidated.
  assert.deepEqual(q.close().invalidates, {
    head: false,
    len: false,
    is_empty: false,
    is_full: false,
    closed: true,
  });

  // push on closed is an error, no invalidation.
  const rejected = q.tryPush("c");
  assert.equal(rejected.returns, QueuePushError.Closed);
  assert.deepEqual(rejected.invalidates, {
    head: false,
    len: false,
    is_empty: false,
    is_full: false,
    closed: false,
  });

  // pop on closed+non-empty drains.
  assert.equal(q.tryPop().returns, "a");
  assert.equal(q.tryPop().returns, "b");
  // pop on closed+empty returns Closed (distinct from Empty).
  assert.equal(q.tryPop().returns, QueuePopError.Closed);

  // idempotent close — no-op, no invalidation.
  assert.deepEqual(q.close().invalidates, {
    head: false,
    len: false,
    is_empty: false,
    is_full: false,
    closed: false,
  });
});

test("QueueCell: bounded backpressure flips is_full both ways", () => {
  const q = new QueueCell({ capacity: 1 });
  assert.equal(q.isFull(), false);

  const r1 = q.tryPush(1);
  assert.equal(r1.invalidates.is_full, true, "push to capacity flips is_full true");
  assert.equal(q.isFull(), true);

  // push at capacity → Full, no invalidation.
  const full = q.tryPush(2);
  assert.equal(full.returns, QueuePushError.Full);
  assert.equal(full.invalidates.is_full, false);

  // pop off capacity → is_full flips false (the backpressure recovery signal).
  const pop = q.tryPop();
  assert.equal(pop.returns, 1);
  assert.equal(pop.invalidates.is_full, true, "pop off capacity flips is_full false");
  assert.equal(q.isFull(), false);
});

test("QueueCell: pluggable storage via duck-typed backend", () => {
  // A minimal custom bounded backend proving the QueueStorage adapter seam works.
  class BoundedRing {
    constructor(cap) {
      this.buf = [];
      this.cap = cap;
      this.closed = false;
    }
    tryPush(v) {
      if (this.closed) return QueuePushError.Closed;
      if (this.buf.length >= this.cap) return QueuePushError.Full;
      this.buf.push(v);
      return null;
    }
    tryPop() {
      if (this.buf.length === 0) {
        return this.closed ? QueuePopError.Closed : QueuePopError.Empty;
      }
      return this.buf.shift();
    }
    peek() {
      return this.buf.length === 0 ? null : this.buf[0];
    }
    len() {
      return this.buf.length;
    }
    capacity() {
      return this.cap;
    }
    isClosed() {
      return this.closed;
    }
    close() {
      this.closed = true;
    }
    snapshot() {
      return { elements: [...this.buf], capacity: this.cap, closed: this.closed };
    }
  }

  const q = new QueueCell({}, new BoundedRing(2));
  assert.equal(q.capacity(), 2);
  q.tryPush(1);
  q.tryPush(2);
  assert.equal(q.isFull(), true);
  assert.equal(q.tryPush(3).returns, QueuePushError.Full);
  assert.equal(q.tryPop().returns, 1);
  assert.equal(q.isFull(), false);
  assert.equal(q.len(), 1);
  assert.equal(q.head(), 2);
  assert.deepEqual(q.elements(), [2]);
});

test("QueueCell: snapshot round-trip via VecDequeStorage.from", () => {
  const q1 = new QueueCell({ elements: ["a", "b", "c"], capacity: null });
  const snap = q1.elements();
  assert.deepEqual(snap, ["a", "b", "c"]);
  const s2 = VecDequeStorage.from({ elements: snap, capacity: null });
  const q2 = new QueueCell({}, s2);
  assert.deepEqual(q2.elements(), ["a", "b", "c"]);
  assert.equal(q2.tryPop().returns, "a");
});

test("QueueCell: reader-kind independence — push to non-empty spares head", () => {
  const q = new QueueCell();
  q.tryPush("a");
  // head is now "a"; pushing more must not invalidate head.
  const r2 = q.tryPush("b");
  assert.equal(r2.invalidates.head, false, "push to non-empty must not invalidate head");
  assert.equal(r2.invalidates.len, true, "len always changes on push");
  const r3 = q.tryPush("c");
  assert.equal(r3.invalidates.head, false);
  // pop changes head → invalidated.
  const pop1 = q.tryPop();
  assert.equal(pop1.returns, "a");
  assert.equal(pop1.invalidates.head, true, "pop always changes head");
});
