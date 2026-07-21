import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "../src/reactive.js";

test("Cell + computed: lazy slot computes on first read and recomputes after a cell change", () => {
  const ctx = new Context();
  const a = ctx.source(2);
  const b = ctx.source(3);
  const sum = ctx.computed(() => ctx.get(a) + ctx.get(b));
  assert.equal(ctx.get(sum), 5);
  ctx.set(a, 10);
  assert.equal(ctx.get(sum), 13);
});

test("Cell == guard: setting an equal value is a no-op (no invalidation)", () => {
  const ctx = new Context();
  const a = ctx.source(1);
  let runs = 0;
  const doubler = ctx.computed(() => {
    runs++;
    return ctx.get(a) * 2;
  });
  ctx.get(doubler); // prime
  assert.equal(runs, 1);
  ctx.set(a, 1); // equal -> no-op
  assert.equal(ctx.get(doubler), 2);
  assert.equal(runs, 1); // did NOT recompute
  ctx.set(a, 2); // real change
  assert.equal(ctx.get(doubler), 4);
  assert.equal(runs, 2);
});

test("computed: an equal recompute suppresses downstream invalidation (guarded)", () => {
  const ctx = new Context();
  const a = ctx.source(1);
  // memo always returns 0 regardless of input — downstream must not re-run.
  const constant = ctx.computed(() => {
    ctx.get(a); // subscribe
    return 0;
  });
  let downstreamRuns = 0;
  const downstream = ctx.computed(() => {
    ctx.get(constant);
    return ++downstreamRuns;
  });
  assert.equal(ctx.get(downstream), 1);
  ctx.set(a, 99); // a changes, constant recomputes but stays 0 (memo guard)
  assert.equal(ctx.get(downstream), 1); // downstream did NOT re-run
});

test("Signal is eager: materialized before setCell/batch returns", () => {
  const ctx = new Context();
  const a = ctx.source(2);
  const parity = ctx.signal(() => (ctx.get(a) % 2 === 0 ? "even" : "odd"));
  assert.equal(ctx.getSignal(parity), "even");
  ctx.set(a, 11);
  assert.equal(ctx.getSignal(parity), "odd"); // already updated
});

test("Effect reruns on tracked dependency change; cleanup runs before rerun and on dispose", () => {
  const ctx = new Context();
  const a = ctx.source(1);
  const log = [];
  const handle = ctx.effect(() => {
    const v = ctx.get(a);
    log.push(`body:${v}`);
    return () => log.push("cleanup");
  });
  assert.deepEqual(log, ["body:1"]); // ran once on registration
  ctx.set(a, 2);
  assert.deepEqual(log, ["body:1", "cleanup", "body:2"]); // cleanup before rerun
  ctx.disposeEffect(handle);
  assert.deepEqual(log, ["body:1", "cleanup", "body:2", "cleanup"]); // cleanup on dispose
});

test("batch coalesces multiple writes into one effect flush", () => {
  const ctx = new Context();
  const a = ctx.source(1);
  const b = ctx.source(1);
  let effectRuns = 0;
  ctx.effect(() => {
    ctx.get(a);
    ctx.get(b);
    effectRuns++;
    return null;
  });
  assert.equal(effectRuns, 1);
  ctx.batch(() => {
    ctx.set(a, 2);
    ctx.set(b, 2);
    ctx.set(a, 3);
  });
  assert.equal(effectRuns, 2); // flushed once at batch exit, not three times
});

test("glitch-free: a slot observes consistent inputs during refresh", () => {
  const ctx = new Context();
  const a = ctx.source(10);
  const b = ctx.computed(() => ctx.get(a) + 1); // b = a + 1
  const sumEq = ctx.computed(() => ctx.get(a) + ctx.get(b) === 2 * ctx.get(a) + 1);
  assert.equal(ctx.get(sumEq), true);
  ctx.set(a, 50);
  assert.equal(ctx.get(sumEq), true); // still consistent after recompute
});

test("cycle detection throws", () => {
  const ctx = new Context();
  const slot = ctx.computed(() => ctx.get(slot)); // self-reference
  assert.throws(() => ctx.get(slot), /circular dependency/);
});

test("dynamic dependencies: a slot that reads a different branch on rerun updates its edges", () => {
  const ctx = new Context();
  const flag = ctx.source(true);
  const a = ctx.source(1);
  const b = ctx.source(100);
  const cond = ctx.computed(() => (ctx.get(flag) ? ctx.get(a) : ctx.get(b)));
  assert.equal(ctx.get(cond), 1);
  ctx.set(b, 999); // cond doesn't read b yet -> stays cached
  assert.equal(ctx.get(cond), 1);
  ctx.set(flag, false); // now reads b
  assert.equal(ctx.get(cond), 999);
  ctx.set(a, 2); // cond no longer reads a -> must NOT recompute
  // Reading cond should still be 999 (a is no longer a dependency).
  assert.equal(ctx.get(cond), 999);
});

