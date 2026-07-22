import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "../src/reactive.js";
import {
  BenchmarkResult,
  benchmark,
  runBenchmarkSuite,
  withInstrumentation,
} from "../src/instrumentation.js";

// --- benchmark harness (light-tier parity with py/go/dart) ------------------
test("benchmark returns a timing-only BenchmarkResult", () => {
  let n = 0;
  const r = benchmark("increment", () => {
    n += 1;
  }, 500);
  assert.ok(r instanceof BenchmarkResult);
  assert.equal(r.name, "increment");
  assert.equal(r.iterations, 500);
  assert.ok(r.totalMicros >= 0);
  assert.ok(r.avgMicros() >= 0);
  assert.ok(r.opsPerSecond() >= 0);
  assert.match(r.toString(), /increment/);
});

test("benchmark rejects a non-function body", () => {
  assert.throws(() => benchmark("bad", 123, 10), /must be a function/);
});

test("runBenchmarkSuite returns one result per reactive-core case", () => {
  const suite = runBenchmarkSuite(100);
  assert.ok(Array.isArray(suite));
  assert.ok(suite.length >= 5);
  const names = suite.map((r) => r.name);
  for (const expected of ["cell_set_get", "computed_recompute", "effect_rerun", "family_materialize"]) {
    assert.ok(names.includes(expected), `suite includes ${expected}`);
  }
  for (const r of suite) {
    assert.ok(r instanceof BenchmarkResult);
    assert.equal(r.iterations, 100);
  }
});

// --- opt-in reactive-core counters ------------------------------------------
test("Context instrumentation is off by default (zero overhead)", () => {
  const ctx = new Context();
  assert.equal(ctx.instrumentationSnapshot(), null);
  const c = ctx.source(1);
  ctx.get(c);
  assert.equal(ctx.instrumentationSnapshot(), null);
});

test("instrumented Context accumulates the JS-meaningful counter subset", () => {
  const ctx = new Context({ instrument: true });
  const c = ctx.source(1);
  const d = ctx.computed((cx) => cx.get(c) * 2);
  assert.equal(ctx.get(d), 2); // recompute #1, edge added
  ctx.set(c, 5); // edge removed on invalidation cascade
  assert.equal(ctx.get(d), 10); // recompute #2

  const snap = ctx.instrumentationSnapshot();
  assert.ok(snap.nodeAllocations >= 2, "cell + slot allocated");
  assert.ok(snap.slotRecomputes >= 2, "two recomputes");
  assert.ok(snap.dependencyEdgesAdded >= 1, "d depends on c");
});

test("resetInstrumentation zeroes the counters", () => {
  const ctx = new Context({ instrument: true });
  ctx.source(0);
  assert.ok(ctx.instrumentationSnapshot().nodeAllocations > 0);
  ctx.resetInstrumentation();
  const snap = ctx.instrumentationSnapshot();
  assert.equal(snap.nodeAllocations, 0);
  assert.equal(snap.slotRecomputes, 0);
});

test("withInstrumentation returns both the body result and a counter snapshot", () => {
  const { result, snapshot } = withInstrumentation((ctx) => {
    const c = ctx.source(3);
    const d = ctx.computed((cx) => cx.get(c) + 1);
    return ctx.get(d);
  });
  assert.equal(result, 4);
  assert.ok(snapshot.nodeAllocations >= 2);
  assert.ok(snapshot.slotRecomputes >= 1);
});
