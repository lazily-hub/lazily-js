import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ThreadSafeContext } from "../src/thread-safe.js";
import {
  DEFAULT_MATERIALIZATION_MODE,
  EntryKind,
  MaterializationMode,
  ThreadSafeReactiveFamily,
  threadSafeCellFamily,
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

// --- conformance replayed through the THREAD-SAFE family --------------------
test("thread-safe materialization conformance: observational_transparency.json", () => {
  const fixture = loadFixture("observational_transparency.json");
  const { spec, expected } = fixture;
  const keys = Object.keys(spec.val);
  const factory = (k) => spec.val[k];

  assert.equal(DEFAULT_MATERIALIZATION_MODE, expected.default_mode);

  const ctx = new ThreadSafeContext();
  const eager = ThreadSafeReactiveFamily.eager(ctx, keys, factory);
  const lazy = ThreadSafeReactiveFamily.lazy(ctx, keys, factory);

  assertSameSet(eager.presentKeys(), expected.eager_present, "eager_present");
  assert.equal(lazy.presentCount(), 0);

  for (const [key, value] of Object.entries(expected.observe)) {
    assert.equal(eager.observe(key), value, `eager observe[${key}]`);
    assert.equal(lazy.observe(key), value, `lazy observe[${key}]`);
  }

  const ctx2 = new ThreadSafeContext();
  const lazy2 = ThreadSafeReactiveFamily.lazy(ctx2, keys, factory);
  for (const key of fixture.reads) lazy2.observe(key);
  assertSameSet(lazy2.presentKeys(), expected.lazy_present_after_reads, "lazy_present_after_reads");
});

test("thread-safe materialization conformance: deferral_not_deallocation.json", () => {
  const fixture = loadFixture("deferral_not_deallocation.json");
  const { spec, expected } = fixture;
  const keys = Object.keys(spec.val);
  const factory = (k) => spec.val[k];

  const ctx = new ThreadSafeContext();
  const eager = ThreadSafeReactiveFamily.eager(ctx, keys, factory);
  assertSameSet(eager.presentKeys(), expected.eager_present, "eager_present");

  const lazy = ThreadSafeReactiveFamily.lazy(ctx, keys, factory);
  const sizes = [];
  for (const key of fixture.reads) {
    assert.equal(lazy.observe(key), spec.val[key], `observe[${key}]`);
    sizes.push(lazy.presentCount());
  }
  assert.deepEqual(sizes, expected.present_after_each_read, "present_after_each_read");
  assertSameSet(lazy.presentKeys(), expected.lazy_present_after_reads, "lazy_present_after_reads");
});

test("thread-safe materialization conformance: entry_kind_orthogonal_to_mode.json", () => {
  const fixture = loadFixture("entry_kind_orthogonal_to_mode.json");
  const { spec, expected } = fixture;
  const keys = Object.keys(spec.entries);
  const factory = (k) => spec.entries[k].val;
  const kindOf = (k) => (spec.entries[k].kind === "cell" ? EntryKind.Cell : EntryKind.Slot);

  const ctxE = new ThreadSafeContext();
  const eager = ThreadSafeReactiveFamily.eager(ctxE, keys, factory, kindOf);
  assertSameSet(eager.presentKeys(), expected.eager_present, "eager_present");
  for (const [key, value] of Object.entries(expected.observe)) {
    assert.equal(eager.observe(key), value, `eager observe[${key}]`);
  }

  const ctxL = new ThreadSafeContext();
  const lazy = ThreadSafeReactiveFamily.lazy(ctxL, keys, factory, kindOf);
  assertSameSet(lazy.presentKeys(), expected.lazy_present_at_build, "lazy_present_at_build");
  for (const key of fixture.reads) lazy.observe(key);
  assertSameSet(lazy.presentKeys(), expected.lazy_present_after_reads, "lazy_present_after_reads");
});

// --- materialization confluence (materialize_present_comm / observe_comm) ---
test("thread-safe: materialization is confluent — order-independent present set + values", () => {
  const factory = (k) => k * 7;
  const keysToPull = [3, 1, 4, 1, 5, 9, 2, 6];

  // Two families materialized in opposite orders reach the same present set and
  // observe identical values (the confluence theorems).
  const ctxA = new ThreadSafeContext();
  const famA = ThreadSafeReactiveFamily.lazy(ctxA, [], factory);
  for (const k of keysToPull) famA.observe(k);

  const ctxB = new ThreadSafeContext();
  const famB = ThreadSafeReactiveFamily.lazy(ctxB, [], factory);
  for (const k of [...keysToPull].reverse()) famB.observe(k);

  assertSameSet(famA.presentKeys(), famB.presentKeys(), "present set order-independent");
  const uniq = [...new Set(keysToPull)];
  for (const k of uniq) {
    assert.equal(famA.observe(k), famB.observe(k), `observe[${k}] order-independent`);
    assert.equal(famA.observe(k), factory(k), `observe[${k}] canonical`);
  }
  assert.equal(famA.presentCount(), uniq.length);
});

test("thread-safe: cell family is writable + always materialized; slot setCell throws", () => {
  const ctx = new ThreadSafeContext();
  const fam = threadSafeCellFamily(ctx, ["a", "b"], () => 0);
  assert.equal(fam.entryKind("a"), EntryKind.Cell);
  assert.equal(fam.presentCount(), 2);
  fam.setCell("a", 99);
  assert.equal(fam.observe("a"), 99);

  const slotFam = ThreadSafeReactiveFamily.eager(ctx, ["s"], (k) => k.length);
  assert.throws(() => slotFam.setCell("s", 1), /derived slot/);
});

test("thread-safe: lazy get materializes on pull with a stable handle", () => {
  const ctx = new ThreadSafeContext();
  const fam = ThreadSafeReactiveFamily.lazy(ctx, [], (k) => k * 3);
  assert.equal(fam.isPresent(5), false);
  const h1 = fam.get(5);
  const h2 = fam.get(5);
  assert.equal(h1.id, h2.id, "stable handle on re-get");
  assert.equal(fam.observe(5), 15);
  assert.deepEqual(fam.presentKeys(), [5]);
});

test("thread-safe: mode default is eager", () => {
  assert.equal(DEFAULT_MATERIALIZATION_MODE, MaterializationMode.Eager);
  const ctx = new ThreadSafeContext();
  const fam = ThreadSafeReactiveFamily.create(ctx, [1, 2, 3], (k) => k);
  assert.equal(fam.mode, MaterializationMode.Eager);
  assert.equal(fam.presentCount(), 3);
});
