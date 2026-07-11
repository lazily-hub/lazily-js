import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Context } from "../src/reactive.js";
import {
  DEFAULT_MATERIALIZATION_MODE,
  EntryKind,
  MaterializationMode,
  ReactiveFamily,
  cellFamily,
} from "../src/reactive-family.js";

const here = dirname(fileURLToPath(import.meta.url));
const specMaterialization = join(
  here,
  "..",
  "..",
  "lazily-spec",
  "conformance",
  "materialization",
);

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

// --- conformance: observational_transparency.json --------------------------
test("materialization conformance: observational_transparency.json", () => {
  const fixture = loadFixture("observational_transparency.json");
  const { spec, expected } = fixture;
  const keys = Object.keys(spec.val);
  const factory = (k) => spec.val[k];

  assert.equal(
    DEFAULT_MATERIALIZATION_MODE,
    expected.default_mode,
    "default mode must be eager",
  );

  const ctx = new Context();
  const eager = ReactiveFamily.eager(ctx, keys, factory);
  const lazy = ReactiveFamily.lazy(ctx, keys, factory);

  assert.equal(eager.mode, MaterializationMode.Eager);
  assert.equal(lazy.mode, MaterializationMode.Lazy);

  // eager_materializes_all: every declared key present up front.
  assertSameSet(eager.presentKeys(), expected.eager_present, "eager_present");
  // lazy_defers_slots: nothing materialized until read.
  assert.equal(lazy.presentCount(), 0, "lazy defers all slots at build");

  // observe_canonical / eager_lazy_observationally_equivalent: identical values.
  for (const [key, value] of Object.entries(expected.observe)) {
    assert.equal(eager.observe(key), value, `eager observe[${key}]`);
    assert.equal(lazy.observe(key), value, `lazy observe[${key}]`);
  }

  // Rebuild a fresh lazy family to observe only the `reads` sequence.
  const ctx2 = new Context();
  const lazy2 = ReactiveFamily.lazy(ctx2, keys, factory);
  for (const key of fixture.reads) lazy2.observe(key);
  assertSameSet(
    lazy2.presentKeys(),
    expected.lazy_present_after_reads,
    "lazy_present_after_reads",
  );
});

// --- conformance: deferral_not_deallocation.json ---------------------------
test("materialization conformance: deferral_not_deallocation.json", () => {
  const fixture = loadFixture("deferral_not_deallocation.json");
  const { spec, expected } = fixture;
  const keys = Object.keys(spec.val);
  const factory = (k) => spec.val[k];

  assert.equal(DEFAULT_MATERIALIZATION_MODE, expected.default_mode);

  const ctx = new Context();
  const eager = ReactiveFamily.eager(ctx, keys, factory);
  assertSameSet(eager.presentKeys(), expected.eager_present, "eager_present");

  const lazy = ReactiveFamily.lazy(ctx, keys, factory);
  const sizes = [];
  for (const key of fixture.reads) {
    const before = lazy.observe(key); // materialize_preserves_observe
    assert.equal(before, spec.val[key], `observe[${key}]`);
    sizes.push(lazy.presentCount());
  }

  // materialize_present_monotone: re-reads do not grow the set; sizes are the
  // cumulative present-set sizes and non-decreasing.
  assert.deepEqual(
    sizes,
    expected.present_after_each_read,
    "present_after_each_read",
  );
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(sizes[i] >= sizes[i - 1], "present count is monotone");
  }

  // lazy_present_subset_eager: final lazy present set ⊆ eager present set.
  assertSameSet(
    lazy.presentKeys(),
    expected.lazy_present_after_reads,
    "lazy_present_after_reads",
  );
  const eagerSet = new Set(expected.eager_present.map(String));
  for (const k of lazy.presentKeys()) {
    assert.ok(eagerSet.has(String(k)), `lazy key ${k} ⊆ eager present`);
  }
});

