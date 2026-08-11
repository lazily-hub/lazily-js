import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { assertKey, assertKeyWith, subBlock } from "./support/assert-key.js";
import { recordScenario } from "./support/scenario.js";

import Ajv2020 from "ajv/dist/2020.js";

import {
  LosslessTreeCrdt,
  LeafKind,
  ROOT,
  TreeVersionFrontier,
  treeUpdateToWire,
} from "../src/lossless-tree-crdt.js";

import { schemasRoot, specPath } from "./spec-corpus.cjs";

const specDir = specPath("lossless-tree");

function loadFixture(name) {
  const path = join(specDir, name);
  assert.ok(existsSync(path), `missing spec fixture ${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

const LEAF_KIND = {
  token: LeafKind.Token,
  trivia: LeafKind.Trivia,
  raw: LeafKind.Raw,
  error: LeafKind.Error,
};

function nodeSeed(spec) {
  if (typeof spec.element === "string") return { type: "element", kind: spec.element };
  if (spec.leaf) {
    // A table miss used to yield `undefined` and be seeded as a leaf with no
    // kind (#lzscenariobodyskip) — the render assertions mostly do not look at
    // leaf kind, so an unknown spelling produced a tree that still compared
    // equal. The lookup is now checked.
    const leafKind = LEAF_KIND[spec.leaf.kind];
    if (leafKind === undefined) {
      throw new Error(`unknown leaf kind in fixture: ${spec.leaf.kind}`);
    }
    return { type: "leaf", leafKind, text: spec.leaf.text };
  }
  throw new Error(`node spec has neither element nor leaf: ${JSON.stringify(spec)}`);
}

// A named world of replicas plus the shared label -> id map.
class World {
  constructor() {
    this.replicas = new Map();
    this.ids = new Map();
  }
  id(label) {
    const v = this.ids.get(label);
    if (!v) throw new Error(`unknown node label \`${label}\``);
    return v;
  }
  afterOf(op) {
    if (op.after === undefined || op.after === null) return null;
    return this.id(op.after);
  }
  buildChildren(spec, parent) {
    if (!Array.isArray(spec.children)) return;
    let prev = null;
    for (const child of spec.children) {
      const id = this.replicas.get("a").createNode(parent, prev, nodeSeed(child));
      this.ids.set(child.label, id);
      this.buildChildren(child, id);
      prev = id;
    }
  }
}

function applyStep(world, step) {
  if (typeof step.fork === "string") {
    world.replicas.set(step.fork, world.replicas.get("a").fork(step.peer));
  } else if (step.sync) {
    const { from, to } = step.sync;
    const update = world.replicas.get(from).diff(world.replicas.get(to).frontier());
    world.replicas.get(to).applyUpdate(update);
  } else if (step.deliver) {
    const { from, to, only } = step.deliver;
    const full = world.replicas.get(from).diff(world.replicas.get(to).frontier());
    world.replicas.get(to).applyUpdate({ ops: only.map((i) => full.ops[i]) });
  } else if (typeof step.on === "string") {
    applyOp(world, step.on, step);
  } else {
    throw new Error(`unrecognized step: ${JSON.stringify(step)}`);
  }
}

function applyOp(world, on, op) {
  const replica = world.replicas.get(on);
  switch (op.op) {
    case "create": {
      const id = replica.createNode(world.id(op.parent), world.afterOf(op), nodeSeed(op));
      world.ids.set(op.label, id);
      break;
    }
    case "edit_leaf":
      replica.editLeaf(world.id(op.node), op.at_byte, op.delete_bytes ?? 0, op.insert ?? "");
      break;
    case "split":
      world.ids.set(op.new_label, replica.splitLeaf(world.id(op.node), op.at_byte));
      break;
    case "merge_leaves":
      replica.mergeAdjacentLeaves(world.id(op.left), world.id(op.right));
      break;
    case "reorder":
      replica.reorderChild(world.id(op.node), world.afterOf(op));
      break;
    case "tombstone":
      replica.tombstoneNode(world.id(op.node));
      break;
    default:
      throw new Error(`unknown op: ${op.op}`);
  }
}

