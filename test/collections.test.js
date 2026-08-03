import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertKey, assertKeyWith, subBlock } from "./support/assert-key.js";

import { SourceMap, SourceTree, reconcileCollections } from "../src/collections.js";

const here = dirname(fileURLToPath(import.meta.url));
const specCollections = join(here, "..", "..", "lazily-spec", "conformance", "collections");

function loadFixture(name) {
  const path = join(specCollections, name);
  assert.ok(existsSync(path), `missing spec fixture ${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

// `membership` is the present-key SET; compare order-independent so the assert
// does not couple to the fixture's incidental alphabetical ordering.
function assertSameSet(actual, expected, label) {
  const a = [...actual].sort();
  const e = [...expected].sort();
  assert.deepEqual(a, e, `${label}: membership set differs`);
}

test("collection conformance: cellmap_atomic_move.json", () => {
  const fixture = loadFixture("cellmap_atomic_move.json");
  const map = new SourceMap(fixture.initial);

  for (const step of fixture.steps) {
    const handlesBefore = {};
    for (const key of Object.keys(step.expected.handle_stable ?? {})) {
      handlesBefore[key] = map.handle(key);
    }

    const report = map.apply(step.op);
    const expected = step.expected;

    assertKey(expected, "order", map.order, `${step.op.type}: order`);
    if ("membership" in expected) {
      assertKeyWith(expected, "membership", (membership) =>
        assertSameSet(map.keys(), membership, step.op.type),
      );
    }
    if ("values" in expected) {
      // Descended (#lzsubblockkeyset): the child tracker owns every key the
      // fixture lists under `values`, so one added upstream is reported as
      // unconsumed instead of being iterated past by a loop that only ever
      // visits what the fixture happens to carry today.
      const values = subBlock(expected, "values");
      for (const key of Object.keys(values)) {
        assertKey(values, key, map.get(key), `${step.op.type}: value[${key}]`);
      }
    }
    assertKey(expected, "invalidates", report, `${step.op.type}: invalidates`);
    if ("handle_stable" in expected) {
      // Both directions. The old arm asserted the handle survived and then
      // asserted the FIXTURE said `true` — so a fixture claiming a handle must
      // NOT survive would have failed on its own value rather than on the
      // library's behaviour.
      const stability = subBlock(expected, "handle_stable");
      for (const key of Object.keys(stability)) {
        assertKey(
          stability,
          key,
          map.handle(key) === handlesBefore[key],
          `${step.op.type}: handle[${key}] stability`,
        );
      }
    }
  }
});

test("collection conformance: cellmap_independence.json", () => {
  const fixture = loadFixture("cellmap_independence.json");
  const map = new SourceMap(fixture.initial);

  for (const step of fixture.steps) {
    const report = map.apply(step.op);
    const expected = step.expected;

    assertKey(expected, "order", map.order, `${step.op.type}: order`);
    assertKeyWith(expected, "membership", (membership) =>
      assertSameSet(map.keys(), membership, step.op.type),
    );
    if ("values" in expected) {
      const values = subBlock(expected, "values");
      for (const key of Object.keys(values)) {
        assertKey(values, key, map.get(key), `${step.op.type}: value[${key}]`);
      }
    }
    assertKey(expected, "invalidates", report, `${step.op.type}: invalidates`);
  }
});

test("collection conformance: keyed_reconciliation_lis.json", () => {
  const fixture = loadFixture("keyed_reconciliation_lis.json");
  const result = reconcileCollections(fixture.reconcile.prior, fixture.reconcile.target);

  assertKey(fixture.expected, "ops", result.ops);
  assertKey(fixture.expected, "result_order", result.result_order);
  assertKey(fixture.expected, "stable_keys_not_invalidated", result.stable_keys_not_invalidated);
});

test("SourceMap move keeps the handle; remove then re-add mints a new one", () => {
  const map = new SourceMap({ order: ["x", "y"], values: { x: 1, y: 2 } });
  const handleX = map.handle("x");

  // A pure reorder never re-mints the handle.
  map.moveTo("x", 1);
  assert.equal(map.handle("x"), handleX);
  assert.deepEqual(map.order, ["y", "x"]);

  // Remove retires the handle; re-adding the same key mints a fresh one.
  map.remove("x");
  assert.equal(map.handle("x"), undefined);
  map.insert("x", 9, "end");
  assert.notEqual(map.handle("x"), handleX);
});

test("SourceMap set_value is PartialEq-guarded (equal value invalidates nothing)", () => {
  const map = new SourceMap({ order: ["a"], values: { a: 1 } });
  assert.deepEqual(map.setValue("a", 1), { value: [], membership: false, order: false });
  assert.deepEqual(map.setValue("a", 2), { value: ["a"], membership: false, order: false });
  assert.equal(map.get("a"), 2);
});

test("reconcileCollections leaves an already-ordered target move-free", () => {
  const result = reconcileCollections(
    { order: ["a", "b", "c"], values: { a: 1, b: 2, c: 3 } },
    { order: ["a", "b", "c"], values: { a: 1, b: 2, c: 3 } },
  );
  assert.deepEqual(result.ops, []);
  assert.deepEqual(result.stable_keys_not_invalidated, ["a", "b", "c"]);
});

// SourceTree (ordered keyed tree) — cell-model.md § Ordered keyed tree.
// A node is (stable id, value, ordered keyed child collection). Per-node value
// reactivity, per-level membership/order reactivity, and the atomic-move
// guarantee are all inherited from the per-cell model.

function playerTree() {
  return new SourceTree({
    id: "root",
    value: null,
    children: {
      order: ["alice", "bob"],
      values: {
        alice: {
          id: "alice",
          value: 10,
          children: { order: ["a1"], values: { a1: { id: "a1", value: 1 } } },
        },
        bob: { id: "bob", value: 20 },
      },
    },
  });
}

test("SourceTree navigates by path and reads values", () => {
  const tree = playerTree();
  assert.equal(tree.getValue(["alice"]), 10);
  assert.equal(tree.getValue(["alice", "a1"]), 1);
  assert.equal(tree.getValue(["bob"]), 20);
  assert.equal(tree.nodeAt(["nope"]), undefined);
});

test("SourceTree per-node value reactivity: editing a node touches only value, never membership/order", () => {
  const tree = playerTree();
  const report = tree.setValue(["alice"], 11);
  assert.deepEqual(report, { path: ["alice"], value: ["alice"], membership: false, order: false });
  assert.equal(tree.getValue(["alice"]), 11);
  // An unchanged value invalidates nothing (PartialEq guard).
  assert.deepEqual(tree.setValue(["alice"], 11), {
    path: ["alice"],
    value: [],
    membership: false,
    order: false,
  });
});

test("SourceTree value edit does not leak into another level's child readers", () => {
  const tree = playerTree();
  const aliceReport = tree.setValue(["alice"], 99);
  const bobReport = tree.setValue(["bob"], 99);
  // Each report is scoped to its own path only — a sibling is untouched.
  assert.deepEqual(aliceReport.path, ["alice"]);
  assert.deepEqual(bobReport.path, ["bob"]);
  assert.equal(aliceReport.membership, false);
  assert.equal(aliceReport.order, false);
});

test("SourceTree insert/remove at one level touches only that parent's membership + order", () => {
  const tree = playerTree();
  const report = tree.insertChild([], "carol", { id: "carol", value: 30 });
  assert.deepEqual(report, { path: [], value: [], membership: true, order: true });
  assert.deepEqual(tree.childKeys([]), ["alice", "bob", "carol"]);

  const removeReport = tree.removeChild([], "bob");
  assert.deepEqual(removeReport, { path: [], value: [], membership: true, order: true });
  assert.deepEqual(tree.childKeys([]), ["alice", "carol"]);
});

test("SourceTree atomic move keeps the child handle stable and bumps order once", () => {
  const tree = playerTree();
  const handleAlice = tree.childHandle([], "alice");
  const report = tree.moveChildTo([], "alice", 1);
  assert.deepEqual(report, { path: [], value: [], membership: false, order: true });
  // Atomic move: same handle (never remove + re-mint), only order changed.
  assert.equal(tree.childHandle([], "alice"), handleAlice);
  assert.deepEqual(tree.childKeys([]), ["bob", "alice"]);
});

test("SourceTree moveBefore / moveAfter reorder within a level", () => {
  const tree = playerTree();
  tree.moveChildAfter([], "alice", "bob"); // alice moves after bob
  assert.deepEqual(tree.childKeys([]), ["bob", "alice"]);
  tree.moveChildBefore([], "alice", "bob"); // alice moves before bob again
  assert.deepEqual(tree.childKeys([]), ["alice", "bob"]);
});

test("SourceTree descendant edit does not invalidate an unrelated sibling's child level", () => {
  const tree = playerTree();
  // Edit a grandchild under alice; bob's level (and root level) must be untouched.
  const report = tree.setValue(["alice", "a1"], 7);
  assert.deepEqual(report, {
    path: ["alice", "a1"],
    value: ["a1"],
    membership: false,
    order: false,
  });
  assert.equal(tree.getValue(["alice", "a1"]), 7);
  // Root child level and bob are observationally unchanged.
  assert.deepEqual(tree.childKeys([]), ["alice", "bob"]);
  assert.equal(tree.getValue(["bob"]), 20);
});

test("SourceTree snapshot round-trips the nested structure", () => {
  const tree = playerTree();
  tree.setValue(["alice"], 11);
  const rebuilt = new SourceTree(tree.snapshot());
  assert.deepEqual(rebuilt.snapshot(), tree.snapshot());
  assert.equal(rebuilt.getValue(["alice", "a1"]), 1);
});

test("SourceTree removes a subtree", () => {
  const tree = playerTree();
  tree.removeChild([], "alice");
  assert.equal(tree.nodeAt(["alice", "a1"]), undefined);
  assert.deepEqual(tree.childKeys([]), ["bob"]);
});
