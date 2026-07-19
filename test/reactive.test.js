import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "../src/reactive.js";

test("Cell + computed: lazy slot computes on first read and recomputes after a cell change", () => {
  const ctx = new Context();
  const a = ctx.cell(2);
  const b = ctx.cell(3);
  const sum = ctx.slot(() => ctx.getCell(a) + ctx.getCell(b));
  assert.equal(ctx.get(sum), 5);
  ctx.setCell(a, 10);
  assert.equal(ctx.get(sum), 13);
});

test("Cell == guard: setting an equal value is a no-op (no invalidation)", () => {
  const ctx = new Context();
  const a = ctx.cell(1);
  let runs = 0;
  const doubler = ctx.slot(() => {
    runs++;
    return ctx.getCell(a) * 2;
  });
  ctx.get(doubler); // prime
  assert.equal(runs, 1);
  ctx.setCell(a, 1); // equal -> no-op
  assert.equal(ctx.get(doubler), 2);
  assert.equal(runs, 1); // did NOT recompute
  ctx.setCell(a, 2); // real change
  assert.equal(ctx.get(doubler), 4);
  assert.equal(runs, 2);
});

test("memo: an equal recompute suppresses downstream invalidation", () => {
  const ctx = new Context();
  const a = ctx.cell(1);
  // memo always returns 0 regardless of input — downstream must not re-run.
  const constant = ctx.memo(() => {
    ctx.getCell(a); // subscribe
    return 0;
  });
  let downstreamRuns = 0;
  const downstream = ctx.computed(() => {
    ctx.get(constant);
    return ++downstreamRuns;
  });
  assert.equal(ctx.get(downstream), 1);
  ctx.setCell(a, 99); // a changes, constant recomputes but stays 0 (memo guard)
  assert.equal(ctx.get(downstream), 1); // downstream did NOT re-run
});

test("Signal is eager: materialized before setCell/batch returns", () => {
  const ctx = new Context();
  const a = ctx.cell(2);
  const parity = ctx.signal(() => (ctx.getCell(a) % 2 === 0 ? "even" : "odd"));
  assert.equal(ctx.getSignal(parity), "even");
  ctx.setCell(a, 11);
  assert.equal(ctx.getSignal(parity), "odd"); // already updated
});

test("Effect reruns on tracked dependency change; cleanup runs before rerun and on dispose", () => {
  const ctx = new Context();
  const a = ctx.cell(1);
  const log = [];
  const handle = ctx.effect(() => {
    const v = ctx.getCell(a);
    log.push(`body:${v}`);
    return () => log.push("cleanup");
  });
  assert.deepEqual(log, ["body:1"]); // ran once on registration
  ctx.setCell(a, 2);
  assert.deepEqual(log, ["body:1", "cleanup", "body:2"]); // cleanup before rerun
  ctx.disposeEffect(handle);
  assert.deepEqual(log, ["body:1", "cleanup", "body:2", "cleanup"]); // cleanup on dispose
});

test("batch coalesces multiple writes into one effect flush", () => {
  const ctx = new Context();
  const a = ctx.cell(1);
  const b = ctx.cell(1);
  let effectRuns = 0;
  ctx.effect(() => {
    ctx.getCell(a);
    ctx.getCell(b);
    effectRuns++;
    return null;
  });
  assert.equal(effectRuns, 1);
  ctx.batch(() => {
    ctx.setCell(a, 2);
    ctx.setCell(b, 2);
    ctx.setCell(a, 3);
  });
  assert.equal(effectRuns, 2); // flushed once at batch exit, not three times
});

test("glitch-free: a slot observes consistent inputs during refresh", () => {
  const ctx = new Context();
  const a = ctx.cell(10);
  const b = ctx.slot(() => ctx.getCell(a) + 1); // b = a + 1
  const sumEq = ctx.slot(() => ctx.getCell(a) + ctx.get(b) === 2 * ctx.getCell(a) + 1);
  assert.equal(ctx.get(sumEq), true);
  ctx.setCell(a, 50);
  assert.equal(ctx.get(sumEq), true); // still consistent after recompute
});

