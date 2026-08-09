import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { assertKey, assertKeyWith, subBlock } from "./support/assert-key.js";

import { Context } from "../src/reactive.js";
import { SourceMap, EntryKind, ReactiveMap, ComputedMap } from "../src/reactive-family.js";

import { specPath } from "./spec-corpus.cjs";

// The corpus root — and the `LAZILY_SPEC_CONFORMANCE_DIR` override — comes from
// the ONE seam every runner shares (test/spec-corpus.cjs, #lzoverrideallrunners).
// This file used to compute both for itself, which is how the rest of the suite
// stayed unreachable by a corpus-perturbation probe.
const specMaterialization = specPath("materialization");

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

// The fixture's `kind` field is the spec's wire spelling for the entry handle
// kind. The v2 kernel renamed the node kinds to `Source` / `Computed`, so the
// canonical fixture will migrate from `"cell"` / `"slot"` to `"source"` /
// `"computed"`. Accept BOTH spellings; anything else is a hard error, never a
// silent default (an unknown kind must not quietly land in the slot bucket).
function fixtureEntryKind(key, kind) {
  if (kind === "cell" || kind === "source") return EntryKind.Source;
  if (kind === "slot" || kind === "computed") return EntryKind.Computed;
  throw new TypeError(
    `entry_kind_orthogonal_to_mode.json: entry ${key} has unknown kind ${JSON.stringify(kind)}`,
  );
}

// An eager ComputedMap: pre-mint the whole keyset. A lazy ComputedMap: empty, minted on
// access via getOrInsertWith. There is no eager/lazy mode flag — eager is the
// pre-mint loop, lazy is mint-on-access (#reactivemap).
function eagerSlotMap(ctx, keys, factory) {
  const map = new ComputedMap(ctx);
  map.materializeAll(keys, factory);
  return map;
}

// `default_mode` (clause default_mode_eager) — the fixture's value SELECTS THE
// BUILD, and what is asserted is behavioural: a map built the way the fixture
// names its default is fully materialized at build time.
//
// Having no mode flag to read back is NOT a reason to excuse the key: lazily-cpp
// and lazily-cs have no flag either and both assert the behaviour. Nor is
// comparing the string to a hardcoded `"eager"` an assertion — that reddens on a
// corpus flip while saying nothing about the library, so an eager build that
// materialized nothing would still pass it (#lzconsumednotasserted). Read the
// string, DISPATCH on it, and count what the resulting map holds before any read.
//
// An unknown strategy is a hard failure, never a skip: a corpus that grows a
// third one must reach a runner that models it.
function computedMapPresentAtBuild(ctx, mode, keys, factory) {
  if (mode === "eager") return eagerSlotMap(ctx, keys, factory).presentCount();
  // Every entry of these two fixtures is a derived computed, so a map built the
  // lazy way holds nothing at all until something reads it.
  if (mode === "lazy") return new ComputedMap(ctx).presentCount();
  throw new TypeError(`unknown default_mode ${JSON.stringify(mode)}`);
}

function assertDefaultModeMaterializesAtBuild(expected, keys, factory) {
  assertKeyWith(expected, "default_mode", (mode) => {
    assert.equal(
      computedMapPresentAtBuild(new Context(), mode, keys, factory),
      keys.length,
      `a map built the fixture's default way (${mode}) is materialized at build`,
    );
  });
}

