// The fortified `Compute` view is the sole tracking surface (#lzcellkernel).
//
// Mirrors lazily-rs `tests/compute_fortification.rs`. The reactive core threads
// the recomputing node id into every compute/effect closure as a VALUE, via a
// per-recompute `Compute` view, instead of an ambient carrier. These tests pin
// the fortification contract:
//
//   1. A tracked read through the `Compute` handed to a closure registers a
//      dependency edge against the recomputing node (edge visible both ways; a
//      change to the dependency recomputes the dependent).
//   2. The explicit untracked escape (`compute.untracked().get`) registers NO
//      edge, so the dependent neither gains a dependency nor recomputes.
//   3. An effect tracks through its own `Compute` view.
//   4. Non-escapability: a `Compute` captured and read after its recompute has
//      returned throws — it cannot be replayed to attribute an edge to the wrong
//      node.
//   5. Value-threading survives suspension: an async compute that reads a
//      dependency AFTER an `await` still attributes the edge to the recomputing
//      node. This is the property the browser (no `AsyncLocalStorage`) has no
//      other correct mechanism for, and is why the id is a value, not ambient.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "../src/reactive.js";
import { AsyncContext } from "../src/reactive-async.js";

test("tracked read through the compute view registers an edge against the recomputing node", () => {
  const ctx = new Context();
  const a = ctx.source(1);

  let calls = 0;
  const b = ctx.computed((c) => {
    calls += 1;
    // Tracked read: the edge must attribute to `b`, the node being recomputed —
    // not to any ambient frame.
    return c.get(a) * 10;
  });

  assert.equal(ctx.get(b), 10);
  assert.equal(calls, 1, "first read computes once");

  // Structural: the edge exists in both directions.
  assert.equal(ctx.dependentCount(a), 1, "a must have b as its single dependent");
  assert.equal(ctx.dependencyCount(b), 1, "b must depend on a");

  // Behavioural: changing a recomputes b.
  ctx.set(a, 5);
  assert.equal(ctx.get(b), 50);
  assert.equal(calls, 2, "changing the tracked dependency recomputes b");
});

test("untracked read through the compute view registers no edge and does not recompute", () => {
  const ctx = new Context();
  const a = ctx.source(1);

  let calls = 0;
  const d = ctx.computed((c) => {
    calls += 1;
    // The explicit untracked escape: forms no dependency edge, even though the
    // ambient bridge still has `d` on its tracking stack for this recompute.
    return c.untracked().get(a) * 10;
  });

  assert.equal(ctx.get(d), 10);
  assert.equal(calls, 1);

  // Structural: no edge was formed by the untracked read.
  assert.equal(ctx.dependentCount(a), 0, "an untracked read must not register a dependent");
  assert.equal(ctx.dependencyCount(d), 0, "d must have acquired no dependency");

  // Behavioural: changing a does NOT recompute d — its cached value stands.
  ctx.set(a, 5);
  assert.equal(ctx.get(d), 10, "untracked dependent keeps its stale value");
  assert.equal(calls, 1, "untracked dependent never recomputes");
});

test("an effect tracks through its compute view", () => {
  const ctx = new Context();
  const a = ctx.source(1);

  let runs = 0;
  ctx.effect((c) => {
    runs += 1;
    c.get(a);
  });

  assert.equal(runs, 1, "effect runs once on creation");
  assert.equal(ctx.dependentCount(a), 1, "effect owns the edge to a");

  ctx.set(a, 2);
  assert.equal(runs, 2, "a change reruns the tracking effect");
});

test("non-escapability: a compute view read after its recompute throws", () => {
  const ctx = new Context();
  const a = ctx.source(1);

  let escaped = null;
  const b = ctx.computed((c) => {
    escaped = c; // smuggle the view out of its recompute
    return c.get(a);
  });

  assert.equal(ctx.get(b), 1);
  assert.notEqual(escaped, null);

  // The view is invalid once its recompute returned; a replayed read throws
  // rather than registering an edge against the wrong (or a stale) node.
  assert.throws(
    () => escaped.get(a),
    /Compute view read after its recompute/,
    "a stale compute view must not be replayable",
  );
});

test("value-threading survives await: a post-await read still attributes to the recomputing node", async () => {
  const ctx = new AsyncContext();
  const a = ctx.source(1);

  let calls = 0;
  const b = ctx.computedAsync(async (c) => {
    calls += 1;
    // Suspend BEFORE reading. With an ambient carrier this attribution would be
    // clobbered by whatever else ran on the microtask queue during the await;
    // because the recomputing node id is threaded through `c` as a value, the
    // read after the await still names `b`.
    await Promise.resolve();
    return c.get(a) * 10;
  });

  assert.equal(await ctx.getAsync(b), 10);
  assert.equal(calls, 1);

  // The edge was registered post-await, against the right node.
  assert.equal(ctx.dependentCount(a), 1, "a gained b as a dependent from a post-await read");
  assert.equal(ctx.dependencyCount(b), 1, "b depends on a");

  ctx.set(a, 5);
  assert.equal(await ctx.getAsync(b), 50, "changing the post-await dependency recomputes b");
  assert.equal(calls, 2);
});
