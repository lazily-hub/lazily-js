import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "../src/reactive.js";

test("Cell + computed: lazy slot computes on first read and recomputes after a cell change", () => {
  const ctx = new Context();
  const a = ctx.cell(2);
  const b = ctx.cell(3);
  const sum = ctx.slot(() => ctx.getCell(a) + ctx.getCell(b));
  assert.equal(ctx.get(sum), 5);
  ctx.setCell(a, 10);
  assert.equal(ctx.get(sum), 13);
});

test("Cell == guard: setting an equal value is a no-op (no invalidation)", () => {
  const ctx = new Context();
  const a = ctx.cell(1);
  let runs = 0;
  const doubler = ctx.slot(() => {
    runs++;
    return ctx.getCell(a) * 2;
  });
  ctx.get(doubler); // prime
  assert.equal(runs, 1);
  ctx.setCell(a, 1); // equal -> no-op
  assert.equal(ctx.get(doubler), 2);
  assert.equal(runs, 1); // did NOT recompute
  ctx.setCell(a, 2); // real change
  assert.equal(ctx.get(doubler), 4);
  assert.equal(runs, 2);
});

test("memo: an equal recompute suppresses downstream invalidation", () => {
  const ctx = new Context();
  const a = ctx.cell(1);
  // memo always returns 0 regardless of input — downstream must not re-run.
  const constant = ctx.memo(() => {
    ctx.getCell(a); // subscribe
    return 0;
  });
  let downstreamRuns = 0;
  const downstream = ctx.computed(() => {
    ctx.get(constant);
    return ++downstreamRuns;
  });
  assert.equal(ctx.get(downstream), 1);
  ctx.setCell(a, 99); // a changes, constant recomputes but stays 0 (memo guard)
  assert.equal(ctx.get(downstream), 1); // downstream did NOT re-run
});

test("Signal is eager: materialized before setCell/batch returns", () => {
  const ctx = new Context();
  const a = ctx.cell(2);
  const parity = ctx.signal(() => (ctx.getCell(a) % 2 === 0 ? "even" : "odd"));
  assert.equal(ctx.getSignal(parity), "even");
  ctx.setCell(a, 11);
  assert.equal(ctx.getSignal(parity), "odd"); // already updated
});

test("Effect reruns on tracked dependency change; cleanup runs before rerun and on dispose", () => {
  const ctx = new Context();
  const a = ctx.cell(1);
  const log = [];
  const handle = ctx.effect(() => {
    const v = ctx.getCell(a);
    log.push(`body:${v}`);
    return () => log.push("cleanup");
  });
  assert.deepEqual(log, ["body:1"]); // ran once on registration
  ctx.setCell(a, 2);
  assert.deepEqual(log, ["body:1", "cleanup", "body:2"]); // cleanup before rerun
  ctx.disposeEffect(handle);
  assert.deepEqual(log, ["body:1", "cleanup", "body:2", "cleanup"]); // cleanup on dispose
});

test("batch coalesces multiple writes into one effect flush", () => {
  const ctx = new Context();
  const a = ctx.cell(1);
  const b = ctx.cell(1);
  let effectRuns = 0;
  ctx.effect(() => {
    ctx.getCell(a);
    ctx.getCell(b);
    effectRuns++;
    return null;
  });
  assert.equal(effectRuns, 1);
  ctx.batch(() => {
    ctx.setCell(a, 2);
    ctx.setCell(b, 2);
    ctx.setCell(a, 3);
  });
  assert.equal(effectRuns, 2); // flushed once at batch exit, not three times
});

test("glitch-free: a slot observes consistent inputs during refresh", () => {
  const ctx = new Context();
  const a = ctx.cell(10);
  const b = ctx.slot(() => ctx.getCell(a) + 1); // b = a + 1
  const sumEq = ctx.slot(() => ctx.getCell(a) + ctx.get(b) === 2 * ctx.getCell(a) + 1);
  assert.equal(ctx.get(sumEq), true);
  ctx.setCell(a, 50);
  assert.equal(ctx.get(sumEq), true); // still consistent after recompute
});

test("cycle detection throws", () => {
  const ctx = new Context();
  const slot = ctx.slot(() => ctx.get(slot)); // self-reference
  assert.throws(() => ctx.get(slot), /circular dependency/);
});

test("dynamic dependencies: a slot that reads a different branch on rerun updates its edges", () => {
  const ctx = new Context();
  const flag = ctx.cell(true);
  const a = ctx.cell(1);
  const b = ctx.cell(100);
  const cond = ctx.slot(() => (ctx.getCell(flag) ? ctx.getCell(a) : ctx.getCell(b)));
  assert.equal(ctx.get(cond), 1);
  ctx.setCell(b, 999); // cond doesn't read b yet -> stays cached
  assert.equal(ctx.get(cond), 1);
  ctx.setCell(flag, false); // now reads b
  assert.equal(ctx.get(cond), 999);
  ctx.setCell(a, 2); // cond no longer reads a -> must NOT recompute
  // Reading cond should still be 999 (a is no longer a dependency).
  assert.equal(ctx.get(cond), 999);
});

test("isSet reports cached freshness", () => {
  const ctx = new Context();
  const a = ctx.cell(1);
  const s = ctx.slot(() => ctx.getCell(a) + 1);
  assert.equal(ctx.isSet(s), false); // never read
  ctx.get(s);
  assert.equal(ctx.isSet(s), true);
  ctx.setCell(a, 5); // invalidates
  assert.equal(ctx.isSet(s), false);
  ctx.get(s);
  assert.equal(ctx.isSet(s), true);
});

test("Uint8Array values use structural equality in the == guard", () => {
  const ctx = new Context();
  const a = ctx.cell(Uint8Array.of(1, 2, 3));
  let runs = 0;
  const s = ctx.slot(() => {
    runs++;
    return ctx.getCell(a);
  });
  ctx.get(s);
  ctx.setCell(a, Uint8Array.of(1, 2, 3)); // equal-by-value -> no-op
  ctx.get(s); // pull (stays cached — no recompute)
  assert.equal(runs, 1);
  ctx.setCell(a, Uint8Array.of(1, 2, 4)); // different -> recompute
  ctx.get(s); // pull -> recomputes
  assert.equal(runs, 2);
});
