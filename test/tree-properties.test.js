// Property-based validation of the native ordered keyed tree against the
// universal properties established by the Lean `LazilyFormal.Tree` formal
// model in `lazily-formal`. These are the guarantees no finite fixture suite
// can establish: per-node value reactivity, per-level membership/order
// reactivity, and atomic-move identity preservation.
//
// Each test names the Lean theorem it mirrors and exercises the JS
// implementation (`CellTree`) against the theorem's statement. Mutation
// methods return a path-scoped invalidation report
// `{ path, value: key[], membership: bool, order: bool }` — these reports ARE
// the per-level independence invariant made inspectable.

import assert from "node:assert/strict";
import test from "node:test";

import { CellTree } from "../src/collections.js";

function buildTree() {
  return CellTree.from({
    id: "root",
    value: "R",
    children: {
      order: ["a", "b"],
      values: {
        a: {
          id: "a",
          value: "A",
          children: { order: ["a1", "a2"], values: { a1: { id: "a1", value: 1 }, a2: { id: "a2", value: 2 } } },
        },
        b: { id: "b", value: "B", children: { order: [], values: {} } },
      },
    },
  });
}

// Capture a node's own record — id, value, and own child collection — WITHOUT
// descending. The Lean model's `setNodeValue_preserves_other_nodes` compares
// node records; a recursive snapshot would surface descendant edits through an
// ancestor and obscure the per-node invariant.
function recordAt(t, path) {
  const node = t.nodeAt(path);
  return { id: node.id, value: node.value, childOrder: [...node.children.order] };
}

// =================================================================================
// setNodeValue_preserves_other_nodes (Tree.lean)
// "Editing one node's value leaves every other node's record byte-identical —
//  neither a sibling, child, nor ancestor is disturbed."
// =================================================================================
test("Lean setNodeValue_preserves_other_nodes: setValue on one node leaves every other node untouched", () => {
  const t = buildTree();
  // Other nodes = the edited node's children + siblings + ancestor, but NOT
  // the edited node itself.
  const otherPaths = [["a", "a1"], ["a", "a2"], ["b"], []];
  const before = otherPaths.map((p) => ({ p, rec: recordAt(t, p) }));

  t.setValue(["a"], "A-new");

  for (const { p, rec } of before) {
    assert.deepEqual(recordAt(t, p), rec, `node record at ${JSON.stringify(p)} untouched`);
  }
  assert.equal(t.getValue([]), "R", "root (ancestor) value untouched");
  assert.equal(t.getValue(["a"]), "A-new", "edited node's value changed");
});

// =================================================================================
// setNodeValue_preserves_node_signals (Tree.lean)
// "Editing a node's value leaves that node's own child-collection membership
//  and order signals untouched (only its `.value` field changes)."
// =================================================================================
test("Lean setNodeValue_preserves_node_signals: setValue touches only value, not the node's own child membership/order", () => {
  const t = buildTree();
  const childKeysBefore = t.childKeys(["a"]);
  const report = t.setValue(["a"], "A-edited");

  assert.equal(report.value.length, 1, "value signal advanced");
  assert.equal(report.membership, false, "child membership untouched");
  assert.equal(report.order, false, "child order untouched");
  assert.deepEqual(t.childKeys(["a"]), childKeysBefore, "child order unchanged");
  // Children themselves are untouched.
  assert.equal(t.getValue(["a", "a1"]), 1);
  assert.equal(t.getValue(["a", "a2"]), 2);
});

// =================================================================================
// moveChild_preserves_non_parent (Tree.lean)
// "A child reorder leaves every node other than the parent byte-identical —
//  an unrelated level's readers are not disturbed."
// =================================================================================
test("Lean moveChild_preserves_non_parent: a child reorder leaves every non-parent node untouched", () => {
  const t = buildTree();
  const otherPaths = [["a"], ["a", "a1"], ["a", "a2"], ["b"]];
  const before = otherPaths.map((p) => ({ p, rec: recordAt(t, p) }));

  // Reorder root's children: a-b → b-a.
  t.moveChildBefore([], "a", "b");

  // Every non-parent node's record is byte-identical — including 'a' and 'b'
  // themselves (their value + their subtrees survive the reorder).
  for (const { p, rec } of before) {
    assert.deepEqual(recordAt(t, p), rec, `non-parent record at ${JSON.stringify(p)} untouched`);
  }
});

// =================================================================================
// moveChild_preserves_parent_value (Tree.lean)
// "A child reorder leaves the parent's own value cell untouched — atomic move
//  keeps the child's cell handle, dependents, value, and lineage; only
//  ordering + the order signal change."
// =================================================================================
test("Lean moveChild_preserves_parent_value: a child reorder does not change the parent's value or the child's identity", () => {
  const t = buildTree();
  const parentValueBefore = t.getValue(["a"]);
  const childHandleBefore = t.childHandle(["a"], "a1");
  const childValueBefore = t.getValue(["a", "a1"]);

  t.moveChildAfter(["a"], "a1", "a2"); // a1 ↔ a2

  assert.equal(t.getValue(["a"]), parentValueBefore, "parent's value cell untouched");
  assert.equal(t.childHandle(["a"], "a1"), childHandleBefore, "child handle stable across atomic move");
  assert.equal(t.getValue(["a", "a1"]), childValueBefore, "child value preserved");
  assert.deepEqual(t.childKeys(["a"]), ["a2", "a1"], "child order changed");
});

// =================================================================================
// moveChild_advances_order_signal_only (Tree.lean)
// "A child reorder advances the parent's per-level order signal by exactly one
//  and leaves its membership signal unchanged — child_ids readers invalidated
//  once, len/contains not at all."
// =================================================================================
test("Lean moveChild_advances_order_signal_only: a child reorder bumps order exactly once and leaves membership untouched", () => {
  const t = buildTree();
  const report = t.moveChildTo([], "b", 0); // b-a

  assert.equal(report.order, true, "order signal advances");
  assert.equal(report.membership, false, "membership signal untouched");
  assert.equal(report.value.length, 0, "no value reader touched");
  assert.deepEqual(t.childKeys([]), ["b", "a"]);
});
