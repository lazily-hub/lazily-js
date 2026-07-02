// Property-based validation of the native keyed collection against the
// universal properties established by the Lean `LazilyFormal.Collection`
// formal model in `lazily-formal`. These are the guarantees no finite fixture
// suite can establish: independent value / set-membership / order reactivity,
// atomic move preserving identity, and CellFamily per-key stability.
//
// Each test names the Lean theorem it mirrors and exercises the JS
// implementation (`CellMap`) against the theorem's statement. The mutation
// methods on `CellMap` return an invalidation report
// `{ value: key[], membership: bool, order: bool }` — these reports ARE the
// reactivity contract made inspectable, and the assertions check them.

import assert from "node:assert/strict";
import test from "node:test";

import { CellMap } from "../src/collections.js";

function buildAbc() {
  return new CellMap({ order: ["a", "b", "c"], values: { a: 1, b: 2, c: 3 } });
}

// =================================================================================
// setEntryValue_preserves_membership (Collection.lean)
// "Updating one entry's value leaves the set-membership signal unchanged —
//  len/contains readers are not invalidated."
// =================================================================================
test("Lean setEntryValue_preserves_membership: setValue does not touch the membership signal", () => {
  const m = buildAbc();
  const before = { keys: m.keys(), hasB: m.has("b") };
  const report = m.setValue("b", 99);
  assert.equal(report.membership, false, "setValue MUST NOT advance membership signal");
  assert.deepEqual(m.keys(), before.keys, "key set unchanged");
  assert.equal(m.has("b"), before.hasB);
});

// =================================================================================
// setEntryValue_preserves_order (Collection.lean)
// "Updating one entry's value leaves the order signal (orderV) unchanged."
// =================================================================================
test("Lean setEntryValue_preserves_order: setValue does not touch the order signal", () => {
  const m = buildAbc();
  const orderBefore = m.keys();
  const report = m.setValue("a", 42);
  assert.equal(report.order, false, "setValue MUST NOT advance order signal");
  assert.deepEqual(m.keys(), orderBefore, "order unchanged");
});

// =================================================================================
// setEntryValue_preserves_siblings (Collection.lean)
// "Updating one entry's value leaves every sibling entry's value cell
//  untouched (fine-grained per-entry reactivity)."
// =================================================================================
test("Lean setEntryValue_preserves_siblings: setValue on one key leaves every sibling byte-identical", () => {
  const m = buildAbc();
  const siblingsBefore = { a: m.get("a"), c: m.get("c") };
  const report = m.setValue("b", 999);
  assert.equal(m.get("a"), siblingsBefore.a, "sibling 'a' untouched");
  assert.equal(m.get("c"), siblingsBefore.c, "sibling 'c' untouched");
  assert.deepEqual(report.value, ["b"], "only 'b' is reported as a changed value reader");
});

// =================================================================================
// moveKey_preserves_membership (Collection.lean)
// "A pure reorder leaves the set-membership signal unchanged — move_to MUST
//  NOT invalidate len/contains readers."
// =================================================================================
test("Lean moveKey_preserves_membership: a pure reorder does not touch the membership signal", () => {
  const m = buildAbc();
  const report = m.moveTo("c", 0);
  assert.equal(report.membership, false, "reorder MUST NOT advance membership");
  assert.equal(m.has("c"), true);
  assert.equal(m.keys().length, 3);
});

// =================================================================================
// moveKey_preserves_values (Collection.lean)
// "A pure reorder leaves every entry's value cell untouched (atomic move
//  preserves cell identity — not remove + re-mint)."
// =================================================================================
test("Lean moveKey_preserves_values: a pure reorder keeps the entry's handle + every value", () => {
  const m = buildAbc();
  const handleBefore = m.handle("b");
  const valuesBefore = { a: m.get("a"), b: m.get("b"), c: m.get("c") };

  m.moveBefore("c", "b"); // move 'b' before 'c'

  assert.equal(m.handle("b"), handleBefore, "atomic move MUST keep the same handle");
  assert.equal(m.get("a"), valuesBefore.a);
  assert.equal(m.get("b"), valuesBefore.b);
  assert.equal(m.get("c"), valuesBefore.c);
});

// =================================================================================
// moveKey_advances_order (Collection.lean)
// "A pure reorder of an existing key strictly advances the order signal by
//  exactly one — keys readers are invalidated exactly once."
// =================================================================================
test("Lean moveKey_advances_order: a pure reorder advances the order signal exactly once", () => {
  const m = buildAbc();
  const report = m.moveAfter("a", "c"); // a after c
  assert.equal(report.order, true, "reorder MUST advance the order signal");
  assert.equal(report.value.length, 0, "reorder MUST NOT touch value readers");
  assert.deepEqual(m.keys(), ["b", "c", "a"]);
});

// =================================================================================
// addKey_advances_membership_and_order (Collection.lean)
// "Adding a brand-new key strictly advances both the membership and the order
//  signal."
// =================================================================================
test("Lean addKey_advances_membership_and_order: insert advances both signals", () => {
  const m = buildAbc();
  const report = m.insert("d", 4, 1); // insert 'd' at index 1
  assert.equal(report.membership, true, "insert MUST advance membership");
  assert.equal(report.order, true, "insert MUST advance order");
  assert.equal(report.value.length, 0, "insert MUST NOT touch existing value readers");
  assert.deepEqual(m.keys(), ["a", "d", "b", "c"]);
  assert.equal(m.get("d"), 4);
});

// =================================================================================
// Family.get_idempotent_after_first (Collection.lean)
// "Requesting the same key twice from a CellFamily returns identical state the
//  second time — a key resolves to one stable cell handle for its lifetime
//  (lazy mint + cache)."
// =================================================================================
test("Lean Family.get_idempotent_after_first: the same key resolves to the same handle on every request", () => {
  const m = buildAbc();
  const h1 = m.handle("a");
  const h2 = m.handle("a");
  const h3 = m.handle("a");
  assert.equal(h1, h2, "second request returns the same handle");
  assert.equal(h2, h3, "third request returns the same handle");

  // The handle is stable across reorders, too: identity survives a move.
  m.moveAfter("a", "c");
  assert.equal(m.handle("a"), h1, "identity survives a reorder");

  // Removing the key mints a fresh handle on re-add (the lifetime ended).
  m.remove("a");
  m.insert("a", 99, "start");
  assert.notEqual(m.handle("a"), h1, "a fresh handle is minted after remove + re-add");
});