// --- conformance: observational_transparency.json --------------------------
test("ComputedMap materialization conformance: observational_transparency.json", () => {
  const fixture = loadFixture("observational_transparency.json");
  const { spec, expected } = fixture;
  const keys = Object.keys(spec.val);
  const factory = (k) => spec.val[k];

  // default_mode_eager: a map built the fixture's default way is materialized at
  // build (the string selects the build — see the dispatch above).
  assertDefaultModeMaterializesAtBuild(expected, keys, factory);

  const ctx = new Context();
  const eager = eagerSlotMap(ctx, keys, factory);
  const lazy = new ComputedMap(ctx);

  // eager_materializes_all: every declared key present up front.
  assertKeyWith(expected, "eager_present", (want) =>
    assertSameSet(eager.presentKeys(), want, "eager_present"),
  );
  // lazy_defers_slots: nothing materialized until read.
  assert.equal(lazy.presentCount(), 0, "lazy defers all slots at build");

  // observe_canonical / eager_lazy_observationally_equivalent: identical values.
  // Descended (#lzsubblockkeyset): the child tracker owns every key the
  // fixture observes, so one added upstream is reported as unconsumed rather
  // than skipped by a loop that only ever visits today's keys.
  const observe = subBlock(expected, "observe");
  for (const key of Object.keys(observe)) {
    assertKeyWith(
      observe,
      key,
      (value) => {
        assert.equal(eager.get(ctx, key), value, `eager observe[${key}]`);
        assert.equal(lazy.getOrInsertWith(ctx, key, factory), value, `lazy observe[${key}]`);
      },
      "observe",
    );
  }

  // Rebuild a fresh lazy map to observe only the `reads` sequence.
  const ctx2 = new Context();
  const lazy2 = new ComputedMap(ctx2);
  for (const key of fixture.reads) lazy2.getOrInsertWith(ctx2, key, factory);
  assertKeyWith(expected, "lazy_present_after_reads", (want) =>
    assertSameSet(lazy2.presentKeys(), want, "lazy_present_after_reads"),
  );
});

// --- conformance: deferral_not_deallocation.json ---------------------------
test("ComputedMap materialization conformance: deferral_not_deallocation.json", () => {
  const fixture = loadFixture("deferral_not_deallocation.json");
  const { spec, expected } = fixture;
  const keys = Object.keys(spec.val);
  const factory = (k) => spec.val[k];

  // default_mode_eager: same behavioural fact, this fixture's keyset.
  assertDefaultModeMaterializesAtBuild(expected, keys, factory);

  const ctx = new Context();
  const eager = eagerSlotMap(ctx, keys, factory);
  assertKeyWith(expected, "eager_present", (want) =>
    assertSameSet(eager.presentKeys(), want, "eager_present"),
  );

  // materialize_preserves_observe, stated over the whole map: the fixture's
  // `observe` block is the canonical value of EVERY key, and this runner only
  // ever compared the keys the `reads` sequence happens to touch.
  // Descended (#lzsubblockkeyset): the child tracker owns every key the
  // fixture observes, so one added upstream is reported as unconsumed rather
  // than skipped by a loop that only ever visits today's keys.
  const observe = subBlock(expected, "observe");
  for (const key of Object.keys(observe)) {
    assertKey(observe, key, eager.get(ctx, key), `eager observe[${key}]`);
  }

  const lazy = new ComputedMap(ctx);
  const sizes = [];
  for (const key of fixture.reads) {
    const before = lazy.getOrInsertWith(ctx, key, factory); // materialize_preserves_observe
    assert.equal(before, spec.val[key], `observe[${key}]`);
    sizes.push(lazy.presentCount());
  }

  // materialize_present_monotone: re-reads do not grow the set.
  assertKey(expected, "present_after_each_read", sizes, "present_after_each_read");
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(sizes[i] >= sizes[i - 1], "present count is monotone");
  }

  // lazy_present_subset_eager: final lazy present set ⊆ eager present set.
  assertKeyWith(expected, "lazy_present_after_reads", (want) =>
    assertSameSet(lazy.presentKeys(), want, "lazy_present_after_reads"),
  );
  const eagerSet = new Set(expected.eager_present.map(String));
  for (const k of lazy.presentKeys()) {
    assert.ok(eagerSet.has(String(k)), `lazy key ${k} ⊆ eager present`);
  }
});