test("cycle detection throws", () => {
  const ctx = new Context();
  const slot = ctx.slot(() => ctx.get(slot)); // self-reference
  assert.throws(() => ctx.get(slot), /circular dependency/);
});

test("dynamic dependencies: a slot that reads a different branch on rerun updates its edges", () => {
  const ctx = new Context();
  const flag = ctx.cell(true);
  const a = ctx.cell(1);
  const b = ctx.cell(100);
  const cond = ctx.slot(() => (ctx.getCell(flag) ? ctx.getCell(a) : ctx.getCell(b)));
  assert.equal(ctx.get(cond), 1);
  ctx.setCell(b, 999); // cond doesn't read b yet -> stays cached
  assert.equal(ctx.get(cond), 1);
  ctx.setCell(flag, false); // now reads b
  assert.equal(ctx.get(cond), 999);
  ctx.setCell(a, 2); // cond no longer reads a -> must NOT recompute
  // Reading cond should still be 999 (a is no longer a dependency).
  assert.equal(ctx.get(cond), 999);
});

test("isSet reports cached freshness", () => {
  const ctx = new Context();
  const a = ctx.cell(1);
  const s = ctx.slot(() => ctx.getCell(a) + 1);
  assert.equal(ctx.isSet(s), false); // never read
  ctx.get(s);
  assert.equal(ctx.isSet(s), true);
  ctx.setCell(a, 5); // invalidates
  assert.equal(ctx.isSet(s), false);
  ctx.get(s);
  assert.equal(ctx.isSet(s), true);
});

test("Uint8Array values use structural equality in the == guard", () => {
  const ctx = new Context();
  const a = ctx.cell(Uint8Array.of(1, 2, 3));
  let runs = 0;
  const s = ctx.slot(() => {
    runs++;
    return ctx.getCell(a);
  });
  ctx.get(s);
  ctx.setCell(a, Uint8Array.of(1, 2, 3)); // equal-by-value -> no-op
  ctx.get(s); // pull (stays cached — no recompute)
  assert.equal(runs, 1);
  ctx.setCell(a, Uint8Array.of(1, 2, 4)); // different -> recompute
  ctx.get(s); // pull -> recomputes
  assert.equal(runs, 2);
});

// -- Dependency-edge index (#lzspecedgeindex) --------------------------------
//
// These pin the behavior of the hash-index promotion that keeps wide-fan-out
// edge registration amortized O(1). The promote threshold is an internal
// constant (160); these tests straddle it by width rather than importing it, so
// they stay valid if the threshold is re-measured and changed.

test("#lzspecedgeindex: wide fan-out keeps an exact edge set across the promote threshold", () => {
  // Widths chosen to sit below, at, and well above the promote threshold.
  for (const width of [8, 159, 160, 161, 512]) {
    const ctx = new Context();
    const source = ctx.cell(1);
    const subs = [];
    for (let i = 0; i < width; i++) {
      subs.push(ctx.memo(() => ctx.getCell(source) * 2));
    }
    for (const s of subs) assert.equal(ctx.get(s), 2);
    ctx.setCell(source, 5);
    for (const s of subs) assert.equal(ctx.get(s), 10, `width ${width}`);
  }
});

test("#lzspecedgeindex: repeated reads of the same dep register exactly one edge", () => {
  // Dedup is the index's job; reading one source many times inside a single
  // compute must still yield a single edge, promoted or not.
  for (const reads of [4, 200]) {
    const ctx = new Context({ instrument: true });
    const a = ctx.cell(1);
    const s = ctx.slot(() => {
      let acc = 0;
      for (let i = 0; i < reads; i++) acc += ctx.getCell(a);
      return acc;
    });
    ctx.get(s);
    const snap = ctx.instrumentationSnapshot();
    // One edge a->s, plus one edge for the slot's own dependency list.
    assert.equal(snap.dependencyEdgesAdded, 1, `reads=${reads}`);
  }
});

