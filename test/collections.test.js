import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CellMap, reconcileCollections } from "../src/collections.js";

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