// --- conformance: entry_kind_orthogonal_to_mode.json -----------------------
// A single ReactiveMap fixes one handle kind, so a mixed-kind fixture is modelled
// by a SourceMap over the cell entries and a ComputedMap over the slot entries —
// sharing one logical key space (mirrors the Rust conformance harness).
test("materialization conformance: entry_kind_orthogonal_to_mode.json", () => {
  const fixture = loadFixture("entry_kind_orthogonal_to_mode.json");
  const { spec, expected } = fixture;
  const cellKeys = [];
  const slotKeys = [];
  const lookup = (k) => spec.entries[k].val;
  for (const [key, entry] of Object.entries(spec.entries)) {
    (fixtureEntryKind(key, entry.kind) === EntryKind.Source ? cellKeys : slotKeys).push(key);
  }
  // The fixture is the mixed-kind one: prove the dispatch actually classified
  // entries into both buckets rather than dumping everything into one.
  assert.ok(cellKeys.length > 0, "fixture has source entries");
  assert.ok(slotKeys.length > 0, "fixture has computed entries");
  // default_mode_eager with the entry-kind split: source entries are present at
  // build under EVERY strategy, computed entries only under eager. So a map built
  // the fixture's default way holds every declared entry — four under `eager`,
  // and only the two sources under `lazy`, which is why this arm reddens on a
  // corpus flip as well as on a broken eager build.
  assertKeyWith(expected, "default_mode", (mode) => {
    const ctx = new Context();
    const cells = new SourceMap(ctx);
    for (const k of cellKeys) cells.entry(k, lookup(k));
    const slots = new ComputedMap(ctx);
    if (mode === "eager") slots.materializeAll(slotKeys, lookup);
    else if (mode !== "lazy") throw new TypeError(`unknown default_mode ${JSON.stringify(mode)}`);
    assert.equal(
      cells.presentCount() + slots.presentCount(),
      cellKeys.length + slotKeys.length,
      `a mixed-kind map built the fixture's default way (${mode}) is materialized at build`,
    );
  });

  // Eager build: every entry present (cells + slots).
  const ctxE = new Context();
  const eagerCells = new SourceMap(ctxE);
  for (const k of cellKeys) eagerCells.entry(k, lookup(k));
  const eagerSlots = new ComputedMap(ctxE);
  eagerSlots.materializeAll(slotKeys, lookup);
  assert.equal(eagerCells.entryKind(), EntryKind.Source);
  assert.equal(eagerSlots.entryKind(), EntryKind.Computed);
  assertKeyWith(expected, "eager_present", (want) =>
    assertSameSet(
      [...eagerCells.presentKeys(), ...eagerSlots.presentKeys()],
      want,
      "eager_present",
    ),
  );
  // Descended (#lzsubblockkeyset): the child tracker owns every key the
  // fixture observes, so one added upstream is reported as unconsumed rather
  // than skipped by a loop that only ever visits today's keys.
  const observeEager = subBlock(expected, "observe");
  for (const key of Object.keys(observeEager)) {
    const got = cellKeys.includes(key) ? eagerCells.get(ctxE, key) : eagerSlots.get(ctxE, key);
    assertKey(observeEager, key, got, `eager observe[${key}]`);
  }

  // Lazy build: cells present at build (always materialized); slots deferred.
  const ctxL = new Context();
  const lazyCells = new SourceMap(ctxL);
  for (const k of cellKeys) lazyCells.entry(k, lookup(k));
  const lazySlots = new ComputedMap(ctxL);
  assertKeyWith(expected, "lazy_present_at_build", (want) =>
    assertSameSet(lazyCells.presentKeys(), want, "lazy_present_at_build"),
  );
  assert.equal(lazySlots.presentCount(), 0, "slots deferred at build");

  for (const key of fixture.reads) {
    if (slotKeys.includes(key)) lazySlots.getOrInsertWith(ctxL, key, lookup);
    else lazyCells.getOrInsertWith(ctxL, key, lookup);
  }
  assertKeyWith(expected, "lazy_present_after_reads", (want) =>
    assertSameSet(
      [...lazyCells.presentKeys(), ...lazySlots.presentKeys()],
      want,
      "lazy_present_after_reads",
    ),
  );
  const observeLazy = subBlock(expected, "observe");
  for (const key of Object.keys(observeLazy)) {
    const got = cellKeys.includes(key)
      ? lazyCells.get(ctxL, key)
      : lazySlots.getOrInsertWith(ctxL, key, lookup);
    assertKey(observeLazy, key, got, `lazy observe[${key}]`);
  }
});

