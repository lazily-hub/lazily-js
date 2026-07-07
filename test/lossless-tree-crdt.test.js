import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  LosslessTreeCrdt,
  LeafKind,
  ROOT,
  TreeVersionFrontier,
  treeUpdateToWire,
} from "../src/lossless-tree-crdt.js";

const here = dirname(fileURLToPath(import.meta.url));
const specDir = join(here, "..", "..", "lazily-spec", "conformance", "lossless-tree");

function loadFixture(name) {
  const path = join(specDir, name);
  assert.ok(existsSync(path), `missing spec fixture ${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

const LEAF_KIND = { token: LeafKind.Token, trivia: LeafKind.Trivia, raw: LeafKind.Raw, error: LeafKind.Error };

function nodeSeed(spec) {
  if (typeof spec.element === "string") return { type: "element", kind: spec.element };
  if (spec.leaf) return { type: "leaf", leafKind: LEAF_KIND[spec.leaf.kind], text: spec.leaf.text };
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

function assertExpect(world, expect, scenario) {
  if (typeof expect.render === "string") {
    assert.equal(world.replicas.get("a").render(), expect.render, `${scenario}: render on a`);
  }
  if (expect.render_on) {
    for (const [name, text] of Object.entries(expect.render_on)) {
      assert.equal(world.replicas.get(name).render(), text, `${scenario}: render on ${name}`);
    }
  }
  if (typeof expect.live_nodes === "number") {
    assert.equal(world.replicas.get("a").liveNodeCount(), expect.live_nodes, `${scenario}: live_nodes`);
  }
  if (Array.isArray(expect.converged)) {
    const first = world.replicas.get(expect.converged[0]).render();
    for (const name of expect.converged.slice(1)) {
      assert.equal(world.replicas.get(name).render(), first, `${scenario}: ${expect.converged[0]}/${name} converge`);
    }
  }
}

function runFixture(name) {
  const fixture = loadFixture(name);
  fixture.scenarios.forEach((scenario, i) => {
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

// -- Wire schema compliance: emitted TreeUpdate validates against the schema ---

const schemaDir = join(here, "..", "..", "lazily-spec", "schemas");
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
