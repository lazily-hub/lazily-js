// disposeSlot / disposeCell — node teardown for the lazy derived + source nodes.
//
// lazily historically exposed disposal only for the disposable-by-construction
// nodes (Effect, and Signal via its puller Effect). disposeSlot/disposeCell fill
// the gap so reactive graphs can be torn down without leaking node objects and
// (critically) without leaving dangling id references in surviving consumers'
// dependency lists.
//
// These tests pin: upstream + downstream edge detachment, the no-dangling-ref
// invariant (a surviving consumer's rerun/disposal never dereferences a freed
// id), id recycling, and double/wrong-kind dispose safety.

import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "../src/reactive.js";

// =================================================================================
// disposeSlot_stops_propagation
// "Disposing a derived slot removes it from the invalidation cone: a subsequent
//  upstream write no longer reaches a former downstream observer."
// =================================================================================
test("disposeSlot: upstream write no longer reaches a former downstream effect", () => {
  const ctx = new Context();
  const a = ctx.cell(1);
  const m = ctx.computed(() => ctx.getCell(a) + 1);
  let fires = 0;
  const eff = ctx.effect(() => {
    ctx.get(m);
    fires++;
    return null;
  });
  assert.equal(fires, 1, "effect ran once on registration");

  ctx.setCell(a, 2); // a -> m -> eff
  assert.equal(fires, 2);

  ctx.disposeSlot(m);
  ctx.setCell(a, 3); // m is detached from a; eff no longer observes m
  assert.equal(fires, 2, "no propagation after disposeSlot");
});

// =================================================================================
// disposeSlot_no_dangling_dependency_ref (regression)
// "Disposing a slot a surviving effect still lists in `dependencies` must remove
//  that id from the effect's dependency list, so the effect's next teardown/rerun
//  never dereferences the freed id."
//
// Without the downstream detach, `disposeEffect(eff)` below would iterate
// eff.dependencies=[m] and call removeDependentEdge(m, eff), which reads
// nodes[m].k on the now-freed node -> TypeError.
// =================================================================================
test("disposeSlot: downstream cleanup prevents a dangling ref in a surviving consumer", () => {
  const ctx = new Context();
  const a = ctx.cell(1);
  const m = ctx.computed(() => ctx.getCell(a) + 1);
  const eff = ctx.effect(() => {
    ctx.get(m);
    return null;
  });

  // After disposeSlot(m), disposing the effect must not dereference freed m.
  // (eff.dependencies previously contained m; disposeSlot removes it.)
  ctx.disposeSlot(m);
  assert.doesNotThrow(
    () => ctx.disposeEffect(eff),
    "disposeEffect must not crash on a freed upstream slot",
  );
});

// =================================================================================
// disposeSlot_upstream_and_downstream_edges_removed (instrumented)
// =================================================================================
test("disposeSlot: removes both the upstream and downstream edges (instrumented)", () => {
  const ctx = new Context({ instrument: true });
  const a = ctx.cell(1);
  const m = ctx.computed(() => ctx.getCell(a) + 1); // edge a -> m
  ctx.effect(() => {
    ctx.get(m);
    return null;
  }); // edge m -> eff

  const before = ctx.instrumentationSnapshot().dependencyEdgesRemoved;
  ctx.disposeSlot(m);
  const after = ctx.instrumentationSnapshot().dependencyEdgesRemoved;
  // Two edges detached: the upstream (a.dependents -= m) and the downstream
  // (eff.dependencies -= m).
  assert.equal(after - before, 2, "both upstream and downstream edges removed");
});

// =================================================================================
// disposeSlot_value_no_longer_readable
// "A disposed slot's id is freed; reading it via its stale handle is undefined
//  behavior and (here) surfaces as the slot having no value."
// =================================================================================
test("disposeSlot: the node is freed (id recycled for the next allocation)", () => {
  const ctx = new Context();
  const a = ctx.cell(10);
  const m = ctx.computed(() => ctx.getCell(a) + 1);
  const mId = m.id;
  ctx.get(m); // materialize
  ctx.disposeSlot(m);

  // Next allocation reuses the freed id.
  const reused = ctx.cell(99);
  assert.equal(reused.id, mId, "freed slot id is recycled");
  assert.equal(ctx.getCell(reused), 99, "recycled id is an independent cell");
});

// =================================================================================
// disposeCell_detaches_downstream
// "Disposing a source cell removes it from each dependent's dependency list."
// =================================================================================
test("disposeCell: detaches downstream edges (instrumented)", () => {
  const ctx = new Context({ instrument: true });
  const a = ctx.cell(1);
  const m = ctx.computed(() => ctx.getCell(a) + 1); // edge a -> m
  ctx.get(m);

  const before = ctx.instrumentationSnapshot().dependencyEdgesRemoved;
  ctx.disposeCell(a);
  const after = ctx.instrumentationSnapshot().dependencyEdgesRemoved;
  assert.equal(after - before, 1, "downstream edge a -> m removed");
});

// =================================================================================
// disposeCell_id_recycled
// =================================================================================
test("disposeCell: freed cell id is recycled", () => {
  const ctx = new Context();
  const a = ctx.cell(1);
  const aId = a.id;
  ctx.disposeCell(a);
  const reused = ctx.cell("next");
  assert.equal(reused.id, aId, "freed cell id is recycled");
  assert.equal(ctx.getCell(reused), "next");
});

test("disposeCell: a cell with no dependents disposes cleanly", () => {
  const ctx = new Context();
  const a = ctx.cell(1);
  assert.doesNotThrow(() => ctx.disposeCell(a));
});

test("disposeSlot: a slot with no dependents and no dependencies disposes cleanly", () => {
  const ctx = new Context();
  const m = ctx.computed(() => 42);
  ctx.get(m);
  assert.doesNotThrow(() => ctx.disposeSlot(m));
});

// =================================================================================
// dispose_is_idempotent_and_kind_safe
// =================================================================================
test("dispose: double-dispose and wrong-kind dispose are no-ops", () => {
  const ctx = new Context();
  const a = ctx.cell(1);
  const m = ctx.computed(() => ctx.getCell(a) + 1);
  ctx.get(m);

  assert.doesNotThrow(() => ctx.disposeSlot(m));
  assert.doesNotThrow(() => ctx.disposeSlot(m), "second disposeSlot is a no-op");
  assert.doesNotThrow(() => ctx.disposeCell(m), "disposeCell on a slot handle is a no-op");
  assert.doesNotThrow(() => ctx.disposeSlot(a), "disposeSlot on a cell handle is a no-op");
  assert.doesNotThrow(() => ctx.disposeCell(a));
  assert.doesNotThrow(() => ctx.disposeCell(a), "second disposeCell is a no-op");
});