// The fixture `kind` reader is forward-compatible: it accepts the current wire
// spelling and the renamed one the spec will migrate to, and hard-errors on
// anything else instead of silently defaulting.
test("materialization conformance: fixture kind accepts both spellings, rejects unknown", () => {
  assert.equal(fixtureEntryKind("a", "cell"), EntryKind.Source);
  assert.equal(fixtureEntryKind("a", "source"), EntryKind.Source);
  assert.equal(fixtureEntryKind("b", "slot"), EntryKind.Computed);
  assert.equal(fixtureEntryKind("b", "computed"), EntryKind.Computed);
  for (const bad of ["Cell", "signal", "", undefined, null, 0]) {
    assert.throws(() => fixtureEntryKind("x", bad), TypeError, `unknown kind ${String(bad)}`);
  }
});

// The member names track the v2 kernel; the VALUE strings are wire data shared
// with the spec fixtures and every other binding runner, so they must not move.
test("EntryKind: renamed members keep the wire values and the old names alias", () => {
  assert.equal(EntryKind.Source, "cell");
  assert.equal(EntryKind.Computed, "slot");
  assert.equal(EntryKind.Cell, EntryKind.Source, "EntryKind.Cell is a deprecated alias");
  assert.equal(EntryKind.Slot, EntryKind.Computed, "EntryKind.Slot is a deprecated alias");
});

// --- unit: SourceMap eager value-minting + membership reactivity --------------
test("SourceMap: entry caches one cell per key; get_or_insert mints once", () => {
  const ctx = new Context();
  const map = new SourceMap(ctx);
  const a1 = map.entry("a", 1);
  const a2 = map.entry("a", 999);
  assert.equal(a1.id, a2.id, "same key -> same cell; second default ignored");
  assert.equal(ctx.get(a1), 1);
  assert.equal(map.lenUntracked(), 1);

  // getOrInsertWith mints once then returns existing (factory not re-run).
  let calls = 0;
  assert.equal(
    map.getOrInsertWith(ctx, "b", () => {
      calls++;
      return 7;
    }),
    7,
  );
  assert.equal(
    map.getOrInsertWith(ctx, "b", () => {
      calls++;
      return 999;
    }),
    7,
  );
  assert.equal(calls, 1);

  // An explicit set is observed by a subsequent getOrInsertWith.
  map.set("b", 42);
  assert.equal(
    map.getOrInsertWith(ctx, "b", () => 0),
    42,
  );
});

test("SourceMap: membership is reactive but value changes are not", () => {
  const ctx = new Context();
  const map = new SourceMap(ctx);
  const a = map.entry("a", 1);
  map.entry("b", 2);

  const count = ctx.computed((c) => map.len(c));
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
  assert.deepEqual(map.keys(ctx), ["a", "c"]);
});

test("ReactiveMap: per-entry reads are independent", () => {
  const ctx = new Context();
  const map = new SourceMap(ctx);
  const a = map.entry("a", 1);
  const b = map.entry("b", 2);

  const viewA = ctx.computed((c) => (map.get(c, "a") ?? 0) * 10);
  assert.equal(ctx.get(viewA), 10);

  // Changing b must not invalidate a's reader.
  ctx.set(b, 222);
  assert.ok(ctx.isSet(viewA), "sibling change must not invalidate");
  assert.equal(ctx.get(viewA), 10);

  // Changing a does.
  ctx.set(a, 5);
  assert.equal(ctx.get(viewA), 50);
});

