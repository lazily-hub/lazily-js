import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertKey, assertKeyWith, subBlock } from "./support/assert-key.js";

import { AsyncContext } from "../src/reactive-async.js";
import {
  AsyncSourceMap,
  AsyncReactiveMap,
  AsyncComputedMap,
  EntryKind,
} from "../src/async-reactive-family.js";

const here = dirname(fileURLToPath(import.meta.url));
// Overridable by the SAME env var the three conformance guard scripts read, so a
// corpus-perturbation check can reach this runner (see reactive-family.test.js).
const specConformance =
  process.env.LAZILY_SPEC_CONFORMANCE_DIR ?? join(here, "..", "..", "lazily-spec", "conformance");
const specMaterialization = join(specConformance, "materialization");

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
  const map = new AsyncComputedMap(ctx);
  map.materializeAll(keys, factory);
  return map;
}

// `default_mode` (clause default_mode_eager) on the ASYNC plane, asserted on its
// OWN context rather than deferred to the sync runner — a construction that is
// correct synchronously can be broken asynchronously, which is why this plane has
// its own runner at all.
//
// The fixture's value SELECTS THE BUILD; the fact asserted is that a map built
// the way the fixture names its default is fully materialized at build time. The
// dispatch chooses the construction and nothing else: the comparison is against
// EVERY declared key, unconditionally. Asserting "what this mode implies" instead
// (lazy ⇒ nothing present) would be a tautology that stays green on a corpus flip
// and proves nothing.
function computedMapPresentAtBuild(ctx, mode, keys, factory) {
  if (mode === "eager") return eagerSlotMap(ctx, keys, factory).presentCount();
  if (mode === "lazy") return new AsyncComputedMap(ctx).presentCount();
  throw new TypeError(`unknown default_mode ${JSON.stringify(mode)}`);
}

function assertDefaultModeMaterializesAtBuild(expected, keys, factory) {
  assertKeyWith(expected, "default_mode", (mode) => {
    assert.equal(
      computedMapPresentAtBuild(new AsyncContext(), mode, keys, factory),
      keys.length,
      `an async map built the fixture's default way (${mode}) is materialized at build`,
    );
  });
}

// --- conformance replayed through the ASYNC ComputedMap (eventual transparency) --
// A derived slot observes as `undefined` until driven; `resolve` awaits the
// canonical value. Once resolved, eager ≡ lazy — the AsyncMaterialization proof.
test("async ComputedMap conformance: observational_transparency.json", async () => {
  const fixture = loadFixture("observational_transparency.json");
  const { spec, expected } = fixture;
  const keys = Object.keys(spec.val);
  const factory = (k) => spec.val[k];

  assertDefaultModeMaterializesAtBuild(expected, keys, factory);

  const ctxE = new AsyncContext();
  const eager = eagerSlotMap(ctxE, keys, factory);
  const ctxL = new AsyncContext();
  const lazy = new AsyncComputedMap(ctxL);

  // Present-set laws (allocation axis, unchanged by async resolution).
  assertKeyWith(expected, "eager_present", (want) =>
    assertSameSet(eager.presentKeys(), want, "eager_present"),
  );
  assert.equal(lazy.presentCount(), 0, "lazy defers all slots at build");

  // Eventual transparency: drive each slot; resolved value = canonical.
  // Descended (#lzsubblockkeyset): the child tracker owns every key the
  // fixture observes, so one added upstream is reported as unconsumed rather
  // than skipped by a loop that only ever visits today's keys.
  const observe = subBlock(expected, "observe");
  for (const key of Object.keys(observe)) {
    await assertKeyWith(
      observe,
      key,
      async (value) => {
        assert.equal(await eager.resolve(key), value, `eager resolve[${key}]`);
        assert.equal(await lazy.resolve(key, factory), value, `lazy resolve[${key}]`);
      },
      "observe",
    );
  }

  const ctx2 = new AsyncContext();
  const lazy2 = new AsyncComputedMap(ctx2);
  for (const key of fixture.reads) lazy2.getOrInsertHandle(key, factory);
  assertKeyWith(expected, "lazy_present_after_reads", (want) =>
    assertSameSet(lazy2.presentKeys(), want, "lazy_present_after_reads"),
  );
});

test("async ComputedMap conformance: deferral_not_deallocation.json", async () => {
  const fixture = loadFixture("deferral_not_deallocation.json");
  const { spec, expected } = fixture;
  const factory = (k) => spec.val[k];

  assertDefaultModeMaterializesAtBuild(expected, Object.keys(spec.val), factory);

  const ctx = new AsyncContext();
  const eager = eagerSlotMap(ctx, Object.keys(spec.val), factory);
  assertKeyWith(expected, "eager_present", (want) =>
    assertSameSet(eager.presentKeys(), want, "eager_present"),
  );

  const lazy = new AsyncComputedMap(ctx);
  const sizes = [];
  for (const key of fixture.reads) {
    assert.equal(await lazy.resolve(key, factory), spec.val[key], `resolve[${key}]`);
    sizes.push(lazy.presentCount());
  }
  assertKey(expected, "present_after_each_read", sizes, "present_after_each_read");
  for (let i = 1; i < sizes.length; i++) {
    assert.ok(sizes[i] >= sizes[i - 1], "present count is monotone");
  }
  assertKeyWith(expected, "lazy_present_after_reads", (want) =>
    assertSameSet(lazy.presentKeys(), want, "lazy_present_after_reads"),
  );
});

