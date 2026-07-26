// The keyed-collection ordering contract replayed against ALL THREE execution
// flavors.
//
// This binding's starting position was the worst of the family. The canonical
// collections fixtures were loaded only by `test/collections.test.js`, which
// drives a FOURTH, non-reactive model (`src/collections.js`) — so the ordering
// contract had never been replayed against ANY reactive map here, let alone all
// three. Meanwhile `ThreadSafeReactiveMap` and `AsyncReactiveMap` shipped
// `presentKeys` / `presentCount` and no ordering surface at all.
//
// Invalidation is measured by RECOMPUTE COUNT inside the reader's own compute
// body, not by a cache flag: a counter the library has to move is the one probe
// that cannot be satisfied by runner bookkeeping.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Context } from "../src/reactive.js";
import { AsyncContext } from "../src/reactive-async.js";
import { ThreadSafeContext } from "../src/thread-safe.js";
import { SourceMap } from "../src/reactive-family.js";
import { ThreadSafeSourceMap } from "../src/thread-safe-reactive-family.js";
import { AsyncSourceMap } from "../src/async-reactive-family.js";

const here = dirname(fileURLToPath(import.meta.url));

const FIXTURES = ["cellmap_atomic_move.json", "cellmap_independence.json"];

function loadFixture(name) {
  for (const path of [
    join(here, "..", "..", "lazily-spec", "conformance", "collections", name),
    join(here, "conformance", "collections", name),
  ]) {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf8"));
    }
  }
  return undefined;
}

/** Order-sensitive, so an order reader's VALUE changes on a reorder. */
function orderDigest(keys) {
  let acc = 17;
  for (const key of keys) {
    for (const ch of key) {
      acc = (acc * 31 + ch.charCodeAt(0)) | 0;
    }
    acc = (acc * 31 + 7) | 0;
  }
  return acc;
}

// --- flavors ----------------------------------------------------------------

class SyncFlavor {
  name = "sync";
  constructor() {
    this.ctx = new Context();
    this.map = new SourceMap(this.ctx);
  }
  reader(body) {
    let count = 0;
    const node = this.ctx.computed((ops) => {
      count += 1;
      return body(ops);
    });
    return async () => {
      this.ctx.get(node);
      return count;
    };
  }
}

class ThreadSafeFlavor {
  name = "thread-safe";
  constructor() {
    this.ctx = new ThreadSafeContext();
    this.map = new ThreadSafeSourceMap(this.ctx);
  }
  reader(body) {
    let count = 0;
    const node = this.ctx.computed((ops) => {
      count += 1;
      return body(ops);
    });
    return async () => {
      this.ctx.get(node);
      return count;
    };
  }
}

class AsyncFlavor {
  name = "async";
  constructor() {
    this.ctx = new AsyncContext();
    this.map = new AsyncSourceMap(this.ctx);
  }
  reader(body) {
    let count = 0;
    // The async flavor's computes are async-coloured — that is the ONE
    // async-coloured obligation in this whole contract. Ordering itself is not.
    const node = this.ctx.computedAsync(async (ops) => {
      count += 1;
      return body(ops);
    });
    return async () => {
      await this.ctx.getAsync(node);
      return count;
    };
  }
}

const FLAVORS = [SyncFlavor, ThreadSafeFlavor, AsyncFlavor];

// Every flavor now drives the same surface, which is the whole point.
const ops = {
  setValue: (f, key, value) => f.map.set(key, value),
  insert: (f, key, value) => f.map.set(key, value),
  remove: (f, key) => f.map.remove(key),
  moveTo: (f, key, index) => f.map.moveTo(key, index),
  moveBefore: (f, key, anchor) => f.map.moveBefore(key, anchor),
  moveAfter: (f, key, anchor) => f.map.moveAfter(key, anchor),
  keys: (f) => f.map.presentKeys(),
  handle: (f, key) => f.map.handle(key),
  value: (f, key) => {
    const handle = f.map.handle(key);
    return handle === undefined ? undefined : f.ctx.get(handle);
  },
  valueReader: (f, key) => {
    const handle = f.map.handle(key);
    return f.reader((surface) => (handle === undefined ? -1 : surface.get(handle)));
  },
  membershipReader: (f) => f.reader((surface) => f.map.len(surface)),
  orderReader: (f) => f.reader((surface) => orderDigest(f.map.keys(surface))),
};