test("ComputedMap: mints lazily on pull and caches (no re-mint)", () => {
  const ctx = new Context();
  const map = new ComputedMap(ctx);
  assert.equal(map.presentCount(), 0);
  assert.equal(map.isPresent(7), false);
  assert.equal(
    map.getOrInsertWith(ctx, 7, (k) => k * 2),
    14,
  );
  assert.equal(map.presentCount(), 1);
  assert.ok(map.isPresent(7));
  const h = map.handle(7);
  assert.equal(ctx.get(h), 14);
  assert.equal(
    map.getOrInsertWith(ctx, 7, (k) => k * 999),
    14,
    "factory not re-run",
  );
});

test("ComputedMap: materializeAll is eager", () => {
  const ctx = new Context();
  const map = new ComputedMap(ctx);
  map.materializeAll([0, 1, 2, 5, 9], (k) => k * 3);
  assert.equal(map.presentCount(), 5);
  for (const k of [0, 1, 2, 5, 9]) assert.ok(map.isPresent(k));
  assert.equal(map.get(ctx, 5), 15);
  assert.equal(map.entryKind(), EntryKind.Computed);
});

test("ComputedMap has no set; ReactiveMap default kind is Slot", () => {
  const ctx = new Context();
  const map = new ComputedMap(ctx);
  assert.equal(typeof map.set, "undefined", "ComputedMap has no set");
  const plain = new ReactiveMap(ctx);
  assert.equal(plain.entryKind(), EntryKind.Computed, "default kind is Slot");
});

// --- unit: atomic move (#lzcellmove) ---------------------------------------
test("moveTo reorders keys and keeps cell identity", () => {
  const ctx = new Context();
  const map = new SourceMap(ctx);
  const a = map.entry("a", 1);
  map.entry("b", 2);
  map.entry("c", 3);
  assert.deepEqual(map.keys(ctx), ["a", "b", "c"]);

  assert.ok(map.moveTo("c", 0));
  assert.deepEqual(map.keys(ctx), ["c", "a", "b"]);

  // The moved entries keep the SAME value cells (identity + value intact).
  assert.equal(map.handle("a").id, a.id);
  assert.equal(map.get(ctx, "a"), 1);
  assert.equal(map.get(ctx, "c"), 3);

  // Absent key -> false, no reorder.
  assert.ok(!map.moveTo("z", 0));
  assert.deepEqual(map.keys(ctx), ["c", "a", "b"]);
});

test("pure move invalidates order but not membership readers", () => {
  const ctx = new Context();
  const map = new SourceMap(ctx);
  map.entry("a", 1);
  map.entry("b", 2);
  map.entry("c", 3);

  const orderReader = ctx.computed((c) => map.keys(c).join(","));
  const count = ctx.computed((c) => map.len(c));
  const hasB = ctx.computed((c) => map.containsKey(c, "b"));
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
  const map = new SourceMap(ctx);
  for (let k = 0; k < 4; k++) map.entry(k, k * 10);
  assert.deepEqual(map.keys(ctx), [0, 1, 2, 3]);

  assert.ok(map.moveBefore(3, 1));
  assert.deepEqual(map.keys(ctx), [0, 3, 1, 2]);

  assert.ok(map.moveAfter(0, 2));
  assert.deepEqual(map.keys(ctx), [3, 1, 2, 0]);

  assert.ok(!map.moveBefore(3, 99));
  assert.ok(!map.moveAfter(99, 2));
});

test("containsKey tracks membership", () => {
  const ctx = new Context();
  const map = new SourceMap(ctx);
  const has5 = ctx.computed((c) => map.containsKey(c, 5));
  assert.ok(!ctx.get(has5));
  map.entry(5, 50);
  assert.ok(ctx.get(has5));
});
