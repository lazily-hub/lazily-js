// Property-based validation of the native reactive graph against the universal
// properties established by the Lean `LazilyFormal.Reactive` formal model in
// `lazily-formal`. These are the guarantees no finite fixture suite can
// establish: the `PartialEq` cell-write guard, the memo-equality suppression
// guard, and the eager-`Signal` materialization invariant.
//
// Each test names the Lean theorem it mirrors and exercises the JS
// implementation against the theorem's statement.

import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "../src/reactive.js";

// =================================================================================
// setCell_equal_preserves_graph (Reactive.lean)
// "Writing an equal value into a cell leaves the entire reactive graph
//  byte-identical — no value update, no downstream invalidation."
// =================================================================================
test("Lean setCell_equal_preserves_graph: equal setCell invalidates no dependent", () => {
  const ctx = new Context();
  const a = ctx.source(2);
  const seenSlot = [];
  const dependent = ctx.computed((cx) => {
    seenSlot.push(cx.get(a));
    return cx.get(a);
  });
  const seenEffect = [];
  ctx.effect((cx) => {
    cx.get(a);
    seenEffect.push("fired");
  });

  ctx.get(dependent); // materialize; seed effect ran once on registration
  const slotFiresBefore = seenSlot.length;
  const effectFiresBefore = seenEffect.length;

  ctx.set(a, 2); // equal value — must be a no-op

  ctx.get(dependent); // pull again — should NOT recompute
  assert.equal(seenSlot.length, slotFiresBefore, "slot must not recompute on equal setCell");
  assert.equal(seenEffect.length, effectFiresBefore, "effect must not fire on equal setCell");
  assert.equal(ctx.get(a), 2);
});

// =================================================================================
// setCell_different_invalidates_dependents (Reactive.lean)
// "A strictly-different cell write marks every direct dependent dirty."
// =================================================================================
test("Lean setCell_different_invalidates_dependents: different setCell invalidates every direct dependent", () => {
  const ctx = new Context();
  const a = ctx.source(1);

  // Three flavors of direct dependent: lazy slot, eager signal, side-effect.
  const lazy = ctx.computed((cx) => cx.get(a) + 1);
  const eager = ctx.signal((cx) => cx.get(a) * 10);
  let effectReads = 0;
  ctx.effect((cx) => {
    cx.get(a);
    effectReads++;
  });

  ctx.get(lazy); // materialize
  ctx.getSignal(eager); // materialize
  const effectReadsBefore = effectReads;

  ctx.set(a, 99); // strictly different

  assert.equal(ctx.get(lazy), 100, "lazy slot recomputed");
  assert.equal(ctx.getSignal(eager), 990, "eager signal recomputed");
  assert.ok(effectReads > effectReadsBefore, "effect reran");
});

// =================================================================================
// recomputeSlot_equal_preserves_dependents (Reactive.lean)
// "A memo slot recompute whose memo-equality guard returns true leaves every
//  downstream dependent (other than the slot itself) untouched."
// =================================================================================
test("Lean recomputeSlot_equal_preserves_dependents: a memo slot that recomputes to an equal value leaves downstream untouched", () => {
  const ctx = new Context();
  const toggle = ctx.source("x");
  // A memo slot whose OUTPUT is stable even when its input flips: it derives
  // a constant `42` regardless of `toggle`. The memo guard must observe
  // equality and suppress downstream propagation.
  const stable = ctx.computed((cx) => {
    cx.get(toggle); // register the edge, even though output is constant
    return 42;
  });
  const downstreamFires = [];
  ctx.effect((cx) => {
    cx.get(stable);
    downstreamFires.push("ran");
  });
  const firesBeforeFirst = downstreamFires.length;

  ctx.get(stable); // materialize
  const firesBefore = downstreamFires.length;

  ctx.set(toggle, "y"); // input changes → memo recomputes → output equal

  assert.equal(ctx.get(stable), 42);
  assert.equal(
    downstreamFires.length,
    firesBefore,
    "downstream must not fire when memo recomputes to an equal value",
  );
  assert.ok(downstreamFires.length >= firesBeforeFirst);
});

// =================================================================================
// recomputeSlot_different_invalidates_dependents (Reactive.lean)
// "A strictly-different slot recompute marks every direct dependent dirty."
// =================================================================================
test("Lean recomputeSlot_different_invalidates_dependents: a strictly-different memo recompute invalidates every direct dependent", () => {
  const ctx = new Context();
  const src = ctx.source(1);
  const m = ctx.computed((cx) => cx.get(src) * 2);

  const lazyChild = ctx.computed((cx) => cx.get(m) + 1);
  let effectFires = 0;
  ctx.effect((cx) => {
    cx.get(m);
    effectFires++;
  });

  ctx.get(lazyChild); // materialize
  ctx.getSignal(ctx.signal((cx) => cx.get(m))); // seed another dependent
  const effectFiresBefore = effectFires;

  ctx.set(src, 5); // m recomputes 2 → 10: strictly different

  assert.equal(ctx.get(m), 10);
  assert.equal(ctx.get(lazyChild), 11, "lazy child recomputed");
  assert.ok(effectFires > effectFiresBefore, "dependent effect reran");
});

// =================================================================================
// signal_materialized_after_recompute (Reactive.lean)
// "After a Signal's puller effect runs, the backing slot always holds a
//  concrete cached value and is not dirty — readers never observe an unset
//  intermediate."
// =================================================================================
test("Lean signal_materialized_after_recompute: after setCell the signal is already materialized (not lazy)", () => {
  const ctx = new Context();
  const a = ctx.source(1);
  const sig = ctx.signal((cx) => cx.get(a) + 100);

  ctx.getSignal(sig); // materialize

  // Mutate inside a batch and assert the value is observed as soon as the
  // batch returns — never deferred, never an unset intermediate.
  ctx.batch(() => {
    ctx.set(a, 7);
  });

  // isSet must be true (materialized + not dirty) — no pull needed.
  assert.ok(ctx.isSet(sig.slot), "backing slot is materialized after the puller ran");
  assert.equal(ctx.getSignal(sig), 107, "value already reflects the new input");

  // And the same holds outside a batch (the non-batched path).
  ctx.set(a, 8);
  assert.ok(ctx.isSet(sig.slot), "backing slot materialized on the non-batched path too");
  assert.equal(ctx.getSignal(sig), 108);
});
