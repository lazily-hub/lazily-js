import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { SeqCrdt } from "../src/seq-crdt.js";

const here = dirname(fileURLToPath(import.meta.url));
const specCollections = join(here, "..", "..", "lazily-spec", "conformance", "collections");

function loadFixture(name) {
  const path = join(specCollections, name);
  assert.ok(existsSync(path), `missing spec fixture ${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

test("insert back and front orders", () => {
  const s = new SeqCrdt(1);
  s.insertBack("a", 0, 1);
  s.insertBack("b", 1, 2);
  s.insertBack("c", 2, 3);
  s.insertFront("z", 9, 4);
  assert.deepEqual(s.order(), ["z", "a", "b", "c"]);
  assert.equal(s.get("b"), 1);
});

test("move is single reassignment, no duplication", () => {
  const s = new SeqCrdt(1);
  for (const [id, v, t] of [["a", 0, 1], ["b", 1, 2], ["c", 2, 3], ["d", 3, 4]]) {
    s.insertBack(id, v, t);
  }
  assert.equal(s.moveAfter("a", "d", 10), true);
  assert.deepEqual(s.order(), ["b", "c", "d", "a"]);
  assert.equal(s.get("a"), 0);
  assert.equal(s.order().length, 4);
});

test("concurrent inserts same gap converge (both survive)", () => {
  const a = new SeqCrdt(1);
  a.insertBack("root", "R", 1);
  const b = a.fork(2);
  a.insertBack("a1", "A", 10);
  b.insertBack("b1", "B", 10);
  const a2 = a.clone();
  a2.merge(b, 20);
  const b2 = b.clone();
  b2.merge(a, 20);
  assert.deepEqual(a2.order(), b2.order());
  assert.equal(a2.order().length, 3);
  for (const id of ["root", "a1", "b1"]) {
    assert.ok(a2.contains(id));
  }
});

test("concurrent move converges to later stamp, no duplication", () => {
  const a = new SeqCrdt(1);
  a.insertBack("x", "X", 1);
  a.insertBack("y", "Y", 2);
  a.insertBack("z", "Z", 3);
  const b = a.fork(2);
  a.moveAfter("x", "y", 10);
  b.moveAfter("x", "z", 20);
  const merged = a.clone();
  merged.merge(b, 30);
  assert.deepEqual(merged.order(), ["y", "z", "x"]);
  assert.equal(merged.order().length, 3);
});

test("concurrent move and value edit do not conflict", () => {
  const a = new SeqCrdt(1);
  a.insertBack("a", 1, 1);
  a.insertBack("b", 2, 2);
  const b = a.fork(2);
  a.moveAfter("a", "b", 10);
  b.setValue("a", 99, 10);
  const merged = a.clone();
  merged.merge(b, 20);
  assert.deepEqual(merged.order(), ["b", "a"]);
  assert.equal(merged.get("a"), 99);
});

test("remove tombstone converges; merge is commutative", () => {
  const a = new SeqCrdt(1);
  a.insertBack("a", 1, 1);
  a.insertBack("b", 2, 2);
  a.insertBack("c", 3, 3);
  const b = a.fork(2);
  a.remove("b", 10);
  b.moveAfter("a", "c", 11);
  const ab = a.clone();
  ab.merge(b, 20);
  const ba = b.clone();
  ba.merge(a, 20);
  assert.deepEqual(ab.order(), ba.order());
  assert.equal(ab.contains("b"), false);
});

test("gc collects stable tombstones only", () => {
  const s = new SeqCrdt(1);
  s.insertBack("a", 1, 1);
  s.insertBack("b", 2, 2);
  s.insertBack("c", 3, 3);
  s.remove("b", 10);
  assert.equal(s.tombstoneCount(), 1);
  assert.equal(s.gcWith(() => false), 0);
  assert.equal(s.entryCount(), 3);
  assert.equal(s.gcWith(() => true), 1);
  assert.equal(s.entryCount(), 2);
  assert.deepEqual(s.order(), ["a", "c"]);
});

// -- conformance fixture replay ----------------------------------------------

function applyOp(target, step) {
  switch (step.op) {
    case "insert_back": target.insertBack(step.id, step.value, step.now); break;
    case "insert_front": target.insertFront(step.id, step.value, step.now); break;
    case "insert_between": target.insertBetween(step.id, step.value, step.left ?? null, step.right ?? null, step.now); break;
    case "set_value": target.setValue(step.id, step.value, step.now); break;
    case "move_after": target.moveAfter(step.id, step.anchor, step.now); break;
    case "move_before": target.moveBefore(step.id, step.anchor, step.now); break;
    case "move_between": target.moveBetween(step.id, step.left ?? null, step.right ?? null, step.now); break;
    case "remove": target.remove(step.id, step.now); break;
    default: throw new Error(`unknown seqcrdt op ${step.op}`);
  }
}

function runSeqCrdtScenario(scenario) {
  const replicas = new Map();
  const peer = scenario.replica?.peer ?? scenario.seed?.peer ?? 1;
  const main = new SeqCrdt(peer);
  replicas.set("a", main);
  if (scenario.seed?.inserts) {
    for (const ins of scenario.seed.inserts) {
      main.insertBack(ins.id, ins.value, ins.now);
    }
  }

  for (const step of scenario.steps ?? []) {
    if (step.fork) {
      replicas.set(step.fork, replicas.get("a").fork(step.peer));
    } else if (step.clone) {
      replicas.set(step.clone, replicas.get(step.from).clone());
    } else if (step.merge) {
      replicas.get(step.merge.into).merge(replicas.get(step.merge.from), step.now);
    } else if (step.op) {
      applyOp(replicas.get(step.on ?? "a"), step);
    }
  }

  const expect = scenario.expect;
  if (!expect) return;
  // Default target: an explicit `on`, else the first orders_equal replica (the
  // merged result), else the main replica "a".
  const defaultTarget =
    expect.on ?? (expect.orders_equal ? expect.orders_equal[0][0] : "a");
  if (expect.order) {
    assert.deepEqual(replicas.get(defaultTarget).order(), expect.order, scenario.name);
  }
  if (expect.len !== undefined) {
    assert.equal(replicas.get(defaultTarget).order().length, expect.len, scenario.name);
  }
  if (expect.get) {
    for (const [id, v] of Object.entries(expect.get)) {
      assert.equal(replicas.get(defaultTarget).get(id), v, scenario.name);
    }
  }
  if (expect.orders_equal) {
    for (const [x, y] of expect.orders_equal) {
      assert.deepEqual(replicas.get(x).order(), replicas.get(y).order(), scenario.name);
    }
  }
  if (expect.contains_all) {
    const target = replicas.get(defaultTarget);
    for (const id of expect.contains_all) assert.ok(target.contains(id), scenario.name);
  }
  if (expect.order_on) {
    for (const [r, ord] of Object.entries(expect.order_on)) {
      assert.deepEqual(replicas.get(r).order(), ord, scenario.name);
    }
  }
  if (expect.get_on) {
    for (const [r, kv] of Object.entries(expect.get_on)) {
      for (const [id, v] of Object.entries(kv)) {
        assert.equal(replicas.get(r).get(id), v, scenario.name);
      }
    }
  }
  if (expect.not_contains_on) {
    for (const [r, ids] of Object.entries(expect.not_contains_on)) {
      for (const id of ids) assert.equal(replicas.get(r).contains(id), false, scenario.name);
    }
  }
}

test("conformance: seqcrdt_convergence.json", () => {
  const fixture = loadFixture("seqcrdt_convergence.json");
  for (const scenario of fixture.scenarios) {
    runSeqCrdtScenario(scenario);
  }
});