// --- replay -----------------------------------------------------------------

async function replay(FlavorCls, fixtureName) {
  const fixture = loadFixture(fixtureName);
  const flavor = new FlavorCls();
  const where = (i) => `${flavor.name} ${fixtureName} step ${i}`;

  assert.ok(fixture, `canonical collections fixture missing: ${fixtureName}`);

  const initial = fixture.initial;
  assert.ok(initial, `${flavor.name}: fixture ${fixtureName} has no initial state`);
  const seed = initial.order ?? [];
  assert.ok(seed.length > 0, `${flavor.name}: fixture ${fixtureName} seeds no keys`);
  for (const key of seed) {
    assert.ok(key in (initial.values ?? {}), `${flavor.name}: no initial value for ${key}`);
    ops.insert(flavor, key, initial.values[key]);
  }

  const steps = fixture.steps ?? [];
  // A zero-step replay asserts nothing and still reports green.
  assert.ok(
    steps.length > 0,
    `${flavor.name}: fixture ${fixtureName} has no steps - a vacuous replay would report green`,
  );

  let matrices = 0;

  for (const [i, step] of steps.entries()) {
    const op = step.op;
    const expected = step.expected;
    assert.ok(op && expected, `${where(i)}: malformed step`);

    // Rebuild + settle readers from the CURRENT key set so each step's
    // invalidation is measured against a fully settled graph.
    const beforeKeys = ops.keys(flavor);
    const valueReaders = new Map(beforeKeys.map((key) => [key, ops.valueReader(flavor, key)]));
    const baseline = new Map();
    for (const [key, drive] of valueReaders) {
      baseline.set(key, await drive());
    }
    const membership = ops.membershipReader(flavor);
    const order = ops.orderReader(flavor);
    const membershipBase = await membership();
    const orderBase = await order();

    const handlesBefore = new Map(beforeKeys.map((key) => [key, ops.handle(flavor, key)]));

    switch (op.type) {
      case "set_value":
        ops.setValue(flavor, op.key, op.value);
        break;
      case "insert":
        ops.insert(flavor, op.key, op.value);
        // `at` says where the new key lands; minting appends, so "end" is
        // already right. An unrecognised form must fail, not silently append.
        if (typeof op.at === "number") {
          ops.moveTo(flavor, op.key, op.at);
        } else if (op.at !== undefined) {
          assert.equal(op.at, "end", `${where(i)}: unsupported insert placement ${op.at}`);
        }
        break;
      case "remove":
        ops.remove(flavor, op.key);
        break;
      case "move_to":
        ops.moveTo(flavor, op.key, op.index);
        break;
      case "move_before":
        ops.moveBefore(flavor, op.key, op.before);
        break;
      case "move_after":
        ops.moveAfter(flavor, op.key, op.after);
        break;
      default:
        assert.fail(
          `${where(i)}: unsupported op ${op.type} - an unknown op must fail, never silently skip`,
        );
    }

    const gotOrder = ops.keys(flavor);
    assert.deepEqual(gotOrder, expected.order, `${where(i)}: order diverged`);

    if (expected.membership) {
      assert.deepEqual(
        [...gotOrder].sort(),
        [...expected.membership].sort(),
        `${where(i)}: membership set diverged`,
      );
    }

    for (const [key, want] of Object.entries(expected.values ?? {})) {
      assert.equal(ops.value(flavor, key), want, `${where(i)}: value for ${key} diverged`);
    }

    // The invalidation matrix, read from expected.invalidates - where the
    // fixtures actually nest it. lazily-rs read it off the step instead, so its
    // assertion never ran once.
    const invalidates = expected.invalidates;
    assert.ok(
      invalidates,
      `${where(i)}: expected.invalidates is missing - the matrix is the contract`,
    );
    matrices += 1;

    const dirty = new Set(invalidates.value ?? []);
    const survivors = new Set(gotOrder);
    for (const [key, drive] of valueReaders) {
      if (!survivors.has(key)) {
        continue; // removed by this op: no entry left to read
      }
      const recomputed = (await drive()) !== baseline.get(key);
      if (dirty.has(key)) {
        assert.ok(recomputed, `${where(i)}: value reader for ${key} should have been invalidated`);
      } else {
        assert.ok(
          !recomputed,
          `${where(i)}: value reader for ${key} should have stayed cached - ` +
            "per-entry independence is the whole point",
        );
      }
    }

    assert.equal(
      (await membership()) !== membershipBase,
      Boolean(invalidates.membership),
      `${where(i)}: membership reader invalidation mismatch - ` +
        "a pure reorder must NOT invalidate set-identity readers",
    );
    assert.equal(
      (await order()) !== orderBase,
      Boolean(invalidates.order),
      `${where(i)}: order reader invalidation mismatch`,
    );

    // Handle stability: the law separating an atomic move from a remove +
    // re-mint. A reorder keeps the entry's node, so dependents and lineage
    // survive.
    for (const [key, wantStable] of Object.entries(expected.handle_stable ?? {})) {
      const after = ops.handle(flavor, key);
      const before = handlesBefore.get(key);
      if (wantStable) {
        assert.ok(
          before !== undefined && after === before,
          `${where(i)}: handle for ${key} must survive the move - ` +
            "a reorder that re-mints is a remove + insert, not a move",
        );
      } else {
        assert.ok(after !== before, `${where(i)}: handle for ${key} should have changed`);
      }
    }
  }

  assert.ok(matrices > 0, `${flavor.name}: ${fixtureName} asserted no invalidation matrix`);
}