test("async conformance: entry_kind_orthogonal_to_mode.json (SourceMap + ComputedMap)", async () => {
  const fixture = loadFixture("entry_kind_orthogonal_to_mode.json");
  const { spec, expected } = fixture;
  const cellKeys = [];
  const slotKeys = [];
  const lookup = (k) => spec.entries[k].val;
  for (const [key, entry] of Object.entries(spec.entries)) {
    (fixtureEntryKind(key, entry.kind) === EntryKind.Source ? cellKeys : slotKeys).push(key);
  }

  // default_mode_eager with the entry-kind split, on the async plane's own
  // context. Sources are present at build under every strategy, computeds only
  // under eager, so only the eager build holds all four declared entries.
  assertKeyWith(expected, "default_mode", (mode) => {
    const ctx = new AsyncContext();
    const cells = new AsyncSourceMap(ctx);
    for (const k of cellKeys) cells.set(k, lookup(k));
    const slots = new AsyncComputedMap(ctx);
    if (mode === "eager") slots.materializeAll(slotKeys, lookup);
    else if (mode !== "lazy") throw new TypeError(`unknown default_mode ${JSON.stringify(mode)}`);
    assert.equal(
      cells.presentCount() + slots.presentCount(),
      cellKeys.length + slotKeys.length,
      `a mixed-kind async map built the fixture's default way (${mode}) is materialized at build`,
    );
  });

  const ctxE = new AsyncContext();
  const eagerCells = new AsyncSourceMap(ctxE);
  for (const k of cellKeys) eagerCells.set(k, lookup(k));
  const eagerSlots = new AsyncComputedMap(ctxE);
  eagerSlots.materializeAll(slotKeys, lookup);
  assertKeyWith(expected, "eager_present", (want) =>
    assertSameSet(
      [...eagerCells.presentKeys(), ...eagerSlots.presentKeys()],
      want,
      "eager_present",
    ),
  );
  const observe = subBlock(expected, "observe");
  for (const key of Object.keys(observe)) {
    const got = cellKeys.includes(key)
      ? await eagerCells.resolve(key)
      : await eagerSlots.resolve(key);
    assertKey(observe, key, got, `eager resolve[${key}]`);
  }

  const ctxL = new AsyncContext();
  const lazyCells = new AsyncSourceMap(ctxL);
  for (const k of cellKeys) lazyCells.set(k, lookup(k));
  const lazySlots = new AsyncComputedMap(ctxL);
  assertKeyWith(expected, "lazy_present_at_build", (want) =>
    assertSameSet(lazyCells.presentKeys(), want, "lazy_present_at_build"),
  );
  assert.equal(lazySlots.presentCount(), 0, "slots deferred at build");
  for (const key of fixture.reads) {
    if (slotKeys.includes(key)) lazySlots.getOrInsertHandle(key, lookup);
    else lazyCells.getOrInsertHandle(key, lookup);
  }
  assertKeyWith(expected, "lazy_present_after_reads", (want) =>
    assertSameSet(
      [...lazyCells.presentKeys(), ...lazySlots.presentKeys()],
      want,
      "lazy_present_after_reads",
    ),
  );
});

// --- unit ------------------------------------------------------------------
test("async: eventual transparency — pending observes undefined then resolves", async () => {
  const ctx = new AsyncContext();
  const map = new AsyncComputedMap(ctx);
  const h = map.getOrInsertHandle(4, (k) => k * 10);
  assert.ok(h);
  assert.equal(map.isPresent(4), true);
  assert.equal(map.observe(4), undefined, "pending slot observes undefined");
  assert.equal(await map.resolve(4), 40);
  assert.equal(map.observe(4), 40, "resolved slot observes the canonical value");
});

test("async: SourceMap resolves immediately and reacts to set; ComputedMap has no set", async () => {
  const ctx = new AsyncContext();
  const cells = new AsyncSourceMap(ctx);
  cells.set(10, true);
  cells.set(20, true);
  assert.equal(cells.entryKind(), EntryKind.Source);
  assert.equal(cells.presentCount(), 2);
  assert.equal(cells.observe(20), true, "cells are always resolved");
  cells.set(20, false);
  assert.equal(cells.observe(20), false);

  const slots = new AsyncComputedMap(ctx);
  assert.equal(typeof slots.set, "undefined", "ComputedMap has no set");
});

test("async: present set grows monotonically, first-writer-wins handle", async () => {
  const ctx = new AsyncContext();
  const map = new AsyncComputedMap(ctx);
  const a = map.getOrInsertHandle(5, (k) => k);
  const b = map.getOrInsertHandle(5, (k) => k);
  assert.equal(a.id, b.id, "stable handle on re-get");
  map.getOrInsertHandle(9, (k) => k);
  assert.equal(map.presentCount(), 2);
  assert.deepEqual(map.presentKeys(), [5, 9]);
  assert.equal(new AsyncReactiveMap(ctx).entryKind(), EntryKind.Computed);
});
