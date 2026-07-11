import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "../src/reactive.js";
import { AtomicMutex, ThreadSafeContext } from "../src/thread-safe.js";

// --- AtomicMutex: reentrancy + exclusive execution --------------------------
test("AtomicMutex runs exclusively and is reentrant within a realm", () => {
  const m = new AtomicMutex();
  let order = [];
  const r = m.runExclusive(() => {
    order.push("outer-in");
    const inner = m.runExclusive(() => {
      order.push("inner");
      return 7;
    });
    order.push("outer-out");
    return inner;
  });
  assert.equal(r, 7);
  assert.deepEqual(order, ["outer-in", "inner", "outer-out"]);
});

test("AtomicMutex releases the lock even if fn throws", () => {
  const m = new AtomicMutex();
  assert.throws(() => m.runExclusive(() => {
    throw new Error("boom");
  }), /boom/);
  // Lock must be free again — a subsequent acquire completes.
  assert.equal(m.runExclusive(() => 1), 1);
});

test("AtomicMutex exposes a shareable lock buffer when shared memory is available", () => {
  const m = new AtomicMutex();
  if (typeof SharedArrayBuffer !== "undefined") {
    assert.ok(m.buffer instanceof SharedArrayBuffer);
    // A second mutex attached to the same buffer shares the lock word.
    const m2 = new AtomicMutex(m.buffer);
    assert.equal(m2.buffer, m.buffer);
  } else {
    assert.equal(m.buffer, null);
  }
});

// --- ThreadSafeContext: observational refinement of Context -----------------
test("ThreadSafeContext mirrors single-threaded reactive semantics", () => {
  const ctx = new ThreadSafeContext();
  const a = ctx.cell(2);
  const b = ctx.cell(3);
  const sum = ctx.computed(() => ctx.getCell(a) + ctx.getCell(b));
  assert.equal(ctx.get(sum), 5);
  ctx.setCell(a, 10);
  assert.equal(ctx.get(sum), 13);

  // memo suppresses equal recompute downstream; signal is eager.
  const doubled = ctx.memo(() => ctx.get(sum) * 2);
  assert.equal(ctx.get(doubled), 26);
});

test("ThreadSafeContext.batch coalesces to one invalidation pass (flushBatch ≡ setCell)", () => {
  const ctx = new ThreadSafeContext();
  const c = ctx.cell(0);
  let runs = 0;
  ctx.effect(() => {
    ctx.getCell(c);
    runs += 1;
  });
  assert.equal(runs, 1, "effect runs once on registration");
  ctx.batch(() => {
    ctx.setCell(c, 1);
    ctx.setCell(c, 2);
    ctx.setCell(c, 3);
  });
  assert.equal(ctx.getCell(c), 3);
  assert.equal(runs, 2, "the batch triggers exactly one rerun");
});

test("ThreadSafeContext effect dispose + signal lifecycle", () => {
  const ctx = new ThreadSafeContext();
  const c = ctx.cell(1);
  const sig = ctx.signal(() => ctx.getCell(c) + 1);
  assert.equal(ctx.getSignal(sig), 2);
  ctx.setCell(c, 5);
  assert.equal(ctx.getSignal(sig), 6);
  assert.equal(ctx.isSignalActive(sig), true);
  ctx.disposeSignal(sig);
  assert.equal(ctx.isSignalActive(sig), false);
});

test("ThreadSafeContext.withLockBuffer shares a lock across contexts", () => {
  const ctx = new ThreadSafeContext();
  const buf = ctx.lockBuffer;
  if (buf) {
    const ctx2 = ThreadSafeContext.withLockBuffer(buf, new Context());
    assert.equal(ctx2.lockBuffer, buf);
    // Both drive their own graphs correctly under the shared lock.
    const c = ctx2.cell(1);
    assert.equal(ctx2.getCell(c), 1);
  } else {
    assert.equal(buf, null); // shared memory unavailable — degenerate lock
  }
});

test("ThreadSafeContext passes through opt-in instrumentation", () => {
  const plain = new ThreadSafeContext();
  assert.equal(plain.instrumentationSnapshot(), null);
  const ctx = new ThreadSafeContext({ instrument: true });
  const c = ctx.cell(1);
  const d = ctx.computed(() => ctx.getCell(c) + 1);
  ctx.get(d);
  const snap = ctx.instrumentationSnapshot();
  assert.ok(snap && snap.nodeAllocations >= 2);
  ctx.resetInstrumentation();
  assert.equal(ctx.instrumentationSnapshot().slotRecomputes, 0);
});