test("isSet reports cached freshness", () => {
  const ctx = new Context();
  const a = ctx.source(1);
  const s = ctx.computed(() => ctx.get(a) + 1);
  assert.equal(ctx.isSet(s), false); // never read
  ctx.get(s);
  assert.equal(ctx.isSet(s), true);
  ctx.set(a, 5); // invalidates
  assert.equal(ctx.isSet(s), false);
  ctx.get(s);
  assert.equal(ctx.isSet(s), true);
});

test("Uint8Array values use structural equality in the == guard", () => {
  const ctx = new Context();
  const a = ctx.source(Uint8Array.of(1, 2, 3));
  let runs = 0;
  const s = ctx.computed(() => {
    runs++;
    return ctx.get(a);
  });
  ctx.get(s);
  ctx.set(a, Uint8Array.of(1, 2, 3)); // equal-by-value -> no-op
  ctx.get(s); // pull (stays cached — no recompute)
  assert.equal(runs, 1);
  ctx.set(a, Uint8Array.of(1, 2, 4)); // different -> recompute
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
    const source = ctx.source(1);
    const subs = [];
    for (let i = 0; i < width; i++) {
      subs.push(ctx.computed(() => ctx.get(source) * 2));
    }
    for (const s of subs) assert.equal(ctx.get(s), 2);
    ctx.set(source, 5);
    for (const s of subs) assert.equal(ctx.get(s), 10, `width ${width}`);
  }
});

test("#lzspecedgeindex: repeated reads of the same dep register exactly one edge", () => {
  // Dedup is the index's job; reading one source many times inside a single
  // compute must still yield a single edge, promoted or not.
  for (const reads of [4, 200]) {
    const ctx = new Context({ instrument: true });
    const a = ctx.source(1);
    const s = ctx.computed(() => {
      let acc = 0;
      for (let i = 0; i < reads; i++) acc += ctx.get(a);
      return acc;
    });
    ctx.get(s);
    const snap = ctx.instrumentationSnapshot();
    // One edge a->s, plus one edge for the slot's own dependency list.
    assert.equal(snap.dependencyEdgesAdded, 1, `reads=${reads}`);
  }
});

test("#lzspecedgeindex: disposal invalidates surviving readers", () => {
  // Detaching the edge is not enough -- a reader that still names a disposed
  // node must recompute (and error) rather than serve the value it cached
  // before the disposal, forever. Without the dirty mark the reader is frozen
  // permanently: its dependency edge is gone, so not even a later write to the
  // disposed node's own source can move it.
  const ctx = new Context();
  const src = ctx.source(4);
  const derived = ctx.computed(() => ctx.get(src));
  const reader = ctx.computed(() => ctx.get(derived) + 1);
  assert.equal(ctx.get(reader), 5);

  ctx.disposeSlot(derived);
  assert.throws(() => ctx.get(derived), "a direct read of a disposed node still errors");
  assert.throws(() => ctx.get(reader), "reader must not serve its pre-disposal cache");

  // ... and a later publish on the surviving source must not revive it.
  ctx.set(src, 99);
  assert.throws(() => ctx.get(reader), "a write to the live source must not revive the reader");
});

