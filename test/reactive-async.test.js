// Async reactive context conformance (lazily-spec/docs/async.md).
//
// The property tests name the lazily-formal theorems they mirror:
//   LazilyFormal/AsyncSlotState.lean — stale_completeOk_discarded,
//     current_completeOk_publishes, current_completeErr_to_error,
//     step_preserves_wellFormed
//   LazilyFormal/AsyncEffect.lean — fire_blocked_during_cleanup,
//     invalidate_from_idle_schedules, cleanupDone_resumes_deferred,
//     dispose_absorbing, disposed_terminal

import { test } from "node:test";
import assert from "node:assert/strict";

import { AsyncContext } from "../src/reactive-async.js";

// A macrotask flush: lets spawned computes run up to their first suspension.
const flush = () => new Promise((r) => setTimeout(r, 0));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// -- Slot state machine ------------------------------------------------------

test("slot starts empty; get() is undefined before resolution", () => {
  const ctx = new AsyncContext();
  const s = ctx.computedAsync(async () => 1);
  assert.equal(ctx.slotState(s), "empty");
  assert.equal(ctx.get(s), undefined);
  assert.equal(ctx.isResolved(s), false);
});

test("first get_async resolves and caches (current_completeOk_publishes)", async () => {
  const ctx = new AsyncContext();
  const s = ctx.computedAsync(async () => 42);
  assert.equal(await ctx.getAsync(s), 42);
  assert.equal(ctx.slotState(s), "resolved");
  assert.equal(ctx.get(s), 42);
  assert.equal(ctx.isResolved(s), true);
});

test("in-flight deduplication: concurrent get_async share one compute", async () => {
  const ctx = new AsyncContext();
  let calls = 0;
  const gate = deferred();
  const s = ctx.computedAsync(async () => {
    calls += 1;
    await gate.promise;
    return 7;
  });
  const a = ctx.getAsync(s);
  const b = ctx.getAsync(s);
  await flush();
  assert.equal(calls, 1, "only one compute spawned for concurrent waiters");
  assert.equal(ctx.slotState(s), "computing");
  gate.resolve();
  assert.deepEqual(await Promise.all([a, b]), [7, 7]);
  assert.equal(calls, 1);
});

test("depends on a cell; invalidation recomputes lazily", async () => {
  const ctx = new AsyncContext();
  const n = ctx.cell(2);
  const doubled = ctx.computedAsync(async (cctx) => cctx.getCell(n) * 2);
  assert.equal(await ctx.getAsync(doubled), 4);
  ctx.setCell(n, 5);
  assert.equal(ctx.slotState(doubled), "empty", "invalidation clears the cache");
  assert.equal(await ctx.getAsync(doubled), 10);
});

test("stale completion is discarded, never published (stale_completeOk_discarded)", async () => {
  const ctx = new AsyncContext();
  const n = ctx.cell(1);
  const gates = [];
  let calls = 0;
  const s = ctx.computedAsync(async (cctx) => {
    const v = cctx.getCell(n); // dependency registered BEFORE the await
    calls += 1;
    const g = deferred();
    gates.push(g);
    await g.promise;
    return v * 10;
  });

  const p = ctx.getAsync(s);
  await flush();
  assert.equal(calls, 1);
  assert.equal(ctx.slotState(s), "computing");

  // Invalidate mid-flight: the revision advances and the in-flight compute is
  // superseded.
  ctx.setCell(n, 2);
  assert.equal(ctx.slotState(s), "empty");
  gates[0].resolve(); // the stale (revision-1) compute completes -> discarded
  await flush();
  assert.equal(calls, 2, "waiter re-resolved and spawned a fresh compute");
  gates[1].resolve(); // the current (revision-2) compute completes
  assert.equal(await p, 20, "get_async returns the fresh value, never the stale one");
  assert.equal(ctx.get(s), 20);
});

test("error transitions to Error and get_async rejects; retry recomputes (current_completeErr_to_error)", async () => {
  const ctx = new AsyncContext();
  let attempt = 0;
  const s = ctx.computedAsync(async () => {
    attempt += 1;
    if (attempt === 1) {
      throw new Error("boom");
    }
    return "ok";
  });
  await assert.rejects(() => ctx.getAsync(s), /boom/);
  assert.equal(ctx.slotState(s), "error");
  // Error -> Computing retry on the next get_async.
  assert.equal(await ctx.getAsync(s), "ok");
  assert.equal(ctx.slotState(s), "resolved");
});

// -- Async effects -----------------------------------------------------------

test("effect runs initially and reruns on dependency change (invalidate_from_idle_schedules)", async () => {
  const ctx = new AsyncContext();
  const n = ctx.cell(0);
  const seen = [];
  ctx.effectAsync(async (cctx) => {
    seen.push(cctx.getCell(n));
  });
  await ctx.settle();
  assert.deepEqual(seen, [0]);
  ctx.setCell(n, 1);
  await ctx.settle();
  assert.deepEqual(seen, [0, 1]);
});