// --- conformance: entry_kind_orthogonal_to_mode.json -----------------------
test("materialization conformance: entry_kind_orthogonal_to_mode.json", () => {
  const fixture = loadFixture("entry_kind_orthogonal_to_mode.json");
  const { spec, expected } = fixture;
  const keys = Object.keys(spec.entries);
  const factory = (k) => spec.entries[k].val;
  const kindOf = (k) =>
    spec.entries[k].kind === "cell" ? EntryKind.Cell : EntryKind.Slot;

  // Eager: all entries present.
  const ctxE = new Context();
  const eager = ReactiveFamily.eager(ctxE, keys, factory, kindOf);
  assertSameSet(eager.presentKeys(), expected.eager_present, "eager_present");
  for (const [key, value] of Object.entries(expected.observe)) {
    assert.equal(eager.observe(key), value, `eager observe[${key}]`);
  }

  // Lazy: cell entries present at build (cell_entries_materialized_in_every_mode);
  // slot entries deferred (slot_entries_deferred_under_lazy).
  const ctxL = new Context();
  const lazy = ReactiveFamily.lazy(ctxL, keys, factory, kindOf);
  assertSameSet(
    lazy.presentKeys(),
    expected.lazy_present_at_build,
    "lazy_present_at_build",
  );
  for (const key of keys) {
    assert.equal(lazy.entryKind(key), kindOf(key), `entryKind[${key}]`);
  }

  for (const key of fixture.reads) lazy.observe(key);
  assertSameSet(
    lazy.presentKeys(),
    expected.lazy_present_after_reads,
    "lazy_present_after_reads",
  );
  for (const [key, value] of Object.entries(expected.observe)) {
    assert.equal(lazy.observe(key), value, `lazy observe[${key}]`);
  }
});

// --- unit: default mode + reactivity orthogonality -------------------------
test("default mode is eager", () => {
  assert.equal(DEFAULT_MATERIALIZATION_MODE, MaterializationMode.Eager);
  const ctx = new Context();
  const fam = ReactiveFamily.create(ctx, [1, 2, 3], (k) => k * 3);
  assert.equal(fam.mode, MaterializationMode.Eager);
  assert.equal(fam.presentCount(), 3);
});

test("lazy get materializes on pull and caches (no re-mint)", () => {
  const ctx = new Context();
  const fam = ReactiveFamily.lazy(ctx, [0, 1, 2, 5, 9], (k) => k * 3);
  assert.equal(fam.presentCount(), 0);
  assert.equal(fam.isPresent(5), false);

  const h1 = fam.get(5);
  const h2 = fam.get(5);
  assert.equal(h1.id, h2.id, "same handle on re-get");
  assert.equal(fam.observe(5), 15);
  assert.deepEqual(fam.presentKeys(), [5]);
});

test("cellFamily entries are always materialized and writable inputs", () => {
  const ctx = new Context();
  for (const mode of [MaterializationMode.Eager, MaterializationMode.Lazy]) {
    const fam = cellFamily(ctx, ["a", "b", "c"], () => 0, mode);
    assert.equal(fam.entryKind("a"), EntryKind.Cell);
    assert.equal(fam.presentCount(), 3, `cells present at build (${mode})`);
  }
  const fam = cellFamily(ctx, ["x"], () => 1);
  fam.setCell("x", 42);
  assert.equal(fam.observe("x"), 42);
});

test("setCell on a derived slot entry throws", () => {
  const ctx = new Context();
  const fam = ReactiveFamily.eager(ctx, ["s"], (k) => k.length);
  assert.throws(() => fam.setCell("s", 9), /derived slot/);
});

test("lazy derived entries stay reactive to their inputs", () => {
  // Materialization mode is orthogonal to reactivity: a lazily-materialized
  // slot still tracks a cell it reads.
  const ctx = new Context();
  const base = ctx.cell(10);
  const fam = ReactiveFamily.lazy(ctx, ["double"], () => ctx.getCell(base) * 2);
  assert.equal(fam.observe("double"), 20);
  ctx.setCell(base, 15);
  assert.equal(fam.observe("double"), 30);
});