test("#lzspecedgeindex: disposal does not run effects during teardown", () => {
  // Disposal is not a publish. The invalidation walk marks the dependent cone
  // dirty but deliberately does NOT schedule the effects it reaches: running one
  // here would re-enter a compute that reads the node being torn down, turning
  // `dispose` itself into a throw and breaking teardown idempotence.
  const ctx = new Context();
  const src = ctx.source(1);
  const derived = ctx.computed(() => ctx.get(src));
  let runs = 0;
  ctx.effect(() => {
    runs += 1;
    return ctx.get(derived);
  });
  const afterSetup = runs;

  ctx.disposeSlot(derived); // must not throw, and must not run the effect
  assert.equal(runs, afterSetup, "disposal must not schedule the effects it invalidates");
  ctx.disposeSlot(derived); // idempotent
  assert.equal(runs, afterSetup);
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
  const wide = ctx.source(0);
  const subs = [];
  // Push `wide` well past the promote threshold so it definitely has an index.
  for (let i = 0; i < 400; i++) {
    const s = ctx.computed(() => ctx.get(wide) + 1);
    ctx.get(s);
    subs.push(s);
  }

  ctx.disposeCell(wide); // (1) strands a full index on the recycled id
  const fresh = ctx.source(10); // (2) pops that id
  ctx.disposeSlot(subs[399]); // (3) frees an id the stale index has a key for
  const revived = ctx.computed(() => ctx.get(fresh) * 3);

  assert.equal(ctx.get(revived), 30);
  ctx.set(fresh, 20);
  // Reads 60 with the index dropped on teardown; reads a stale 30 without it.
  assert.equal(ctx.get(revived), 60);

  // The surviving original subscribers must be unaffected by the recycling:
  // whatever they read, they must all read the SAME thing, since they are
  // identical memos over one source. A stale index would corrupt some subset of
  // their edge sets and split this set.
  //
  // They no longer answer `1` (the value cached before `wide` was disposed).
  // Disposing a node dirties the cone that read it, so each memo recomputes
  // rather than serving its pre-disposal cache -- see `read_after_dispose_is_an_
  // error.json` and `invalidateDisposedDependents` in `reactive.js`. This
  // assertion asserted `1` while that dirty mark was missing.
  //
  // The recompute reads through the now-stale `wide` handle, whose id has been
  // recycled into `fresh` (both are id 1 here), so it observes `fresh` and
  // yields 20 + 1. That is a use-after-dispose through a stale handle, and it is
  // a wrong number rather than an error ONLY because the id was immediately
  // reoccupied by a live cell of the same kind -- step (2) of this test's setup
  // arranges exactly that. Held here as the observed behaviour, not as a
  // desirable one; the fixture's contract covers the un-recycled case, where the
  // id reads back as KIND_NONE and the recompute throws.
  const surviving = new Set();
  for (let i = 0; i < 399; i++) {
    surviving.add(ctx.get(subs[i]));
  }
  assert.deepEqual(
    [...surviving],
    [21],
    "surviving subscribers must agree — a split means the recycled index corrupted a subset",
  );
});

test("#lzspecedgeindex: dynamic dependencies stay exact on a promoted list", () => {
  // A promoted list must track removals as precisely as the linear scan did:
  // a slot that stops reading a source must stop being invalidated by it.
  const ctx = new Context();
  const toggle = ctx.source(true);
  const a = ctx.source(1);
  const b = ctx.source(100);
  // Pad `a` past the promote threshold so its dependents list is indexed.
  const pad = [];
  for (let i = 0; i < 300; i++) {
    const s = ctx.computed(() => ctx.get(a));
    ctx.get(s);
    pad.push(s);
  }
  const swing = ctx.computed(() => (ctx.get(toggle) ? ctx.get(a) : ctx.get(b)));
  assert.equal(ctx.get(swing), 1);
  // Swing off `a` and onto `b`.
  ctx.set(toggle, false);
  assert.equal(ctx.get(swing), 100);
  // `a` no longer feeds `swing`: changing it must not change the value.
  ctx.set(a, 7);
  assert.equal(ctx.get(swing), 100);
  // ...but the padded subscribers still track `a`.
  for (const s of pad) assert.equal(ctx.get(s), 7);
  // Swing back onto `a` and confirm the edge is re-registered.
  ctx.set(toggle, true);
  assert.equal(ctx.get(swing), 7);
  ctx.set(a, 9);
  assert.equal(ctx.get(swing), 9);
});

test("#lzspecedgeindex: effects on a promoted source fire exactly once per publish", () => {
  const ctx = new Context();
  const source = ctx.source(0);
  let runs = 0;
  const effects = [];
  for (let i = 0; i < 300; i++) {
    effects.push(
      ctx.effect(() => {
        ctx.get(source);
        runs++;
        return null;
      }),
    );
  }
  assert.equal(runs, 300); // initial run
  ctx.set(source, 1);
  assert.equal(runs, 600); // one rerun each, no duplicates from the index
  // Disposing half must leave the other half exactly intact.
  for (let i = 0; i < 150; i++) ctx.disposeEffect(effects[i]);
  ctx.set(source, 2);
  assert.equal(runs, 750);
});

test("#lzspecedgeindex: an effect disposed mid-flush does not run, and the queue slot is skipped", () => {
  // `disposeEffect` drops a scheduled effect by tombstoning it in
  // `scheduledEffects` rather than splicing it out of `pendingEffects` (the
  // splice was O(pending) per dispose, quadratic for a cohort torn down from
  // inside an effect body). The tombstone must actually suppress the run.
  //
  // Flush order is reverse-registration, so the disposer is created LAST in
  // order to run FIRST — while every victim is still queued behind it.
  const ctx = new Context();
  const source = ctx.source(0);
  const victimRuns = [];
  const victims = [];
  for (let i = 0; i < 200; i++) {
    const n = i;
    victims.push(
      ctx.effect(() => {
        victimRuns.push(n);
        ctx.get(source);
      }),
    );
  }
  let armed = false;
  ctx.effect(() => {
    ctx.get(source);
    if (!armed) return;
    for (const v of victims) ctx.disposeEffect(v);
  });
  armed = true;

  victimRuns.length = 0;
  ctx.set(source, 1);
  assert.deepEqual(victimRuns, [], "victims disposed mid-flush must not run");
  for (const v of victims) assert.equal(ctx.isEffectActive(v), false);

  // A later publish must not resurrect them either.
  ctx.set(source, 2);
  assert.deepEqual(victimRuns, []);
});