test("cleanup runs before the next body (fire_blocked_during_cleanup / cleanupDone_resumes_deferred)", async () => {
  const ctx = new AsyncContext();
  const n = ctx.cell(0);
  const order = [];
  ctx.effectAsync(async (cctx) => {
    const v = cctx.getCell(n);
    order.push(`body:${v}`);
    return async () => {
      order.push(`cleanup:${v}`);
    };
  });
  await ctx.settle();
  ctx.setCell(n, 1);
  await ctx.settle();
  assert.deepEqual(order, ["body:0", "cleanup:0", "body:1"]);
});

test("dispose runs the final cleanup and stops reruns (dispose_absorbing / disposed_terminal)", async () => {
  const ctx = new AsyncContext();
  const n = ctx.cell(0);
  const order = [];
  const e = ctx.effectAsync(async (cctx) => {
    const v = cctx.getCell(n);
    order.push(`body:${v}`);
    return () => order.push(`cleanup:${v}`);
  });
  await ctx.settle();
  await ctx.disposeAsyncEffect(e);
  assert.equal(ctx.isEffectActive(e), false);
  assert.deepEqual(order, ["body:0", "cleanup:0"]);
  // Disposed is terminal: further invalidation does not resurrect the effect.
  ctx.setCell(n, 1);
  await ctx.settle();
  assert.deepEqual(order, ["body:0", "cleanup:0"]);
});

// -- Eager async signals -----------------------------------------------------

test("signal_async eagerly materializes after settle", async () => {
  const ctx = new AsyncContext();
  const n = ctx.cell(3);
  const sig = ctx.signalAsync(async (cctx) => cctx.getCell(n) + 1);
  await ctx.settle();
  assert.equal(ctx.getSignal(sig), 4);
  ctx.setCell(n, 10);
  await ctx.settle();
  assert.equal(ctx.getSignal(sig), 11);
  assert.equal(await ctx.getSignalAsync(sig), 11);
  assert.equal(ctx.isSignalActive(sig), true);
  await ctx.disposeSignal(sig);
  assert.equal(ctx.isSignalActive(sig), false);
});

// -- Batching ----------------------------------------------------------------

test("batch coalesces multiple cell writes into one rerun", async () => {
  const ctx = new AsyncContext();
  const a = ctx.cell(1);
  const b = ctx.cell(1);
  let runs = 0;
  ctx.effectAsync(async (cctx) => {
    cctx.getCell(a);
    cctx.getCell(b);
    runs += 1;
  });
  await ctx.settle();
  assert.equal(runs, 1);
  ctx.batch(() => {
    ctx.setCell(a, 2);
    ctx.setCell(b, 2);
  });
  await ctx.settle();
  assert.equal(runs, 2, "two writes in a batch trigger a single rerun");
});

test("batch does not schedule reruns until the outermost batch exits", async () => {
  const ctx = new AsyncContext();
  const a = ctx.cell(1);
  let runs = 0;
  ctx.effectAsync(async (cctx) => {
    cctx.getCell(a);
    runs += 1;
  });
  await ctx.settle();
  ctx.batch(() => {
    ctx.setCell(a, 2);
    // Still inside the batch: no rerun scheduled yet.
    assert.equal(runs, 1);
  });
  await ctx.settle();
  assert.equal(runs, 2);
});

// -- Dependency re-discovery -------------------------------------------------

test("dynamic dependencies are re-discovered each run", async () => {
  const ctx = new AsyncContext();
  const which = ctx.cell("a");
  const a = ctx.cell("A");
  const b = ctx.cell("B");
  const s = ctx.computedAsync(async (cctx) =>
    cctx.getCell(which) === "a" ? cctx.getCell(a) : cctx.getCell(b),
  );
  assert.equal(await ctx.getAsync(s), "A");
  // While selecting `a`, changing `b` must not invalidate the slot.
  ctx.setCell(b, "B2");
  assert.equal(ctx.slotState(s), "resolved", "unrelated dependency did not invalidate");
  // Switch selection; now `b` is a dependency.
  ctx.setCell(which, "b");
  assert.equal(await ctx.getAsync(s), "B2");
  ctx.setCell(a, "A2");
  assert.equal(ctx.slotState(s), "resolved", "old dependency `a` no longer tracked");
});

test("context dispose aborts in-flight work and awaits cleanups", async () => {
  const ctx = new AsyncContext();
  const n = ctx.cell(0);
  let cleaned = false;
  ctx.effectAsync(async (cctx) => {
    cctx.getCell(n);
    return () => {
      cleaned = true;
    };
  });
  await ctx.settle();
  await ctx.dispose();
  assert.equal(cleaned, true);
});
