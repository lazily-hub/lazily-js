import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { assertKey, assertKeyWith, subBlock } from "./support/assert-key.js";

import { ThreadSafeContext } from "../src/thread-safe.js";
import {
  EntryKind,
  ThreadSafeSourceMap,
  ThreadSafeReactiveMap,
  ThreadSafeComputedMap,
} from "../src/thread-safe-reactive-family.js";

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

function eagerSlotMap(ctx, keys, factory) {
  const map = new ThreadSafeComputedMap(ctx);
  map.materializeAll(keys, factory);
  return map;
}

// `default_mode` (clause default_mode_eager) on the THREAD-SAFE plane, asserted on
// its own context rather than deferred to the sync runner: this plane has its own
// storage and locking, so its pre-mint loop is a different construction.
//
// The fixture's value SELECTS THE BUILD; the fact asserted is that a map built the
// way the fixture names its default is fully materialized at build time. The
// dispatch chooses the construction and nothing else — the comparison is against
// EVERY declared key, unconditionally, because asserting "what this mode implies"
// (lazy ⇒ nothing present) is a tautology that survives a corpus flip.
function computedMapPresentAtBuild(ctx, mode, keys, factory) {
  if (mode === "eager") return eagerSlotMap(ctx, keys, factory).presentCount();
  if (mode === "lazy") return new ThreadSafeComputedMap(ctx).presentCount();
  throw new TypeError(`unknown default_mode ${JSON.stringify(mode)}`);
}

function assertDefaultModeMaterializesAtBuild(expected, keys, factory) {
  assertKeyWith(expected, "default_mode", (mode) => {
    assert.equal(
      computedMapPresentAtBuild(new ThreadSafeContext(), mode, keys, factory),
      keys.length,
      `a thread-safe map built the fixture's default way (${mode}) is materialized at build`,
    );
  });
}

// --- conformance replayed through the THREAD-SAFE ComputedMap -------------------
test("thread-safe ComputedMap conformance: observational_transparency.json", () => {
  const fixture = loadFixture("observational_transparency.json");
  const { spec, expected } = fixture;
  const keys = Object.keys(spec.val);
  const factory = (k) => spec.val[k];

  assertDefaultModeMaterializesAtBuild(expected, keys, factory);

  const ctx = new ThreadSafeContext();
  const eager = eagerSlotMap(ctx, keys, factory);
  const lazy = new ThreadSafeComputedMap(ctx);

  assertKeyWith(expected, "eager_present", (want) =>
    assertSameSet(eager.presentKeys(), want, "eager_present"),
  );
  assert.equal(lazy.presentCount(), 0);

  // Descended (#lzsubblockkeyset): the child tracker owns every key the
  // fixture observes, so one added upstream is reported as unconsumed rather
  // than skipped by a loop that only ever visits today's keys.
  const observe = subBlock(expected, "observe");
  for (const key of Object.keys(observe)) {
    assertKeyWith(
      observe,
      key,
      (value) => {
        assert.equal(eager.observe(key), value, `eager observe[${key}]`);
        assert.equal(lazy.getOrInsertWith(key, factory), value, `lazy observe[${key}]`);
      },
      "observe",
    );
  }

  const ctx2 = new ThreadSafeContext();
  const lazy2 = new ThreadSafeComputedMap(ctx2);
  for (const key of fixture.reads) lazy2.getOrInsertWith(key, factory);
  assertKeyWith(expected, "lazy_present_after_reads", (want) =>
    assertSameSet(lazy2.presentKeys(), want, "lazy_present_after_reads"),
  );
});

test("thread-safe ComputedMap conformance: deferral_not_deallocation.json", () => {
  const fixture = loadFixture("deferral_not_deallocation.json");
  const { spec, expected } = fixture;
  const keys = Object.keys(spec.val);
  const factory = (k) => spec.val[k];

  assertDefaultModeMaterializesAtBuild(expected, keys, factory);

  const ctx = new ThreadSafeContext();
  const eager = eagerSlotMap(ctx, keys, factory);
  assertKeyWith(expected, "eager_present", (want) =>
    assertSameSet(eager.presentKeys(), want, "eager_present"),
  );

  const lazy = new ThreadSafeComputedMap(ctx);
  const sizes = [];
  for (const key of fixture.reads) {
    assert.equal(lazy.getOrInsertWith(key, factory), spec.val[key], `observe[${key}]`);
    sizes.push(lazy.presentCount());
  }
  assertKey(expected, "present_after_each_read", sizes, "present_after_each_read");
  assertKeyWith(expected, "lazy_present_after_reads", (want) =>
    assertSameSet(lazy.presentKeys(), want, "lazy_present_after_reads"),
  );
});