test("#lzspecedgeindex: an id recycled mid-flush runs exactly once", () => {
  // Disposing an effect returns its id to `freeIds` while a stale queue slot may
  // still reference it. If a new effect claims that id in the same flush, the
  // stale slot is reached first and runs the new effect early, and the fresh
  // slot is then skipped. Either way: exactly one run, never zero, never two.
  const ctx = new Context();
  const source = ctx.source(0);
  const victims = [];
  for (let i = 0; i < 50; i++) {
    victims.push(ctx.effect(() => ctx.get(source)));
  }
  let recycledRuns = 0;
  let armed = false;
  ctx.effect(() => {
    ctx.get(source);
    if (!armed) return;
    armed = false;
    for (const v of victims) ctx.disposeEffect(v);
    // Claim the just-freed ids from inside the same flush.
    for (let i = 0; i < 50; i++) {
      ctx.effect(() => {
        recycledRuns++;
        ctx.get(source);
      });
    }
  });
  armed = true;

  ctx.set(source, 1);
  assert.equal(recycledRuns, 50, "each recycled effect runs exactly once");
});

// -- Cell kernel (#lzcellkernel) ---------------------------------------------

test("kernel: source exposes set/merge, computed does not (read/write split by method presence)", () => {
  const ctx = new Context();
  const n = ctx.source(1);
  const f = ctx.computed(() => n.get() * 2);
  assert.equal(typeof n.set, "function");
  assert.equal(typeof n.merge, "function");
  // The write/protection is expressed as method ABSENCE on the formula object.
  assert.equal(typeof f.set, "undefined");
  assert.equal(typeof f.merge, "undefined");
  assert.equal(f.get(), 2);
  n.set(5);
  assert.equal(f.get(), 10);
});

test("kernel: computed is guarded by default (equal recompute suppresses downstream)", () => {
  const ctx = new Context();
  const a = ctx.source(2);
  let downstream = 0;
  const parity = ctx.computed(() => a.get() % 2);
  const dep = ctx.computed(() => {
    downstream++;
    return parity.get();
  });
  dep.get();
  assert.equal(downstream, 1);
  a.set(4); // parity unchanged (0) -> guarded, no downstream recompute
  dep.get();
  assert.equal(downstream, 1, "guarded formula suppresses an equal recompute");
});

test("kernel: computed().eager() is idempotent, eager, and returns the same handle", () => {
  const ctx = new Context();
  const n = ctx.source(1);
  let computes = 0;
  const f = ctx.computed(() => {
    computes++;
    return n.get() * 2;
  });
  const g = f.eager();
  assert.equal(g, f, "drive returns the same handle");
  assert.ok(f.isEager());
  const after = computes;
  f.eager(); // idempotent no-op
  assert.equal(computes, after, "a second drive attaches no second puller");
  const c0 = computes;
  n.set(9); // eager: recomputes without a read
  assert.ok(computes > c0, "a driven formula recomputes eagerly on upstream change");
  assert.equal(f.get(), 18);
});

test("kernel: disposing an eager computed tears down its puller; lazy() reverts to lazy", () => {
  const ctx = new Context();
  const n = ctx.source(1);
  const f = ctx.computed(() => n.get() + 1).eager();
  assert.ok(f.isEager());
  f.lazy();
  assert.ok(!f.isEager());
  const f2 = ctx.computed(() => n.get() + 1).eager();
  f2.dispose();
  assert.ok(ctx.isNodeDisposed(f2), "disposed driven formula frees its node");
  // A surviving write must not throw through a stranded puller.
  n.set(7);
});

test("kernel: source(v, policy) folds under the policy (Source subsumes MergeCell)", () => {
  const ctx = new Context();
  const Sum = { name: "Sum", merge: (o, x) => o + x };
  const acc = ctx.source(0, Sum);
  acc.merge(3);
  acc.merge(4);
  assert.equal(acc.get(), 7);
  acc.set(0); // set is a plain replace, bypassing the policy
  assert.equal(acc.get(), 0);
});
