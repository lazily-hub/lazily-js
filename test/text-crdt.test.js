import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { TextCrdt } from "../src/text-crdt.js";

const here = dirname(fileURLToPath(import.meta.url));
const specCollections = join(here, "..", "..", "lazily-spec", "conformance", "collections");
const specCrdtTree = join(here, "..", "..", "lazily-spec", "conformance", "crdt-tree");
const localCrdtTree = join(here, "conformance", "crdt-tree");

function loadFixture(name) {
  const path = join(specCollections, name);
  assert.ok(existsSync(path), `missing spec fixture ${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadCrdtTreeFixture(name) {
  const specPath = join(specCrdtTree, name);
  const path = existsSync(specPath) ? specPath : join(localCrdtTree, name);
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

test("delta sync converges two replicas (#lztextsync)", () => {
  const base = TextCrdt.fromStr(0, "hello\n");
  const a = base.fork(1);
  a.insertStr(a.len(), "world\n");
  const b = base.fork(2);
  b.delete(0);

  const aDelta = a.deltaSince(b.versionVector());
  const bDelta = b.deltaSince(a.versionVector());
  assert.equal(a.applyDelta(bDelta), true);
  b.applyDelta(aDelta);

  assert.equal(a.text(), b.text(), "replicas converge after delta exchange");
  assert.equal(a.text(), "ello\nworld\n");
});

test("full-snapshot delta reconstructs a mergeable replica (#lztextsync)", () => {
  const canonical = TextCrdt.fromStr(1, "base\n");
  const snapshot = canonical.deltaSince({});
  const member = new TextCrdt(2);
  member.applyDelta(snapshot);
  assert.equal(member.text(), "base\n");

  canonical.insertStr(canonical.len(), "A\n");
  member.insertStr(member.len(), "B\n");
  canonical.applyDelta(member.deltaSince(canonical.versionVector()));
  member.applyDelta(canonical.deltaSince(member.versionVector()));
  assert.equal(canonical.text(), member.text(), "shared-identity convergence");
});

test("delta apply is idempotent (#lztextsync)", () => {
  const a = TextCrdt.fromStr(1, "abc\n");
  const b = new TextCrdt(2);
  const delta = a.deltaSince({});
  assert.equal(b.applyDelta(delta), true);
  assert.equal(b.applyDelta(delta), false, "re-applying a delta is a no-op");
  assert.equal(b.text(), a.text());
});

test("CrdtTree surface delegates to TextCrdt join and value", () => {
  const left = TextCrdt.fromStr(1, "base");
  const right = left.fork(2);
  right.insertStr(right.len(), "!");
  assert.equal(left.mergeFrom(right), true);
  assert.equal(left.value(), "base!");
  assert.equal(left.mergeFrom(right), false, "merge replay is idempotent");
});

test("CrdtTree: algebra.json canonical fixture", () => {
  const fixture = loadCrdtTreeFixture("algebra.json");
  assert.equal(fixture.kind, "CrdtTree");

  const mergeScenario = fixture.scenarios[0];
  const base = TextCrdt.fromStr(mergeScenario.seed.peer, mergeScenario.seed.text);
  const replicas = new Map(mergeScenario.replicas.map((definition) => {
    const replica = base.fork(definition.peer);
    replica.insertStr(replica.len(), definition.insert);
    return [definition.name, replica];
  }));
  const folds = mergeScenario.merge_orders.map((order, index) => {
    const folded = base.fork(100 + index);
    for (const name of order) folded.mergeFrom(replicas.get(name));
    return folded;
  });
  for (const folded of folds.slice(1)) {
    assert.equal(folded.value(), folds[0].value());
    assert.deepEqual(folded.versionVector(), folds[0].versionVector());
  }

  const snapshotScenario = fixture.scenarios[1];
  const canonical = TextCrdt.fromStr(snapshotScenario.seed.peer, snapshotScenario.seed.text);
  const snapshot = canonical.deltaSince({});
  const restored = new TextCrdt(snapshotScenario.restore_peer);
  assert.equal(restored.applyDelta(snapshot), true);
  assert.equal(restored.value(), canonical.value());
  assert.deepEqual(restored.deltaSince({}), snapshot, "snapshot preserves operation identity");
  canonical.insertStr(canonical.len(), "A");
  restored.insertStr(restored.len(), "B");
  canonical.applyDelta(restored.deltaSince(canonical.versionVector()));
  restored.applyDelta(canonical.deltaSince(restored.versionVector()));
  assert.equal(canonical.value(), restored.value());
  assert.equal(canonical.len(), snapshotScenario.seed.text.length + 2);

  const steadyScenario = fixture.scenarios[2];
  const steady = TextCrdt.fromStr(steadyScenario.seed.peer, steadyScenario.seed.text);
  const empty = steady.deltaSince(steady.versionVector());
  assert.deepEqual(empty, steadyScenario.expect.delta);
  assert.equal(steady.applyDelta(empty), steadyScenario.expect.apply_changed);
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

function applyTextCrdtOp(target, step, label) {
  if (step.op === "insert") {
    target.insert(step.index, step.ch);
  } else if (step.op === "insert_str") {
    target.insertStr(step.index, step.str);
  } else if (step.op === "delete") {
    target.delete(step.index);
  } else if (step.op === "gc") {
    const n = target.gcWith(() => step.stable);
    if (step.expect_collected !== undefined) {
      assert.equal(n, step.expect_collected, `${label}: gc collected`);
    }
  } else {
    throw new Error(`${label}: unknown textcrdt op ${step.op}`);
  }
}

function runTextCrdtScenario(scenario) {
  const label = scenario.name ?? "scenario";
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
    } else if (step.new) {
      replicas.set(step.new, new TextCrdt(step.peer));
    } else if (step.delta) {
      const { into, from } = step.delta;
      const ops = replicas.get(from).deltaSince(replicas.get(into).versionVector());
      const changed = replicas.get(into).applyDelta(ops);
      if (step.expect_changed !== undefined) {
        assert.equal(changed, step.expect_changed, `${label}: delta ${from}->${into}`);
      }
    } else if (step.snapshot) {
      const { from, into, peer: snapPeer } = step.snapshot;
      const ops = replicas.get(from).deltaSince({});
      const replica = new TextCrdt(snapPeer);
      const changed = replica.applyDelta(ops);
      replicas.set(into, replica);
      if (step.expect_changed !== undefined) {
        assert.equal(changed, step.expect_changed, `${label}: snapshot ${from}->${into}`);
      }
    } else if (step.exchange) {
      const [x, y] = step.exchange;
      const toX = replicas.get(y).deltaSince(replicas.get(x).versionVector());
      const toY = replicas.get(x).deltaSince(replicas.get(y).versionVector());
      replicas.get(x).applyDelta(toX);
      replicas.get(y).applyDelta(toY);
    } else if (step.op) {
      applyTextCrdtOp(replicas.get(step.on ?? "a"), step, label);
    }
  }

  const expect = scenario.expect;
  if (expect) {
    if (expect.text !== undefined) {
      assert.equal(replicas.get(expect.on ?? "a").text(), expect.text, label);
    }
    if (expect.texts_equal) {
      for (const [x, y] of expect.texts_equal) {
        assert.equal(replicas.get(x).text(), replicas.get(y).text(), label);
      }
    }
    if (expect.len !== undefined) {
      assert.equal(replicas.get(expect.on ?? "a").len(), expect.len, label);
    }
    if (expect.text_on) {
      for (const [name, want] of Object.entries(expect.text_on)) {
        assert.equal(replicas.get(name).text(), want, `${label}: text_on ${name}`);
      }
    }
    if (expect.version_vector_on) {
      for (const [name, want] of Object.entries(expect.version_vector_on)) {
        assert.deepEqual(replicas.get(name).versionVector(), want, `${label}: version_vector_on ${name}`);
      }
    }
  }
}

test("conformance: textcrdt_convergence.json", () => {
  const fixture = loadFixture("textcrdt_convergence.json");
  for (const scenario of fixture.scenarios) {
    runTextCrdtScenario(scenario);
  }
});

test("conformance: textcrdt_delta_sync.json (#lztextsync)", () => {
  const fixture = loadFixture("textcrdt_delta_sync.json");
  for (const scenario of fixture.scenarios) {
    runTextCrdtScenario(scenario);
  }
});
