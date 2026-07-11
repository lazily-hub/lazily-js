import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { AsyncContext } from "../src/reactive-async.js";
import {
  AsyncReactiveFamily,
  DEFAULT_MATERIALIZATION_MODE,
  EntryKind,
  MaterializationMode,
  asyncCellFamily,
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

// --- conformance replayed through the ASYNC family (eventual transparency) ---
// A derived slot observes as `undefined` until driven; `resolve` awaits the
// canonical value. Once resolved, eager ≡ lazy — the AsyncMaterialization proof.
test("async materialization conformance: observational_transparency.json", async () => {
  const fixture = loadFixture("observational_transparency.json");
  const { spec, expected } = fixture;
  const keys = Object.keys(spec.val);
  const factory = (k) => spec.val[k];

  assert.equal(DEFAULT_MATERIALIZATION_MODE, expected.default_mode);

  const ctx = new AsyncContext();
  const eager = AsyncReactiveFamily.eager(ctx, keys, factory);
  const lazy = AsyncReactiveFamily.lazy(ctx, keys, factory);

  assert.equal(eager.mode, MaterializationMode.Eager);
  assert.equal(lazy.mode, MaterializationMode.Lazy);

  assertSameSet(eager.presentKeys(), expected.eager_present, "eager_present");
  assert.equal(lazy.presentCount(), 0, "lazy defers all slots at build");

  for (const [key, value] of Object.entries(expected.observe)) {
    assert.equal(await eager.resolve(key), value, `eager resolve[${key}]`);
    assert.equal(await lazy.resolve(key), value, `lazy resolve[${key}]`);
  }

  const ctx2 = new AsyncContext();
  const lazy2 = AsyncReactiveFamily.lazy(ctx2, keys, factory);
  for (const key of fixture.reads) await lazy2.resolve(key);
  assertSameSet(lazy2.presentKeys(), expected.lazy_present_after_reads, "lazy_present_after_reads");
});

test("async materialization conformance: deferral_not_deallocation.json", async () => {
  const fixture = loadFixture("deferral_not_deallocation.json");
  const { spec, expected } = fixture;
  const keys = Object.keys(spec.val);
  const factory = (k) => spec.val[k];

  const ctx = new AsyncContext();
  const eager = AsyncReactiveFamily.eager(ctx, keys, factory);
  assertSameSet(eager.presentKeys(), expected.eager_present, "eager_present");

  const lazy = AsyncReactiveFamily.lazy(ctx, keys, factory);
  const sizes = [];
  for (const key of fixture.reads) {
    assert.equal(await lazy.resolve(key), spec.val[key], `resolve[${key}]`);
    sizes.push(lazy.presentCount());
  }
  assert.deepEqual(sizes, expected.present_after_each_read, "present_after_each_read");
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(sizes[i] >= sizes[i - 1], "present count is monotone");
  }
  assertSameSet(lazy.presentKeys(), expected.lazy_present_after_reads, "lazy_present_after_reads");
});

test("async materialization conformance: entry_kind_orthogonal_to_mode.json", async () => {
  const fixture = loadFixture("entry_kind_orthogonal_to_mode.json");
  const { spec, expected } = fixture;
  const keys = Object.keys(spec.entries);
  const factory = (k) => spec.entries[k].val;
  const kindOf = (k) => (spec.entries[k].kind === "cell" ? EntryKind.Cell : EntryKind.Slot);

  const ctxE = new AsyncContext();
  const eager = AsyncReactiveFamily.eager(ctxE, keys, factory, kindOf);
  assertSameSet(eager.presentKeys(), expected.eager_present, "eager_present");
  for (const [key, value] of Object.entries(expected.observe)) {
    assert.equal(await eager.resolve(key), value, `eager resolve[${key}]`);
  }

  const ctxL = new AsyncContext();
  const lazy = AsyncReactiveFamily.lazy(ctxL, keys, factory, kindOf);
  // Cell entries always present at build; slot entries deferred.
  assertSameSet(lazy.presentKeys(), expected.lazy_present_at_build, "lazy_present_at_build");
  for (const key of keys) {
    assert.equal(lazy.entryKind(key), kindOf(key), `entryKind[${key}]`);
  }
  for (const key of fixture.reads) await lazy.resolve(key);
  assertSameSet(lazy.presentKeys(), expected.lazy_present_after_reads, "lazy_present_after_reads");
});

// --- unit ------------------------------------------------------------------
test("async: eventual transparency — pending observes undefined then resolves", async () => {
  const ctx = new AsyncContext();
  const fam = AsyncReactiveFamily.lazy(ctx, [], (k) => k * 10);
  const h = fam.get(4);
  assert.ok(h);
  assert.equal(fam.isPresent(4), true);
  assert.equal(fam.observe(4), undefined, "pending slot observes undefined");
  assert.equal(await fam.resolve(4), 40);
  assert.equal(fam.observe(4), 40, "resolved slot observes the canonical value");
});

test("async: eager cell family resolves immediately and reacts to set", async () => {
  const ctx = new AsyncContext();
  const fam = asyncCellFamily(ctx, [10, 20], () => true);
  assert.equal(fam.entryKind(10), EntryKind.Cell);
  assert.equal(fam.presentCount(), 2);
  assert.equal(fam.observe(20), true, "cells are always resolved");
  fam.setCell(20, false);
  assert.equal(fam.observe(20), false);
});

test("async: present set grows monotonically, first-writer-wins handle", async () => {
  const ctx = new AsyncContext();
  const fam = AsyncReactiveFamily.lazy(ctx, [], (k) => k);
  const a = fam.get(5);
  const b = fam.get(5);
  assert.equal(a.id, b.id, "stable handle on re-get");
  fam.get(9);
  assert.equal(fam.presentCount(), 2);
  assert.deepEqual(fam.presentKeys(), [5, 9]);
});

test("async: setCell on a derived slot entry throws", () => {
  const ctx = new AsyncContext();
  const fam = AsyncReactiveFamily.eager(ctx, ["s"], (k) => k.length);
  assert.throws(() => fam.setCell("s", 9), /derived slot/);
});