for (const FlavorCls of FLAVORS) {
  for (const fixtureName of FIXTURES) {
    test(`ordering contract: ${new FlavorCls().name} / ${fixtureName}`, async () => {
      await replay(FlavorCls, fixtureName);
    });
  }
}

// Cover a direction the canonical corpus does not.
//
// `cellmap_atomic_move.json`'s only `move_before` step moves a key that already
// FOLLOWS its anchor (from=2, anchor=0), so it exercises only the branch where
// the insertion point is the anchor index itself. The branch where the key
// PRECEDES its anchor — target `anchor - 1` — is never replayed. That is exactly
// the direction lazily-zig's `moveBefore` was wrong in.
//
// The negative-index cases cover a defect this work found in THIS binding:
// `moveTo` clamped only the upper end, so a negative index reached
// `Array.prototype.splice`'s count-from-the-end semantics and landed the key
// before the LAST element instead of at the front. `src/collections.js` clamped
// correctly and `reactive-family.js` did not — two implementations of one
// contract disagreeing, untested in both.
for (const FlavorCls of FLAVORS) {
  test(`directional moves: ${new FlavorCls().name}`, () => {
    const seed = ["a", "b", "c", "d"];
    const build = () => {
      const flavor = new FlavorCls();
      seed.forEach((key, i) => ops.insert(flavor, key, i + 1));
      return flavor;
    };

    const cases = [
      ["move_before, key precedes anchor", (f) => ops.moveBefore(f, "a", "d"), ["b", "c", "a", "d"]],
      ["move_before, key follows anchor", (f) => ops.moveBefore(f, "d", "b"), ["a", "d", "b", "c"]],
      ["move_after, key precedes anchor", (f) => ops.moveAfter(f, "a", "c"), ["b", "c", "a", "d"]],
      ["move_after, key follows anchor", (f) => ops.moveAfter(f, "d", "a"), ["a", "d", "b", "c"]],
      ["move_to past the end clamps", (f) => ops.moveTo(f, "a", 99), ["b", "c", "d", "a"]],
      // -1 is the discriminating index: splice(-1, 0, key) inserts before the
      // LAST element, so a missing lower clamp shows here and nowhere else.
      ["move_to to -1 clamps to the front", (f) => ops.moveTo(f, "d", -1), ["d", "a", "b", "c"]],
      ["move_to far below zero clamps", (f) => ops.moveTo(f, "d", -5), ["d", "a", "b", "c"]],
      [
        "move on an absent key is a no-op",
        (f) => {
          ops.moveBefore(f, "zz", "a");
          ops.moveTo(f, "zz", 0);
        },
        seed,
      ],
    ];

    for (const [what, run, want] of cases) {
      const flavor = build();
      const identityBefore = ops.handle(flavor, "a");
      run(flavor);
      assert.deepEqual(
        ops.keys(flavor),
        want,
        `${flavor.name}: ${what} diverged - the target must be computed on the pre-removal list`,
      );
      assert.equal(
        ops.handle(flavor, "a"),
        identityBefore,
        `${flavor.name}: ${what} re-minted entry a - a reorder must keep the node`,
      );
    }
  });
}