test("#lzspecedgeindex: a recycled id does not inherit a stale edge index", () => {
  // The index is a side table keyed by owner id, and ids are recycled through
  // `freeIds`. If disposal failed to drop the entry, the next node handed that
  // id would alias the previous occupant's index and mis-dedup its edges.
  // Reproducing this needs three things to line up, so the construction is
  // deliberate rather than incidental:
  //
  //  1. the owner is disposed while its dependents list is still FULL, so a
  //     populated index is stranded (disposing the subscribers first would
  //     drain it one entry at a time via removeDependentEdge and hide the bug);
  //  2. the replacement source is allocated IMMEDIATELY, so it pops the owner's
  //     recycled id off the LIFO free list and inherits that index;
  //  3. a new dependent is given an id that is a KEY in the stale index, which
  //     means freeing one of the original subscribers first.
  //
  // Then the stale index reports the new edge as already present, the edge is
  // silently dropped, and the dependent is never invalidated again.
  const ctx = new Context();
  const wide = ctx.cell(0);
  const subs = [];
  // Push `wide` well past the promote threshold so it definitely has an index.
  for (let i = 0; i < 400; i++) {
    const s = ctx.memo(() => ctx.getCell(wide) + 1);
    ctx.get(s);
    subs.push(s);
  }

  ctx.disposeCell(wide); // (1) strands a full index on the recycled id
  const fresh = ctx.cell(10); // (2) pops that id
  ctx.disposeSlot(subs[399]); // (3) frees an id the stale index has a key for
  const revived = ctx.memo(() => ctx.getCell(fresh) * 3);

  assert.equal(ctx.get(revived), 30);
  ctx.setCell(fresh, 20);
  // Reads 60 with the index dropped on teardown; reads a stale 30 without it.
  assert.equal(ctx.get(revived), 60);

  // The surviving original subscribers must be unaffected by the recycling.
  for (let i = 0; i < 399; i++) {
    assert.equal(ctx.get(subs[i]), 1);
  }
});

test("#lzspecedgeindex: dynamic dependencies stay exact on a promoted list", () => {
  // A promoted list must track removals as precisely as the linear scan did:
  // a slot that stops reading a source must stop being invalidated by it.
  const ctx = new Context();
  const toggle = ctx.cell(true);
  const a = ctx.cell(1);
  const b = ctx.cell(100);
  // Pad `a` past the promote threshold so its dependents list is indexed.
  const pad = [];
  for (let i = 0; i < 300; i++) {
    const s = ctx.memo(() => ctx.getCell(a));
    ctx.get(s);
    pad.push(s);
  }
  const swing = ctx.slot(() => (ctx.getCell(toggle) ? ctx.getCell(a) : ctx.getCell(b)));
  assert.equal(ctx.get(swing), 1);
  // Swing off `a` and onto `b`.
  ctx.setCell(toggle, false);
  assert.equal(ctx.get(swing), 100);
  // `a` no longer feeds `swing`: changing it must not change the value.
  ctx.setCell(a, 7);
  assert.equal(ctx.get(swing), 100);
  // ...but the padded subscribers still track `a`.
  for (const s of pad) assert.equal(ctx.get(s), 7);
  // Swing back onto `a` and confirm the edge is re-registered.
  ctx.setCell(toggle, true);
  assert.equal(ctx.get(swing), 7);
  ctx.setCell(a, 9);
  assert.equal(ctx.get(swing), 9);
});

test("#lzspecedgeindex: effects on a promoted source fire exactly once per publish", () => {
  const ctx = new Context();
  const source = ctx.cell(0);
  let runs = 0;
  const effects = [];
  for (let i = 0; i < 300; i++) {
    effects.push(
      ctx.effect(() => {
        ctx.getCell(source);
        runs++;
        return null;
      }),
    );
  }
  assert.equal(runs, 300); // initial run
  ctx.setCell(source, 1);
  assert.equal(runs, 600); // one rerun each, no duplicates from the index
  // Disposing half must leave the other half exactly intact.
  for (let i = 0; i < 150; i++) ctx.disposeEffect(effects[i]);
  ctx.setCell(source, 2);
  assert.equal(runs, 750);
});
