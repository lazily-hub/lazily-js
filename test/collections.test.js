import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CellMap, CellTree, reconcileCollections } from "../src/collections.js";

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
  const map = new CellMap(fixture.initial);

  for (const step of fixture.steps) {
    const handlesBefore = {};
    for (const key of Object.keys(step.expected.handle_stable ?? {})) {
      handlesBefore[key] = map.handle(key);
    }

    const report = map.apply(step.op);
    const { order, values, membership, invalidates, handle_stable } =
      step.expected;

    assert.deepEqual(map.order, order, `${step.op.type}: order`);
    if (membership) {
      assertSameSet(map.keys(), membership, step.op.type);
    }
    if (values) {
      for (const [key, value] of Object.entries(values)) {
        assert.equal(map.get(key), value, `${step.op.type}: value[${key}]`);
      }
    }
    assert.deepEqual(report, invalidates, `${step.op.type}: invalidates`);
    if (handle_stable) {
      for (const [key, stable] of Object.entries(handle_stable)) {
        assert.equal(
          map.handle(key),
          handlesBefore[key],
          `${step.op.type}: handle[${key}] must be stable`,
        );
        assert.equal(stable, true);
      }
    }
  }
});

test("collection conformance: cellmap_independence.json", () => {
  const fixture = loadFixture("cellmap_independence.json");
  const map = new CellMap(fixture.initial);

  for (const step of fixture.steps) {
    const report = map.apply(step.op);
    const { order, values, membership, invalidates } = step.expected;

    assert.deepEqual(map.order, order, `${step.op.type}: order`);
    assertSameSet(map.keys(), membership, step.op.type);
    if (values) {
      for (const [key, value] of Object.entries(values)) {
        assert.equal(map.get(key), value, `${step.op.type}: value[${key}]`);
      }
    }
    assert.deepEqual(report, invalidates, `${step.op.type}: invalidates`);
  }
});

test("collection conformance: keyed_reconciliation_lis.json", () => {
  const fixture = loadFixture("keyed_reconciliation_lis.json");
  const result = reconcileCollections(
    fixture.reconcile.prior,
    fixture.reconcile.target,
  );

  assert.deepEqual(result.ops, fixture.expected.ops);
  assert.deepEqual(result.result_order, fixture.expected.result_order);
  assert.deepEqual(
    result.stable_keys_not_invalidated,
    fixture.expected.stable_keys_not_invalidated,
  );
});

test("CellMap move keeps the handle; remove then re-add mints a new one", () => {
  const map = new CellMap({ order: ["x", "y"], values: { x: 1, y: 2 } });
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

test("CellMap set_value is PartialEq-guarded (equal value invalidates nothing)", () => {
  const map = new CellMap({ order: ["a"], values: { a: 1 } });
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

// CellTree (ordered keyed tree) — cell-model.md § Ordered keyed tree.
// A node is (stable id, value, ordered keyed child collection). Per-node value
// reactivity, per-level membership/order reactivity, and the atomic-move
// guarantee are all inherited from the per-cell model.

function playerTree() {
  return new CellTree({
    id: "root",
    value: null,
    children: {
      order: ["alice", "bob"],
      values: {
        alice: { id: "alice", value: 10, children: { order: ["a1"], values: { a1: { id: "a1", value: 1 } } } },
        bob: { id: "bob", value: 20 },
      },
    },
  });
}

test("CellTree navigates by path and reads values", () => {
  const tree = playerTree();
  assert.equal(tree.getValue(["alice"]), 10);
  assert.equal(tree.getValue(["alice", "a1"]), 1);
  assert.equal(tree.getValue(["bob"]), 20);
  assert.equal(tree.nodeAt(["nope"]), undefined);
});

test("CellTree per-node value reactivity: editing a node touches only value, never membership/order", () => {
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

test("CellTree value edit does not leak into another level's child readers", () => {
  const tree = playerTree();
  const aliceReport = tree.setValue(["alice"], 99);
  const bobReport = tree.setValue(["bob"], 99);
  // Each report is scoped to its own path only — a sibling is untouched.
  assert.deepEqual(aliceReport.path, ["alice"]);
  assert.deepEqual(bobReport.path, ["bob"]);
  assert.equal(aliceReport.membership, false);
  assert.equal(aliceReport.order, false);
});

test("CellTree insert/remove at one level touches only that parent's membership + order", () => {
  const tree = playerTree();
  const report = tree.insertChild([], "carol", { id: "carol", value: 30 });
  assert.deepEqual(report, { path: [], value: [], membership: true, order: true });
  assert.deepEqual(tree.childKeys([]), ["alice", "bob", "carol"]);

  const removeReport = tree.removeChild([], "bob");
  assert.deepEqual(removeReport, { path: [], value: [], membership: true, order: true });
  assert.deepEqual(tree.childKeys([]), ["alice", "carol"]);
});

test("CellTree atomic move keeps the child handle stable and bumps order once", () => {
  const tree = playerTree();
  const handleAlice = tree.childHandle([], "alice");
  const report = tree.moveChildTo([], "alice", 1);
  assert.deepEqual(report, { path: [], value: [], membership: false, order: true });
  // Atomic move: same handle (never remove + re-mint), only order changed.
  assert.equal(tree.childHandle([], "alice"), handleAlice);
  assert.deepEqual(tree.childKeys([]), ["bob", "alice"]);
});

test("CellTree moveBefore / moveAfter reorder within a level", () => {
  const tree = playerTree();
  tree.moveChildAfter([], "alice", "bob"); // alice moves after bob
  assert.deepEqual(tree.childKeys([]), ["bob", "alice"]);
  tree.moveChildBefore([], "alice", "bob"); // alice moves before bob again
  assert.deepEqual(tree.childKeys([]), ["alice", "bob"]);
});

test("CellTree descendant edit does not invalidate an unrelated sibling's child level", () => {
  const tree = playerTree();
  // Edit a grandchild under alice; bob's level (and root level) must be untouched.
  const report = tree.setValue(["alice", "a1"], 7);
  assert.deepEqual(report, { path: ["alice", "a1"], value: ["a1"], membership: false, order: false });
  assert.equal(tree.getValue(["alice", "a1"]), 7);
  // Root child level and bob are observationally unchanged.
  assert.deepEqual(tree.childKeys([]), ["alice", "bob"]);
  assert.equal(tree.getValue(["bob"]), 20);
});

test("CellTree snapshot round-trips the nested structure", () => {
  const tree = playerTree();
  tree.setValue(["alice"], 11);
  const rebuilt = new CellTree(tree.snapshot());
  assert.deepEqual(rebuilt.snapshot(), tree.snapshot());
  assert.equal(rebuilt.getValue(["alice", "a1"]), 1);
});

test("CellTree removes a subtree", () => {
  const tree = playerTree();
  tree.removeChild([], "alice");
  assert.equal(tree.nodeAt(["alice", "a1"]), undefined);
  assert.deepEqual(tree.childKeys([]), ["bob"]);
});