// Key-exhaustive, not type-guarded. `typeof expect.render === "string"` READS the
// key and then discards it whenever the type does not match, so a fixture whose
// `render` grew a different shape was replayed with nothing compared
// (#lzconsumednotasserted). An unmodelled key now fails the run.
function assertExpect(world, expect, scenario) {
  for (const key of Object.keys(expect)) {
    switch (key) {
      case "render":
        assertKey(expect, "render", world.replicas.get("a").render(), `${scenario}: render on a`);
        break;
      case "render_on":
        {
          // Descended (#lzsubblockkeyset): the child tracker owns every replica
          // the fixture names, so one added upstream is reported as unconsumed
          // rather than skipped by a loop over today's keys.
          const renders = subBlock(expect, "render_on");
          for (const name of Object.keys(renders)) {
            assertKey(
              renders,
              name,
              world.replicas.get(name).render(),
              `${scenario}: render on ${name}`,
            );
          }
        }
        break;
      case "live_nodes":
        assertKey(
          expect,
          "live_nodes",
          world.replicas.get("a").liveNodeCount(),
          `${scenario}: live_nodes`,
        );
        break;
      case "converged":
        assertKeyWith(expect, "converged", (names) => {
          assert.ok(
            Array.isArray(names) && names.length > 1,
            `${scenario}: converged names fewer than two replicas, so it relates nothing`,
          );
          const first = world.replicas.get(names[0]).render();
          for (const name of names.slice(1)) {
            assert.equal(
              world.replicas.get(name).render(),
              first,
              `${scenario}: ${names[0]}/${name} converge`,
            );
          }
        });
        break;
      default:
        assert.fail(`${scenario}: unknown expectation \`${key}\``);
    }
  }
}

function runFixture(name) {
  const fixture = loadFixture(name);
  fixture.scenarios.forEach((scenario, i) => {
    recordScenario(scenario);
    const label = scenario.name ? `${name}[${scenario.name}]` : `${name}[${i}]`;
    const world = new World();
    world.replicas.set("a", new LosslessTreeCrdt(scenario.seed.peer));
    world.buildChildren(scenario.seed.tree, ROOT);
    (scenario.steps ?? []).forEach((step) => applyStep(world, step));
    assertExpect(world, scenario.expect, label);
  });
}

for (const name of [
  "exact_roundtrip.json",
  "one_leaf_edit_delta.json",
  "split_merge.json",
  "concurrent_insert_same_parent.json",
  "concurrent_reorder_and_leaf_edit.json",
  "non_contiguous_anti_entropy.json",
  "token_trivia_preservation.json",
  "invalid_source_roundtrip.json",
  "concurrent_conflict_preserves_text.json",
]) {
  test(`conformance: ${name}`, () => runFixture(name));
}