test("thread-safe conformance: entry_kind_orthogonal_to_mode.json (SourceMap + ComputedMap)", () => {
  const fixture = loadFixture("entry_kind_orthogonal_to_mode.json");
  const { spec, expected } = fixture;
  const cellKeys = [];
  const slotKeys = [];
  const lookup = (k) => spec.entries[k].val;
  for (const [key, entry] of Object.entries(spec.entries)) {
    (fixtureEntryKind(key, entry.kind) === EntryKind.Source ? cellKeys : slotKeys).push(key);
  }

  // default_mode_eager with the entry-kind split, on this plane's own context.
  // Sources are present at build under every strategy, computeds only under eager,
  // so only the eager build holds all four declared entries.
  assertKeyWith(expected, "default_mode", (mode) => {
    const ctx = new ThreadSafeContext();
    const cells = new ThreadSafeSourceMap(ctx);
    for (const k of cellKeys) cells.set(k, lookup(k));
    const slots = new ThreadSafeComputedMap(ctx);
    if (mode === "eager") slots.materializeAll(slotKeys, lookup);
    else if (mode !== "lazy") throw new TypeError(`unknown default_mode ${JSON.stringify(mode)}`);
    assert.equal(
      cells.presentCount() + slots.presentCount(),
      cellKeys.length + slotKeys.length,
      `a mixed-kind thread-safe map built the fixture's default way (${mode}) is materialized ` +
        "at build",
    );
  });

  const ctxE = new ThreadSafeContext();
  const eagerCells = new ThreadSafeSourceMap(ctxE);
  for (const k of cellKeys) eagerCells.set(k, lookup(k));
  const eagerSlots = new ThreadSafeComputedMap(ctxE);
  eagerSlots.materializeAll(slotKeys, lookup);
  assertKeyWith(expected, "eager_present", (want) =>
    assertSameSet(
      [...eagerCells.presentKeys(), ...eagerSlots.presentKeys()],
      want,
      "eager_present",
    ),
  );
  assertKeyWith(expected, "observe", (observe) => {
    for (const [key, value] of Object.entries(observe)) {
      const got = cellKeys.includes(key) ? eagerCells.observe(key) : eagerSlots.observe(key);
      assert.equal(got, value, `eager observe[${key}]`);
    }
  });

  const ctxL = new ThreadSafeContext();
  const lazyCells = new ThreadSafeSourceMap(ctxL);
  for (const k of cellKeys) lazyCells.set(k, lookup(k));
  const lazySlots = new ThreadSafeComputedMap(ctxL);
  assertKeyWith(expected, "lazy_present_at_build", (want) =>
    assertSameSet(lazyCells.presentKeys(), want, "lazy_present_at_build"),
  );
  assert.equal(lazySlots.presentCount(), 0, "slots deferred at build");
  for (const key of fixture.reads) {
    if (slotKeys.includes(key)) lazySlots.getOrInsertWith(key, lookup);
    else lazyCells.getOrInsertWith(key, lookup);
  }
  assertKeyWith(expected, "lazy_present_after_reads", (want) =>
    assertSameSet(
      [...lazyCells.presentKeys(), ...lazySlots.presentKeys()],
      want,
      "lazy_present_after_reads",
    ),
  );
});

// --- materialization confluence (materialize_present_comm / observe_comm) ---
test("thread-safe: materialization is confluent — order-independent present set + values", () => {
  const factory = (k) => k * 7;
  const keysToPull = [3, 1, 4, 1, 5, 9, 2, 6];

  const ctxA = new ThreadSafeContext();
  const mapA = new ThreadSafeComputedMap(ctxA);
  for (const k of keysToPull) mapA.getOrInsertWith(k, factory);

  const ctxB = new ThreadSafeContext();
  const mapB = new ThreadSafeComputedMap(ctxB);
  for (const k of [...keysToPull].reverse()) mapB.getOrInsertWith(k, factory);

  assertSameSet(mapA.presentKeys(), mapB.presentKeys(), "present set order-independent");
  const uniq = [...new Set(keysToPull)];
  for (const k of uniq) {
    assert.equal(mapA.observe(k), mapB.observe(k), `observe[${k}] order-independent`);
    assert.equal(mapA.observe(k), factory(k), `observe[${k}] canonical`);
  }
  assert.equal(mapA.presentCount(), uniq.length);
});

test("thread-safe: SourceMap is writable + always materialized; ComputedMap has no set", () => {
  const ctx = new ThreadSafeContext();
  const cells = new ThreadSafeSourceMap(ctx);
  cells.set("a", 0);
  cells.set("b", 0);
  assert.equal(cells.entryKind(), EntryKind.Source);
  assert.equal(cells.presentCount(), 2);
  cells.set("a", 99);
  assert.equal(cells.observe("a"), 99);

  const slots = new ThreadSafeComputedMap(ctx);
  assert.equal(typeof slots.set, "undefined", "ComputedMap has no set");
});

test("thread-safe: lazy getOrInsertHandle materializes with a stable handle", () => {
  const ctx = new ThreadSafeContext();
  const map = new ThreadSafeComputedMap(ctx);
  assert.equal(map.isPresent(5), false);
  const h1 = map.getOrInsertHandle(5, (k) => k * 3);
  const h2 = map.getOrInsertHandle(5, (k) => k * 3);
  assert.equal(h1.id, h2.id, "stable handle on re-get");
  assert.equal(map.observe(5), 15);
  assert.deepEqual(map.presentKeys(), [5]);
  assert.equal(map.entryKind(), EntryKind.Computed);
  assert.ok(new ThreadSafeReactiveMap(ctx).entryKind() === EntryKind.Computed);
});
