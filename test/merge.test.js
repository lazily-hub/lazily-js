import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Context } from "../src/reactive.js";
import {
  KeepLatest,
  Max,
  MergeCell,
  RawFifo,
  SetUnion,
  Sum,
  asSource,
  mergeCell,
} from "../src/merge.js";

// Phase 1 law-tests for the merge algebra (#relaycell). Every policy MUST be
// associative; commutativity/idempotency are asserted per flag. Also proves
// converged-state determinism (the doc §8 mandate for the stackless JS binding)
// by replaying the cross-language mergecell_algebra.json fixture.

const here = dirname(fileURLToPath(import.meta.url));
const specCollections = join(here, "..", "..", "lazily-spec", "conformance", "collections");

const POLICIES = [KeepLatest, Sum, Max, SetUnion, RawFifo];

function sampleValues(policy) {
  switch (policy.name) {
    case "SetUnion":
      return [new Set([1, 2]), new Set([2, 3]), new Set([3, 4])];
    case "RawFifo":
      return [[1], [2], [3]];
    default:
      return [5, -3, 8];
  }
}

function eq(a, b) {
  if (a instanceof Set && b instanceof Set) {
    return a.size === b.size && [...a].every((x) => b.has(x));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }
  return a === b;
}

test("every policy is associative: (a⊕b)⊕c == a⊕(b⊕c)", () => {
  for (const p of POLICIES) {
    const [a, b, c] = sampleValues(p);
    const left = p.merge(p.merge(a, b), c);
    const right = p.merge(a, p.merge(b, c));
    assert.ok(eq(left, right), `${p.name} associativity`);
  }
});

test("commutativity holds exactly when the flag is set", () => {
  for (const p of POLICIES) {
    const [a, b, c] = sampleValues(p);
    const left = p.merge(p.merge(a, b), c);
    const right = p.merge(p.merge(a, c), b);
    if (p.commutative) {
      assert.ok(eq(left, right), `${p.name} should be commutative`);
    }
  }
  // Honesty: cleared flags exhibit a counterexample.
  assert.ok(!eq(KeepLatest.merge(KeepLatest.merge(0, 1), 2), KeepLatest.merge(KeepLatest.merge(0, 2), 1)));
  assert.ok(!eq(RawFifo.merge([1], [2]), RawFifo.merge([2], [1])));
});

test("idempotency holds exactly when the flag is set: (a⊕b)⊕b == a⊕b", () => {
  for (const p of POLICIES) {
    const [a, b] = sampleValues(p);
    if (p.idempotent) {
      assert.ok(eq(p.merge(p.merge(a, b), b), p.merge(a, b)), `${p.name} should be idempotent`);
    }
  }
  // Honesty: Sum and RawFifo are not idempotent.
  assert.ok(!eq(Sum.merge(Sum.merge(0, 5), 5), Sum.merge(0, 5)));
  assert.ok(!eq(RawFifo.merge(RawFifo.merge([], [1]), [1]), RawFifo.merge([], [1])));
});

test("Cell ≡ MergeCell(KeepLatest): merge replaces, equal writes no-op", () => {
  const ctx = new Context();
  const cell = ctx.source(0);
  const mc = mergeCell(ctx, 0, KeepLatest);
  for (const v of [3, 3, 7, 7, 1]) {
    ctx.set(cell, v);
    mc.merge(v);
    assert.equal(ctx.get(cell), mc.get());
  }
  assert.equal(mc.get(), 1);
});

test("Sum MergeCell accumulates; converged state independent of op order", () => {
  const ctx = new Context();
  const ops = [5, -3, 8, 2, -1];
  const a = mergeCell(ctx, 0, Sum);
  for (const d of ops) a.merge(d);
  const b = mergeCell(ctx, 0, Sum);
  for (const d of [...ops].reverse()) b.merge(d);
  assert.equal(a.get(), b.get());
  assert.equal(a.get(), 11);
});

test("idempotent merge no-ops via the == store-guard (no effect rerun)", () => {
  const ctx = new Context();
  const mc = mergeCell(ctx, 10, Max);
  let runs = 0;
  ctx.effect(() => {
    mc.get();
    runs += 1;
  });
  assert.equal(runs, 1);
  mc.merge(5);
  mc.merge(10);
  mc.merge(0);
  assert.equal(runs, 1, "merges at/below max must not rerun the effect");
  mc.merge(42);
  assert.equal(mc.get(), 42);
  assert.equal(runs, 2);
});

test("asSource adapts a plain cell to the Source shape (merge == replace)", () => {
  const ctx = new Context();
  const src = asSource(ctx, ctx.source(0));
  src.set(1);
  src.merge(2); // KeepLatest replace
  assert.equal(src.get(), 2);
});

test("mergecell_algebra.json fixture: cross-language converged determinism", (t) => {
  const path = join(specCollections, "mergecell_algebra.json");
  if (!existsSync(path)) {
    t.skip("lazily-spec fixture not present as sibling");
    return;
  }
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  const byName = { KeepLatest, Sum, Max };
  let seen = 0;
  for (const scenario of fixture.scenarios) {
    const policy = byName[scenario.policy];
    assert.ok(policy, `unknown policy ${scenario.policy}`);
    // Flags match the fixture.
    assert.equal(policy.commutative, scenario.flags.commutative, `${policy.name} commutative`);
    assert.equal(policy.idempotent, scenario.flags.idempotent, `${policy.name} idempotent`);

    const ctx = new Context();
    const mc = mergeCell(ctx, scenario.initial, policy);
    let runs = 0;
    ctx.effect(() => {
      mc.get();
      runs += 1;
    });
    let prev = runs;
    for (const step of scenario.steps) {
      const before = runs;
      mc.merge(step.merge);
      const fired = runs > before;
      assert.equal(mc.get(), step.expected.value, `${policy.name} value`);
      assert.equal(fired, step.expected.invalidates, `${policy.name} invalidates`);
      prev = runs;
    }
    void prev;
    seen += 1;
  }
  assert.equal(seen, 3);
});

test("MergeCell is a distinct handle type", () => {
  const ctx = new Context();
  assert.ok(mergeCell(ctx, 0, Sum) instanceof MergeCell);
});