// -- diff op ORDER is a cross-binding contract (#lzdifforderallbindings) ------
//
// `diff` sorts by `(counter, peer)`. That sort looks like a cosmetic tidy-up and
// nothing pinned it, but the shared corpus addresses diff results POSITIONALLY:
// `lossless-tree/non_contiguous_anti_entropy.json` delivers `only: [0, 2]`,
// which indexes into whatever `diff` returns. The fixture therefore means the
// same thing in rs / py / js / zig only while all four return the same order.
//
// The corpus cannot defend the contract itself. Measured in lazily-zig (commit
// e8a2a28): reversing the sort, and deleting it outright, both left the whole
// suite green — the two delivered indices select the same SET either way, and
// `applyUpdate` is order-tolerant by design. So the order needs a direct test.
//
// The trap in writing one is vacuity: if the ops enter the log already in
// canonical order, a reversed or absent sort satisfies "strictly increasing" by
// luck. So the state below is built so ARRIVAL order and CANONICAL order
// genuinely differ — `a` runs ahead to counter 4 while `b`'s op stays at
// counter 3, and that lower-counter remote op arrives LAST — and the test
// asserts that difference EXPLICITLY first. If a refactor ever makes the two
// coincide, this test fails loudly rather than degrading into a tautology.
test("diff returns ops in canonical (counter, peer) order", () => {
  const a = new LosslessTreeCrdt(1);
  const para = a.createNode(ROOT, null, { type: "element", kind: "para" });
  const base = a.createNode(para, null, { type: "leaf", leafKind: LeafKind.Trivia, text: "0" });

  const b = a.fork(2);

  // `a` runs ahead to counter 4; `b`'s single op stays at counter 3.
  const one = a.createNode(para, base, { type: "leaf", leafKind: LeafKind.Trivia, text: "1" });
  const two = a.createNode(para, one, { type: "leaf", leafKind: LeafKind.Trivia, text: "2" });
  const remote = b.createNode(para, base, { type: "leaf", leafKind: LeafKind.Trivia, text: "9" });

  const fromB = b.diff(a.frontier());
  assert.equal(fromB.ops.length, 1, "only b's own op is unknown to a");
  a.applyUpdate(fromB);

  const all = a.diff(new TreeVersionFrontier());

  // The order the ops entered `a`: its four local ops as committed, then the
  // remote op, which lands last despite sorting fourth. (`createNode` returns
  // the node id, which is its op id, so this is built from real values rather
  // than from hardcoded counters.)
  const arrival = [para, base, one, two, remote];
  const key = (id) => `${id.counter}:${id.peer}`;

  // Same ops, so the comparison below is about ORDER and nothing else. If the
  // library ever mints a different op set here, this fails instead of letting
  // the order assertions compare against a stale list.
  assert.deepEqual(
    all.ops.map((op) => key(op.id)).sort(),
    arrival.map(key).sort(),
    "diff returns exactly the ops that entered the replica",
  );

  // Non-vacuity, asserted against a canonical order the TEST computes rather
  // than one the library hands back: if a refactor ever made ops arrive already
  // sorted, every check below would hold for an unsorted or reversed `diff` too
  // and this test would silently pin nothing. This fails loudly instead.
  const canonical = [...arrival].sort((x, y) =>
    x.counter !== y.counter ? x.counter - y.counter : x.peer - y.peer,
  );
  assert.notDeepEqual(
    arrival.map(key),
    canonical.map(key),
    "arrival order must differ from canonical order or this test pins nothing",
  );

  // The contract: strictly increasing by (counter, peer).
  for (let i = 1; i < all.ops.length; i++) {
    const prev = all.ops[i - 1].id;
    const curr = all.ops[i].id;
    const ordered =
      prev.counter !== curr.counter ? prev.counter < curr.counter : prev.peer < curr.peer;
    assert.ok(ordered, `diff op ${i - 1} (${key(prev)}) must sort before op ${i} (${key(curr)})`);
  }
});

// -- Wire schema compliance: emitted TreeUpdate validates against the schema ---

const schemaDir = schemasRoot;
const loadSchema = (n) => JSON.parse(readFileSync(join(schemaDir, `${n}.json`), "utf8"));

test("emitted TreeUpdate validates against lossless-tree-delta.json", () => {
  const ajv = new Ajv2020({ strict: false });
  ajv.addSchema(loadSchema("lossless-tree"));
  ajv.addSchema(loadSchema("lossless-tree-delta"));
  const validate = ajv.getSchema("https://lazily.dev/schemas/lossless-tree-delta.json");
  assert.ok(validate, "delta schema registered");

  // Exercise every op variant so the emitted delta carries one of each.
  const t = new LosslessTreeCrdt(1);
  const para = t.createNode(ROOT, null, { type: "element", kind: "para" });
  const a = t.createNode(para, null, { type: "leaf", leafKind: LeafKind.Raw, text: "hello world" });
  const b = t.createNode(para, a, { type: "leaf", leafKind: LeafKind.Token, text: "!" });
  t.editLeaf(a, 5, 0, "X"); // LeafEdit
  const tail = t.splitLeaf(a, 6); // SplitLeaf
  t.mergeAdjacentLeaves(a, tail); // MergeLeaves
  t.reorderChild(b, null); // Reorder
  t.tombstoneNode(b); // Tombstone

  const wire = treeUpdateToWire(t.diff(new TreeVersionFrontier()));
  const ok = validate(wire);
  assert.ok(ok, `emitted TreeUpdate invalid: ${JSON.stringify(validate.errors)}`);
});
