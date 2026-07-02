import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Context } from "../src/reactive.js";
import { SemTree } from "../src/sem-tree.js";

const here = dirname(fileURLToPath(import.meta.url));
const specCollections = join(here, "..", "..", "lazily-spec", "conformance", "collections");

function loadFixture(name) {
  const path = join(specCollections, name);
  assert.ok(existsSync(path), `missing spec fixture ${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

const FOLDS = {
  sum: (v, kids) => v + kids.reduce((a, b) => a + b, 0),
  count_positive: (v, kids) => (v > 0 ? 1 : 0) + kids.reduce((a, b) => a + b, 0),
};

function sumTree(ctx) {
  return new SemTree(
    ctx,
    {
      id: "root", value: 0,
      children: {
        order: ["a", "b"],
        values: {
          a: { id: "a", value: 1, children: { order: ["a1", "a2"], values: { a1: { id: "a1", value: 10 }, a2: { id: "a2", value: 20 } } } },
          b: { id: "b", value: 2, children: { order: ["b1"], values: { b1: { id: "b1", value: 100 } } } },
        },
      },
    },
    FOLDS.sum,
  );
}

test("folds whole subtree", () => {
  const ctx = new Context();
  const t = sumTree(ctx);
  assert.equal(t.value(), 133);
  assert.equal(t.nodeValue("a"), 31);
  assert.equal(t.nodeValue("b"), 102);
});

test("edit recomputes only ancestor chain, not siblings", () => {
  const ctx = new Context();
  const t = sumTree(ctx);
  t.value(); // prime all slots
  assert.equal(t.isCached("a"), true);
  t.setValue("b1", 200);
  assert.equal(t.value(), 233);
  assert.equal(t.nodeValue("b"), 202);
  assert.equal(t.nodeValue("a"), 31); // unchanged
  assert.equal(t.isCached("a"), true); // sibling subtree did NOT recompute
});

test("memo guard: an edit that does not change the folded count does not re-run downstream", () => {
  const ctx = new Context();
  const t = new SemTree(
    ctx,
    {
      id: "root", value: 0,
      children: {
        order: ["a", "b"],
        values: {
          a: { id: "a", value: -1 },
          b: { id: "b", value: 7 },
        },
      },
    },
    FOLDS.count_positive,
  );
  let downstreamRuns = 0;
  const downstream = ctx.computed(() => {
    t.rootHandle();
    ctx.get(t.rootHandle());
    return ++downstreamRuns;
  });
  ctx.get(downstream); // prime -> root count = 1 (only b is positive)
  assert.equal(t.value(), 1);
  t.setValue("b", 9); // still positive -> count unchanged
  assert.equal(t.value(), 1);
  ctx.get(downstream); // pull; memo guard should have suppressed
  assert.equal(downstreamRuns, 1); // downstream did NOT re-run
});

test("removal updates derivation (dropped subtree)", () => {
  const ctx = new Context();
  const t = sumTree(ctx);
  assert.equal(t.value(), 133);
  t.removeChild("root", "b");
  assert.equal(t.value(), 31);
});

// -- conformance fixture replay ----------------------------------------------

test("conformance: semtree_incremental.json", () => {
  const fixture = loadFixture("semtree_incremental.json");
  for (const scenario of fixture.scenarios) {
    const ctx = new Context();
    const fold = FOLDS[scenario.fold];
    assert.ok(fold, `unknown fold ${scenario.fold}`);
    const t = new SemTree(ctx, scenario.tree, fold);

    for (const [id, v] of Object.entries(scenario.expect_initial)) {
      if (id === "root") {
        assert.equal(t.value(), v, `${scenario.name}: initial root`);
      } else {
        assert.equal(t.nodeValue(id), v, `${scenario.name}: initial ${id}`);
      }
    }

    // Attach a downstream consumer if the scenario checks the memo guard.
    let downstreamRuns = 0;
    if (scenario.expect_after.downstream_consumer_reran !== undefined) {
      const downstream = ctx.computed(() => {
        ctx.get(t.rootHandle());
        return ++downstreamRuns;
      });
      ctx.get(downstream); // prime
    }

    if (scenario.edit) {
      t.setValue(scenario.edit.id, scenario.edit.value);
    }
    if (scenario.remove_child) {
      t.removeChild(scenario.remove_child.parent, scenario.remove_child.child);
    }

    const after = scenario.expect_after;
    if (after.root !== undefined) assert.equal(t.value(), after.root, scenario.name);
    for (const key of Object.keys(after)) {
      if (key.startsWith("node_")) {
        const id = key.slice(5);
        assert.equal(t.nodeValue(id), after[key], `${scenario.name}: ${id}`);
      }
    }
    if (after.sibling_a_cached !== undefined) {
      assert.equal(t.isCached("a"), after.sibling_a_cached, scenario.name);
    }
    if (after.downstream_consumer_reran !== undefined) {
      assert.equal(downstreamRuns > 1, after.downstream_consumer_reran, scenario.name);
    }
  }
});
