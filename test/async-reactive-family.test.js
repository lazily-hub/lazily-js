import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AsyncContext } from "../src/reactive-async.js";
import {
  AsyncCellMap,
  AsyncReactiveMap,
  AsyncSlotMap,
  EntryKind,
} from "../src/async-reactive-family.js";

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

function eagerSlotMap(ctx, keys, factory) {
  const map = new AsyncSlotMap(ctx);
  map.materializeAll(keys, factory);
  return map;
}

// --- conformance replayed through the ASYNC SlotMap (eventual transparency) --
// A derived slot observes as `undefined` until driven; `resolve` awaits the
// canonical value. Once resolved, eager ≡ lazy — the AsyncMaterialization proof.
test("async SlotMap conformance: observational_transparency.json", async () => {
  const fixture = loadFixture("observational_transparency.json");
  const { spec, expected } = fixture;
  const keys = Object.keys(spec.val);
  const factory = (k) => spec.val[k];

  assert.equal(expected.default_mode, "eager");

  const ctxE = new AsyncContext();
  const eager = eagerSlotMap(ctxE, keys, factory);
  const ctxL = new AsyncContext();
  const lazy = new AsyncSlotMap(ctxL);

  // Present-set laws (allocation axis, unchanged by async resolution).
  assertSameSet(eager.presentKeys(), expected.eager_present, "eager_present");
  assert.equal(lazy.presentCount(), 0, "lazy defers all slots at build");

  // Eventual transparency: drive each slot; resolved value = canonical.
  for (const [key, value] of Object.entries(expected.observe)) {
    assert.equal(await eager.resolve(key), value, `eager resolve[${key}]`);
    assert.equal(await lazy.resolve(key, factory), value, `lazy resolve[${key}]`);
  }

  const ctx2 = new AsyncContext();
  const lazy2 = new AsyncSlotMap(ctx2);
  for (const key of fixture.reads) lazy2.getOrInsertHandle(key, factory);
  assertSameSet(lazy2.presentKeys(), expected.lazy_present_after_reads, "lazy_present_after_reads");
});

test("async SlotMap conformance: deferral_not_deallocation.json", async () => {
  const fixture = loadFixture("deferral_not_deallocation.json");
  const { spec, expected } = fixture;
  const factory = (k) => spec.val[k];

  const ctx = new AsyncContext();
  const eager = eagerSlotMap(ctx, Object.keys(spec.val), factory);
  assertSameSet(eager.presentKeys(), expected.eager_present, "eager_present");

  const lazy = new AsyncSlotMap(ctx);
  const sizes = [];
  for (const key of fixture.reads) {
    assert.equal(await lazy.resolve(key, factory), spec.val[key], `resolve[${key}]`);
    sizes.push(lazy.presentCount());
  }
  assert.deepEqual(sizes, expected.present_after_each_read, "present_after_each_read");
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(sizes[i] >= sizes[i - 1], "present count is monotone");
  }
  assertSameSet(lazy.presentKeys(), expected.lazy_present_after_reads, "lazy_present_after_reads");
});

test("async conformance: entry_kind_orthogonal_to_mode.json (CellMap + SlotMap)", async () => {
  const fixture = loadFixture("entry_kind_orthogonal_to_mode.json");
  const { spec, expected } = fixture;
  const cellKeys = [];
  const slotKeys = [];
  const lookup = (k) => spec.entries[k].val;
  for (const [key, entry] of Object.entries(spec.entries)) {
    (entry.kind === "cell" ? cellKeys : slotKeys).push(key);
  }

  const ctxE = new AsyncContext();
  const eagerCells = new AsyncCellMap(ctxE);
  for (const k of cellKeys) eagerCells.set(k, lookup(k));
  const eagerSlots = new AsyncSlotMap(ctxE);
  eagerSlots.materializeAll(slotKeys, lookup);
  assertSameSet(
    [...eagerCells.presentKeys(), ...eagerSlots.presentKeys()],
    expected.eager_present,
    "eager_present",
  );
  for (const [key, value] of Object.entries(expected.observe)) {
    const got = cellKeys.includes(key) ? await eagerCells.resolve(key) : await eagerSlots.resolve(key);
    assert.equal(got, value, `eager resolve[${key}]`);
  }

  const ctxL = new AsyncContext();
  const lazyCells = new AsyncCellMap(ctxL);
  for (const k of cellKeys) lazyCells.set(k, lookup(k));
  const lazySlots = new AsyncSlotMap(ctxL);
  assertSameSet(lazyCells.presentKeys(), expected.lazy_present_at_build, "lazy_present_at_build");
  assert.equal(lazySlots.presentCount(), 0, "slots deferred at build");
  for (const key of fixture.reads) {
    if (slotKeys.includes(key)) lazySlots.getOrInsertHandle(key, lookup);
    else lazyCells.getOrInsertHandle(key, lookup);
  }
  assertSameSet(
    [...lazyCells.presentKeys(), ...lazySlots.presentKeys()],
    expected.lazy_present_after_reads,
    "lazy_present_after_reads",
  );
});

// --- unit ------------------------------------------------------------------
test("async: eventual transparency — pending observes undefined then resolves", async () => {
  const ctx = new AsyncContext();
  const map = new AsyncSlotMap(ctx);
  const h = map.getOrInsertHandle(4, (k) => k * 10);
  assert.ok(h);
  assert.equal(map.isPresent(4), true);
  assert.equal(map.observe(4), undefined, "pending slot observes undefined");
  assert.equal(await map.resolve(4), 40);
  assert.equal(map.observe(4), 40, "resolved slot observes the canonical value");
});

test("async: CellMap resolves immediately and reacts to set; SlotMap has no set", async () => {
  const ctx = new AsyncContext();
  const cells = new AsyncCellMap(ctx);
  cells.set(10, true);
  cells.set(20, true);
  assert.equal(cells.entryKind(), EntryKind.Cell);
  assert.equal(cells.presentCount(), 2);
  assert.equal(cells.observe(20), true, "cells are always resolved");
  cells.set(20, false);
  assert.equal(cells.observe(20), false);

  const slots = new AsyncSlotMap(ctx);
  assert.equal(typeof slots.set, "undefined", "SlotMap has no set");
});

test("async: present set grows monotonically, first-writer-wins handle", async () => {
  const ctx = new AsyncContext();
  const map = new AsyncSlotMap(ctx);
  const a = map.getOrInsertHandle(5, (k) => k);
  const b = map.getOrInsertHandle(5, (k) => k);
  assert.equal(a.id, b.id, "stable handle on re-get");
  map.getOrInsertHandle(9, (k) => k);
  assert.equal(map.presentCount(), 2);
  assert.deepEqual(map.presentKeys(), [5, 9]);
  assert.equal(new AsyncReactiveMap(ctx).entryKind(), EntryKind.Slot);
});
