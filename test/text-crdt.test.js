import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { TextCrdt } from "../src/text-crdt.js";

const here = dirname(fileURLToPath(import.meta.url));
const specCollections = join(here, "..", "..", "lazily-spec", "conformance", "collections");

function loadFixture(name) {
  const path = join(specCollections, name);
  assert.ok(existsSync(path), `missing spec fixture ${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

test("local insert and delete", () => {
  const c = TextCrdt.fromStr(1, "helo");
  c.insert(3, "l");
  c.insert(5, "!");
  c.delete(0);
  assert.equal(c.text(), "ello!");
  assert.equal(c.len(), 5);
});

test("concurrent inserts at same spot converge deterministically", () => {
  const a = TextCrdt.fromStr(1, "XY");
  const b = a.fork(2);
  a.insert(1, "a");
  b.insert(1, "b");
  assert.equal(a.merge(b), true);
  b.merge(a);
  assert.equal(a.text(), b.text());
  assert.equal(a.len(), 4);
  assert.ok(a.text().startsWith("X"));
  assert.ok(a.text().endsWith("Y"));
});

test("concurrent insert and delete both apply", () => {
  const a = TextCrdt.fromStr(1, "abc");
  const b = a.fork(2);
  a.delete(1);
  b.insert(3, "d");
  a.merge(b);
  b.merge(a);
  assert.equal(a.text(), b.text());
  assert.equal(a.text(), "acd");
});

test("merge is idempotent and commutative", () => {
  const a = TextCrdt.fromStr(1, "one");
  const b = a.fork(2);
  a.insert(3, "X");
  b.insert(0, "Y");
  const ab = a.clone();
  ab.merge(b);
  ab.merge(b); // idempotent
  const ba = b.clone();
  ba.merge(a);
  assert.equal(ab.text(), ba.text());
});

test("gc collects a stable deleted leaf", () => {
  const c = TextCrdt.fromStr(1, "abc");
  c.delete(2);
  assert.equal(c.text(), "ab");
  assert.equal(c.tombstoneCount(), 1);
  assert.equal(c.gcWith(() => false), 0);
  assert.equal(c.tombstoneCount(), 1);
  assert.equal(c.gcWith(() => true), 1);
  assert.equal(c.tombstoneCount(), 0);
  assert.equal(c.text(), "ab");
});

test("gc keeps referenced tombstone then collects bottom-up", () => {
  const c = TextCrdt.fromStr(1, "abc");
  c.delete(1); // 'b' is origin of 'c'
  assert.equal(c.gcWith(() => true), 0); // referenced, kept
  assert.equal(c.text(), "ac");
  c.delete(1); // now 'c'
  assert.equal(c.gcWith(() => true), 2); // both collected bottom-up
  assert.equal(c.tombstoneCount(), 0);
  assert.equal(c.text(), "a");
});

// -- conformance fixture replay ----------------------------------------------

function runTextCrdtScenario(scenario) {
  const replicas = new Map();
  const peer = scenario.replica?.peer ?? scenario.seed?.peer ?? 1;
  const seedText = typeof scenario.seed === "string" ? scenario.seed : scenario.seed?.text;
  const main = new TextCrdt(peer);
  if (seedText) {
    main.insertStr(0, seedText);
  }
  replicas.set("a", main);

  for (const step of scenario.steps ?? []) {
    if (step.fork) {
      const src = replicas.get("a");
      replicas.set(step.fork, src.fork(step.peer));
    } else if (step.clone) {
      replicas.set(step.clone, replicas.get(step.from).clone());
    } else if (step.merge) {
      replicas.get(step.merge.into).merge(replicas.get(step.merge.from));
    } else if (step.op) {
      const target = replicas.get(step.on ?? "a");
      if (step.op === "insert") target.insert(step.index, step.ch);
      else if (step.op === "delete") target.delete(step.index);
      else if (step.op === "gc") {
        const n = target.gcWith(() => step.stable);
        if (step.expect_collected !== undefined) {
          assert.equal(n, step.expect_collected, `${scenario.name}: gc collected`);
        }
      }
    }
  }

  const expect = scenario.expect;
  if (expect) {
    const target = replicas.get(expect.on ?? "a");
    if (expect.text !== undefined) {
      assert.equal(target.text(), expect.text, scenario.name);
    }
    if (expect.texts_equal) {
      for (const [x, y] of expect.texts_equal) {
        assert.equal(replicas.get(x).text(), replicas.get(y).text(), scenario.name);
      }
    }
    if (expect.len !== undefined) {
      assert.equal(target.len(), expect.len, scenario.name);
    }
  }
}

test("conformance: textcrdt_convergence.json", () => {
  const fixture = loadFixture("textcrdt_convergence.json");
  for (const scenario of fixture.scenarios) {
    runTextCrdtScenario(scenario);
  }
});
