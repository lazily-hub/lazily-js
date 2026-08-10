import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { assertKey, assertKeyWith, excuseKey, subBlock } from "./support/assert-key.js";
import { scenarios } from "./support/scenario.js";

import { SeqCrdt } from "../src/seq-crdt.js";

import { specPath } from "./spec-corpus.cjs";

const specCollections = specPath("collections");

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
  for (const [id, v, t] of [
    ["a", 0, 1],
    ["b", 1, 2],
    ["c", 2, 3],
    ["d", 3, 4],
  ]) {
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

test("a fork carries the source's clock forward but stamps with ITS OWN peer", () => {
  // Two halves of one invariant, and this scenario fails on either one alone
  // (`#lzzigforkhlcpeer`, first found and fixed in lazily-zig).
  //
  // CARRY THE POSITION. A fork has already OBSERVED everything the source
  // holds, so its clock must not restart at zero. `new SeqCrdt(peer)` did
  // exactly that, and then the fork's next local op — supplied a `now` BELOW
  // the source's lastWall, which is ordinary clock skew and the entire reason
  // an HLC exists — minted a stamp causally BEHIND state the fork already
  // held. LWW adopts only on `>`, so the fork's OWN local write was silently
  // dropped: below, b would read back 1 instead of the 99 it just wrote.
  //
  // DO NOT CARRY THE PEER. The peer is the stamp's final tiebreaker, so a fork
  // that also inherited the source's peer id would mint the SAME
  // (wall, logical, peer) triple as the source. A tie is not adopted by either
  // side, and the replicas diverge permanently (a=55, b=99 forever) — the one
  // outcome a CRDT exists to make impossible.
  //
  //   a@peer1  insertBack x=1  @ now=100  -> (100, 0, 1)
  //   b = a.fork(2)                       -> clock at (100, 0), peer 2
  //   b        setValue x=99   @ now=50   -> 50 <= 100, logical bumps -> (100, 1, 2)
  //   a        setValue x=55   @ now=50   -> 50 <= 100, logical bumps -> (100, 1, 1)
  //
  // b's (100, 1, 2) dominates on the peer tiebreak, so both settle on 99.
  //
  // `seqcrdt_convergence.json` cannot reach this: every fork in the corpus is
  // followed by an op whose `now` EXCEEDS the source's lastWall, so `send`
  // takes the `now > lastWall` branch and the logical counter resets to 0
  // regardless of which clock the fork started from.
  const a = new SeqCrdt(1);
  a.insertBack("x", 1, 100);
  const b = a.fork(2);

  b.setValue("x", 99, 50);
  // The fork's own write, before any merge. This is the dropped-write half.
  assert.equal(b.get("x"), 99);

  a.setValue("x", 55, 50);
  a.merge(b, 200);
  b.merge(a, 200);

  // Convergence FIRST: the replicas must agree at all before "which value won"
  // is even a meaningful question. This is the shared-peer half.
  assert.equal(a.get("x"), b.get("x"));
  assert.equal(a.get("x"), 99);
});

test("gc collects stable tombstones only", () => {
  const s = new SeqCrdt(1);
  s.insertBack("a", 1, 1);
  s.insertBack("b", 2, 2);
  s.insertBack("c", 3, 3);
  s.remove("b", 10);
  assert.equal(s.tombstoneCount(), 1);
  assert.equal(
    s.gcWith(() => false),
    0,
  );
  assert.equal(s.entryCount(), 3);
  assert.equal(
    s.gcWith(() => true),
    1,
  );
  assert.equal(s.entryCount(), 2);
  assert.deepEqual(s.order(), ["a", "c"]);
});

// -- conformance fixture replay ----------------------------------------------

function applyOp(target, step) {
  switch (step.op) {
    case "insert_back":
      target.insertBack(step.id, step.value, step.now);
      break;
    case "insert_front":
      target.insertFront(step.id, step.value, step.now);
      break;
    case "insert_between":
      target.insertBetween(step.id, step.value, step.left ?? null, step.right ?? null, step.now);
      break;
    case "set_value":
      target.setValue(step.id, step.value, step.now);
      break;
    case "move_after":
      target.moveAfter(step.id, step.anchor, step.now);
      break;
    case "move_before":
      target.moveBefore(step.id, step.anchor, step.now);
      break;
    case "move_between":
      target.moveBetween(step.id, step.left ?? null, step.right ?? null, step.now);
      break;
    case "remove":
      target.remove(step.id, step.now);
      break;
    default:
      throw new Error(`unknown seqcrdt op ${step.op}`);
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
    } else {
      // The chain had no closing arm (#lzscenariobodyskip): the step's shape IS
      // its discriminator here, so a step naming none of these keys — a renamed
      // or newly-added step form — was silently skipped and the scenario's
      // `expect` block was then compared against a replica the step never
      // touched.
      throw new Error(`unrecognized seqcrdt step: ${JSON.stringify(step)}`);
    }
  }

  const expect = scenario.expect;
  if (!expect) return;
  // Default target: an explicit `on`, else the first orders_equal replica (the
  // merged result), else the main replica "a".
  const defaultTarget = expect.on ?? (expect.orders_equal ? expect.orders_equal[0][0] : "a");

  // Key-exhaustive rather than a chain of `if (expect.x)` guards: a guard READS
  // the key and then drops it whenever the value is falsy or the shape moves, so
  // a fixture carrying `len: 0` or an empty `contains_all` was replayed with
  // nothing compared (#lzconsumednotasserted).
  for (const key of Object.keys(expect)) {
    switch (key) {
      case "on":
        excuseKey(
          expect,
          "on",
          "selector, not an observation: it names which replica order/len/get are " +
            "read from, and those reads are asserted against their own keys",
        );
        break;
      case "order":
        assertKey(expect, "order", replicas.get(defaultTarget).order(), scenario.name);
        break;
      case "len":
        assertKey(expect, "len", replicas.get(defaultTarget).order().length, scenario.name);
        break;
      case "get":
        {
          // Descended (#lzsubblockkeyset): the child tracker owns every id the
          // fixture names, so one added upstream is unconsumed rather than
          // skipped by a loop over today's keys.
          const want = subBlock(expect, "get");
          for (const id of Object.keys(want)) {
            assertKey(want, id, replicas.get(defaultTarget).get(id), scenario.name);
          }
        }
        break;
      case "orders_equal":
        assertKeyWith(expect, "orders_equal", (pairs) => {
          assert.ok(pairs.length > 0, `${scenario.name}: orders_equal relates nothing`);
          for (const [x, y] of pairs) {
            assert.deepEqual(replicas.get(x).order(), replicas.get(y).order(), scenario.name);
          }
        });
        break;
      case "contains_all":
        assertKeyWith(expect, "contains_all", (ids) => {
          const target = replicas.get(defaultTarget);
          for (const id of ids) assert.ok(target.contains(id), scenario.name);
        });
        break;
      case "order_on":
        {
          const want = subBlock(expect, "order_on");
          for (const r of Object.keys(want)) {
            assertKey(want, r, replicas.get(r).order(), scenario.name);
          }
        }
        break;
      case "get_on":
        {
          // Descended twice: replica, then id.
          const want = subBlock(expect, "get_on");
          for (const r of Object.keys(want)) {
            const kv = subBlock(want, r);
            for (const id of Object.keys(kv)) {
              assertKey(kv, id, replicas.get(r).get(id), scenario.name);
            }
          }
        }
        break;
      case "not_contains_on":
        {
          const want = subBlock(expect, "not_contains_on");
          for (const r of Object.keys(want)) {
            assertKeyWith(
              want,
              r,
              (ids) => {
                for (const id of ids) {
                  assert.equal(replicas.get(r).contains(id), false, scenario.name);
                }
              },
              scenario.name,
            );
          }
        }
        break;
      default:
        assert.fail(`${scenario.name}: unknown seqcrdt expectation \`${key}\``);
    }
  }
}

test("conformance: seqcrdt_convergence.json", () => {
  const fixture = loadFixture("seqcrdt_convergence.json");
  for (const scenario of scenarios(fixture)) {
    runSeqCrdtScenario(scenario);
  }
});
