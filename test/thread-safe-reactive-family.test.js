import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ThreadSafeContext } from "../src/thread-safe.js";
import {
  EntryKind,
  ThreadSafeCellMap,
  ThreadSafeReactiveMap,
  ThreadSafeSlotMap,
} from "../src/thread-safe-reactive-family.js";

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
  const map = new ThreadSafeSlotMap(ctx);
  map.materializeAll(keys, factory);
  return map;
}

// --- conformance replayed through the THREAD-SAFE SlotMap -------------------
test("thread-safe SlotMap conformance: observational_transparency.json", () => {
  const fixture = loadFixture("observational_transparency.json");
  const { spec, expected } = fixture;
  const keys = Object.keys(spec.val);
  const factory = (k) => spec.val[k];

  assert.equal(expected.default_mode, "eager");

  const ctx = new ThreadSafeContext();
  const eager = eagerSlotMap(ctx, keys, factory);
  const lazy = new ThreadSafeSlotMap(ctx);

  assertSameSet(eager.presentKeys(), expected.eager_present, "eager_present");
  assert.equal(lazy.presentCount(), 0);

  for (const [key, value] of Object.entries(expected.observe)) {
    assert.equal(eager.observe(key), value, `eager observe[${key}]`);
    assert.equal(lazy.getOrInsertWith(key, factory), value, `lazy observe[${key}]`);
  }

  const ctx2 = new ThreadSafeContext();
  const lazy2 = new ThreadSafeSlotMap(ctx2);
  for (const key of fixture.reads) lazy2.getOrInsertWith(key, factory);
  assertSameSet(lazy2.presentKeys(), expected.lazy_present_after_reads, "lazy_present_after_reads");
});

test("thread-safe SlotMap conformance: deferral_not_deallocation.json", () => {
  const fixture = loadFixture("deferral_not_deallocation.json");
  const { spec, expected } = fixture;
  const keys = Object.keys(spec.val);
  const factory = (k) => spec.val[k];

  const ctx = new ThreadSafeContext();
  const eager = eagerSlotMap(ctx, keys, factory);
  assertSameSet(eager.presentKeys(), expected.eager_present, "eager_present");

  const lazy = new ThreadSafeSlotMap(ctx);
  const sizes = [];
  for (const key of fixture.reads) {
    assert.equal(lazy.getOrInsertWith(key, factory), spec.val[key], `observe[${key}]`);
    sizes.push(lazy.presentCount());
  }
  assert.deepEqual(sizes, expected.present_after_each_read, "present_after_each_read");
  assertSameSet(lazy.presentKeys(), expected.lazy_present_after_reads, "lazy_present_after_reads");
});

test("thread-safe conformance: entry_kind_orthogonal_to_mode.json (CellMap + SlotMap)", () => {
  const fixture = loadFixture("entry_kind_orthogonal_to_mode.json");
  const { spec, expected } = fixture;
  const cellKeys = [];
  const slotKeys = [];
  const lookup = (k) => spec.entries[k].val;
  for (const [key, entry] of Object.entries(spec.entries)) {
    (entry.kind === "cell" ? cellKeys : slotKeys).push(key);
  }

  const ctxE = new ThreadSafeContext();
  const eagerCells = new ThreadSafeCellMap(ctxE);
  for (const k of cellKeys) eagerCells.set(k, lookup(k));
  const eagerSlots = new ThreadSafeSlotMap(ctxE);
  eagerSlots.materializeAll(slotKeys, lookup);
  assertSameSet(
    [...eagerCells.presentKeys(), ...eagerSlots.presentKeys()],
    expected.eager_present,
    "eager_present",
  );
  for (const [key, value] of Object.entries(expected.observe)) {
    const got = cellKeys.includes(key) ? eagerCells.observe(key) : eagerSlots.observe(key);
    assert.equal(got, value, `eager observe[${key}]`);
  }

  const ctxL = new ThreadSafeContext();
  const lazyCells = new ThreadSafeCellMap(ctxL);
  for (const k of cellKeys) lazyCells.set(k, lookup(k));
  const lazySlots = new ThreadSafeSlotMap(ctxL);
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
});

// --- materialization confluence (materialize_present_comm / observe_comm) ---
test("thread-safe: materialization is confluent — order-independent present set + values", () => {
  const factory = (k) => k * 7;
  const keysToPull = [3, 1, 4, 1, 5, 9, 2, 6];

  const ctxA = new ThreadSafeContext();
  const mapA = new ThreadSafeSlotMap(ctxA);
  for (const k of keysToPull) mapA.getOrInsertWith(k, factory);

  const ctxB = new ThreadSafeContext();
  const mapB = new ThreadSafeSlotMap(ctxB);
  for (const k of [...keysToPull].reverse()) mapB.getOrInsertWith(k, factory);

  assertSameSet(mapA.presentKeys(), mapB.presentKeys(), "present set order-independent");
  const uniq = [...new Set(keysToPull)];
  for (const k of uniq) {
    assert.equal(mapA.observe(k), mapB.observe(k), `observe[${k}] order-independent`);
    assert.equal(mapA.observe(k), factory(k), `observe[${k}] canonical`);
  }
  assert.equal(mapA.presentCount(), uniq.length);
});

test("thread-safe: CellMap is writable + always materialized; SlotMap has no set", () => {
  const ctx = new ThreadSafeContext();
  const cells = new ThreadSafeCellMap(ctx);
  cells.set("a", 0);
  cells.set("b", 0);
  assert.equal(cells.entryKind(), EntryKind.Cell);
  assert.equal(cells.presentCount(), 2);
  cells.set("a", 99);
  assert.equal(cells.observe("a"), 99);

  const slots = new ThreadSafeSlotMap(ctx);
  assert.equal(typeof slots.set, "undefined", "SlotMap has no set");
});

test("thread-safe: lazy getOrInsertHandle materializes with a stable handle", () => {
  const ctx = new ThreadSafeContext();
  const map = new ThreadSafeSlotMap(ctx);
  assert.equal(map.isPresent(5), false);
  const h1 = map.getOrInsertHandle(5, (k) => k * 3);
  const h2 = map.getOrInsertHandle(5, (k) => k * 3);
  assert.equal(h1.id, h2.id, "stable handle on re-get");
  assert.equal(map.observe(5), 15);
  assert.deepEqual(map.presentKeys(), [5]);
  assert.equal(map.entryKind(), EntryKind.Slot);
  assert.ok(new ThreadSafeReactiveMap(ctx).entryKind() === EntryKind.Slot);
});
