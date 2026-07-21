import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Context } from "../src/reactive.js";
import { CellMap, EntryKind, ReactiveMap, SlotMap } from "../src/reactive-family.js";

const here = dirname(fileURLToPath(import.meta.url));
const specMaterialization = join(here, "..", "..", "lazily-spec", "conformance", "materialization");

function loadFixture(name) {
  const path = join(specMaterialization, name);
  assert.ok(existsSync(path), `missing spec fixture ${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertSameSet(actual, expected, label) {
  const a = [...actual].map(String).sort();
  const e = [...expected].map(String).sort();
  assert.deepEqual(a, e, `${label}: set differs`);
}

// An eager SlotMap: pre-mint the whole keyset. A lazy SlotMap: empty, minted on
// access via getOrInsertWith. There is no eager/lazy mode flag — eager is the
// pre-mint loop, lazy is mint-on-access (#reactivemap).
function eagerSlotMap(ctx, keys, factory) {
  const map = new SlotMap(ctx);
  map.materializeAll(keys, factory);
  return map;
}

// --- conformance: observational_transparency.json --------------------------
test("SlotMap materialization conformance: observational_transparency.json", () => {
  const fixture = loadFixture("observational_transparency.json");
  const { spec, expected } = fixture;
  const keys = Object.keys(spec.val);
  const factory = (k) => spec.val[k];

  // default_mode_eager: eager is the default materialization strategy.
  assert.equal(expected.default_mode, "eager", "default strategy is eager");

  const ctx = new Context();
  const eager = eagerSlotMap(ctx, keys, factory);
  const lazy = new SlotMap(ctx);

  // eager_materializes_all: every declared key present up front.
  assertSameSet(eager.presentKeys(), expected.eager_present, "eager_present");
  // lazy_defers_slots: nothing materialized until read.
  assert.equal(lazy.presentCount(), 0, "lazy defers all slots at build");

  // observe_canonical / eager_lazy_observationally_equivalent: identical values.
  for (const [key, value] of Object.entries(expected.observe)) {
    assert.equal(eager.get(key), value, `eager observe[${key}]`);
    assert.equal(lazy.getOrInsertWith(key, factory), value, `lazy observe[${key}]`);
  }

  // Rebuild a fresh lazy map to observe only the `reads` sequence.
  const ctx2 = new Context();
  const lazy2 = new SlotMap(ctx2);
  for (const key of fixture.reads) lazy2.getOrInsertWith(key, factory);
  assertSameSet(lazy2.presentKeys(), expected.lazy_present_after_reads, "lazy_present_after_reads");
});

// --- conformance: deferral_not_deallocation.json ---------------------------
test("SlotMap materialization conformance: deferral_not_deallocation.json", () => {
  const fixture = loadFixture("deferral_not_deallocation.json");
  const { spec, expected } = fixture;
  const keys = Object.keys(spec.val);
  const factory = (k) => spec.val[k];

  const ctx = new Context();
  const eager = eagerSlotMap(ctx, keys, factory);
  assertSameSet(eager.presentKeys(), expected.eager_present, "eager_present");

  const lazy = new SlotMap(ctx);
  const sizes = [];
  for (const key of fixture.reads) {
    const before = lazy.getOrInsertWith(key, factory); // materialize_preserves_observe
    assert.equal(before, spec.val[key], `observe[${key}]`);
    sizes.push(lazy.presentCount());
  }

  // materialize_present_monotone: re-reads do not grow the set.
  assert.deepEqual(sizes, expected.present_after_each_read, "present_after_each_read");
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(sizes[i] >= sizes[i - 1], "present count is monotone");
  }

  // lazy_present_subset_eager: final lazy present set ⊆ eager present set.
  assertSameSet(lazy.presentKeys(), expected.lazy_present_after_reads, "lazy_present_after_reads");
  const eagerSet = new Set(expected.eager_present.map(String));
  for (const k of lazy.presentKeys()) {
    assert.ok(eagerSet.has(String(k)), `lazy key ${k} ⊆ eager present`);
  }
});

// --- conformance: entry_kind_orthogonal_to_mode.json -----------------------
// A single ReactiveMap fixes one handle kind, so a mixed-kind fixture is modelled
// by a CellMap over the cell entries and a SlotMap over the slot entries —
// sharing one logical key space (mirrors the Rust conformance harness).
test("materialization conformance: entry_kind_orthogonal_to_mode.json", () => {
  const fixture = loadFixture("entry_kind_orthogonal_to_mode.json");
  const { spec, expected } = fixture;
  const cellKeys = [];
  const slotKeys = [];
  const lookup = (k) => spec.entries[k].val;
  for (const [key, entry] of Object.entries(spec.entries)) {
    (entry.kind === "cell" ? cellKeys : slotKeys).push(key);
  }

  // Eager build: every entry present (cells + slots).
  const ctxE = new Context();
  const eagerCells = new CellMap(ctxE);
  for (const k of cellKeys) eagerCells.entry(k, lookup(k));
  const eagerSlots = new SlotMap(ctxE);
  eagerSlots.materializeAll(slotKeys, lookup);
  assert.equal(eagerCells.entryKind(), EntryKind.Cell);
  assert.equal(eagerSlots.entryKind(), EntryKind.Slot);
  assertSameSet(
    [...eagerCells.presentKeys(), ...eagerSlots.presentKeys()],
    expected.eager_present,
    "eager_present",
  );
  for (const [key, value] of Object.entries(expected.observe)) {
    const got = cellKeys.includes(key) ? eagerCells.get(key) : eagerSlots.get(key);
    assert.equal(got, value, `eager observe[${key}]`);
  }

  // Lazy build: cells present at build (always materialized); slots deferred.
  const ctxL = new Context();
  const lazyCells = new CellMap(ctxL);
  for (const k of cellKeys) lazyCells.entry(k, lookup(k));
  const lazySlots = new SlotMap(ctxL);
  assertSameSet(lazyCells.presentKeys(), expected.lazy_present_at_build, "lazy_present_at_build");
  assert.equal(lazySlots.presentCount(), 0, "slots deferred at build");

  for (const key of fixture.reads) {
    if (slotKeys.includes(key)) lazySlots.getOrInsertWith(key, lookup);
    else lazyCells.getOrInsertWith(key, lookup);
  }
  assertSameSet(
    [...lazyCells.presentKeys(), ...lazySlots.presentKeys()],
    expected.lazy_present_after_reads,
    "lazy_present_after_reads",
  );
  for (const [key, value] of Object.entries(expected.observe)) {
    const got = cellKeys.includes(key)
      ? lazyCells.get(key)
      : lazySlots.getOrInsertWith(key, lookup);
    assert.equal(got, value, `lazy observe[${key}]`);
  }
});

// --- unit: CellMap eager value-minting + membership reactivity --------------
test("CellMap: entry caches one cell per key; get_or_insert mints once", () => {
  const ctx = new Context();
  const map = new CellMap(ctx);
  const a1 = map.entry("a", 1);
  const a2 = map.entry("a", 999);
  assert.equal(a1.id, a2.id, "same key -> same cell; second default ignored");
  assert.equal(ctx.get(a1), 1);
  assert.equal(map.lenUntracked(), 1);

  // getOrInsertWith mints once then returns existing (factory not re-run).
  let calls = 0;
  assert.equal(
    map.getOrInsertWith("b", () => {
      calls++;
      return 7;
    }),
    7,
  );
  assert.equal(
    map.getOrInsertWith("b", () => {
      calls++;
      return 999;
    }),
    7,
  );
  assert.equal(calls, 1);

  // An explicit set is observed by a subsequent getOrInsertWith.
  map.set("b", 42);
  assert.equal(map.getOrInsertWith("b", () => 0), 42);
});

test("CellMap: membership is reactive but value changes are not", () => {
  const ctx = new Context();
  const map = new CellMap(ctx);
  const a = map.entry("a", 1);
  map.entry("b", 2);

  const count = ctx.computed(() => map.len());
  assert.equal(ctx.get(count), 2);

  // Mutating an existing entry must NOT invalidate the membership reader.
  ctx.set(a, 100);
  assert.ok(ctx.isSet(count), "membership reader stayed cached");
  assert.equal(ctx.get(count), 2);

  // Adding a key DOES invalidate it.
  map.entry("c", 3);
  assert.equal(ctx.get(count), 3);

  // Removing a key invalidates it too.
  assert.ok(map.remove("b"));
  assert.equal(ctx.get(count), 2);
  assert.deepEqual(map.keys(), ["a", "c"]);
});

test("ReactiveMap: per-entry reads are independent", () => {
  const ctx = new Context();
  const map = new CellMap(ctx);
  const a = map.entry("a", 1);
  const b = map.entry("b", 2);

  const viewA = ctx.computed(() => (map.get("a") ?? 0) * 10);
  assert.equal(ctx.get(viewA), 10);

  // Changing b must not invalidate a's reader.
  ctx.set(b, 222);
  assert.ok(ctx.isSet(viewA), "sibling change must not invalidate");
  assert.equal(ctx.get(viewA), 10);

  // Changing a does.
  ctx.set(a, 5);
  assert.equal(ctx.get(viewA), 50);
});

test("SlotMap: mints lazily on pull and caches (no re-mint)", () => {
  const ctx = new Context();
  const map = new SlotMap(ctx);
  assert.equal(map.presentCount(), 0);
  assert.equal(map.isPresent(7), false);
  assert.equal(map.getOrInsertWith(7, (k) => k * 2), 14);
  assert.equal(map.presentCount(), 1);
  assert.ok(map.isPresent(7));
  const h = map.handle(7);
  assert.equal(ctx.get(h), 14);
  assert.equal(map.getOrInsertWith(7, (k) => k * 999), 14, "factory not re-run");
});

test("SlotMap: materializeAll is eager", () => {
  const ctx = new Context();
  const map = new SlotMap(ctx);
  map.materializeAll([0, 1, 2, 5, 9], (k) => k * 3);
  assert.equal(map.presentCount(), 5);
  for (const k of [0, 1, 2, 5, 9]) assert.ok(map.isPresent(k));
  assert.equal(map.get(5), 15);
  assert.equal(map.entryKind(), EntryKind.Slot);
});

test("SlotMap has no set; ReactiveMap default kind is Slot", () => {
  const ctx = new Context();
  const map = new SlotMap(ctx);
  assert.equal(typeof map.set, "undefined", "SlotMap has no set");
  const plain = new ReactiveMap(ctx);
  assert.equal(plain.entryKind(), EntryKind.Slot, "default kind is Slot");
});

// --- unit: atomic move (#lzcellmove) ---------------------------------------
test("moveTo reorders keys and keeps cell identity", () => {
  const ctx = new Context();
  const map = new CellMap(ctx);
  const a = map.entry("a", 1);
  map.entry("b", 2);
  map.entry("c", 3);
  assert.deepEqual(map.keys(), ["a", "b", "c"]);

  assert.ok(map.moveTo("c", 0));
  assert.deepEqual(map.keys(), ["c", "a", "b"]);

  // The moved entries keep the SAME value cells (identity + value intact).
  assert.equal(map.handle("a").id, a.id);
  assert.equal(map.get("a"), 1);
  assert.equal(map.get("c"), 3);

  // Absent key -> false, no reorder.
  assert.ok(!map.moveTo("z", 0));
  assert.deepEqual(map.keys(), ["c", "a", "b"]);
});

test("pure move invalidates order but not membership readers", () => {
  const ctx = new Context();
  const map = new CellMap(ctx);
  map.entry("a", 1);
  map.entry("b", 2);
  map.entry("c", 3);

  const orderReader = ctx.computed(() => map.keys().join(","));
  const count = ctx.computed(() => map.len());
  const hasB = ctx.computed(() => map.containsKey("b"));
  assert.equal(ctx.get(orderReader), "a,b,c");
  assert.equal(ctx.get(count), 3);
  assert.ok(ctx.get(hasB));

  // A pure reorder must invalidate the order reader...
  assert.ok(map.moveTo("a", 2));
  assert.equal(ctx.get(orderReader), "b,c,a");
  // ...but NOT the set-identity readers (len / containsKey stay cached).
  assert.ok(ctx.isSet(count), "len reader must stay cached on pure move");
  assert.ok(ctx.isSet(hasB), "containsKey reader must stay cached on pure move");
  assert.equal(ctx.get(count), 3);
});

test("moveBefore / moveAfter place relative to anchor", () => {
  const ctx = new Context();
  const map = new CellMap(ctx);
  for (let k = 0; k < 4; k++) map.entry(k, k * 10);
  assert.deepEqual(map.keys(), [0, 1, 2, 3]);

  assert.ok(map.moveBefore(3, 1));
  assert.deepEqual(map.keys(), [0, 3, 1, 2]);

  assert.ok(map.moveAfter(0, 2));
  assert.deepEqual(map.keys(), [3, 1, 2, 0]);

  assert.ok(!map.moveBefore(3, 99));
  assert.ok(!map.moveAfter(99, 2));
});

test("containsKey tracks membership", () => {
  const ctx = new Context();
  const map = new CellMap(ctx);
  const has5 = ctx.computed(() => map.containsKey(5));
  assert.ok(!ctx.get(has5));
  map.entry(5, 50);
  assert.ok(ctx.get(has5));
});
