// `Context.computedRippleWhen` (#lzcellkernel) — a guarded computed with an
// explicit, PURE change predicate (`true` = propagate). Mirrors lazily-rs
// tests/computed_ripple_when.rs. Covers the two motivating shapes: a custom
// significance policy (a bucket proxy), and "propagate every N" where the
// increment evidence lives in the value (so the predicate stays pure).
// `computed(f)` == `computedRippleWhen(f, (o, n) => o !== n)` for primitives;
// pass-through (always propagate) == `computedRippleWhen(f, () => true)`.
//
// NB divergence from rs: in lazily-js v2 the deprecated `slot` alias is a GUARDED
// `computed` (there is no unguarded mode), so the pass-through construction here
// is the `() => true` predicate, not `ctx.slot(f)`.

import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "../src/reactive.js";

test("computedRippleWhen: custom significance propagates only on proxy (bucket) change", () => {
  const ctx = new Context();
  const input = ctx.source(0);

  // Derived value carries a `bucket` proxy; propagate only when the bucket
  // changes, ignoring the raw payload.
  const derived = ctx.computedRippleWhen(
    (cx) => {
      const v = cx.get(input);
      return [v, Math.floor(v / 10)]; // [payload, bucket]
    },
    (old, next) => old[1] !== next[1], // propagate when bucket changed
  );

  let recomputes = 0;
  const observer = ctx.computed((cx) => {
    recomputes++;
    return cx.get(derived)[0];
  });

  assert.equal(ctx.get(observer), 0);
  const base = recomputes;

  // Same bucket (0..9): dependent stays cached.
  ctx.set(input, 3);
  assert.equal(ctx.get(observer), 0, "suppressed: proxy bucket unchanged");
  assert.equal(recomputes, base, "no dependent recompute within a bucket");

  // Crossing a bucket boundary propagates.
  ctx.set(input, 12);
  assert.equal(ctx.get(observer), 12, "propagated: bucket changed");
  assert.equal(recomputes, base + 1);
});

test("computedRippleWhen: propagate-every-N via a value-carried counter", () => {
  const ctx = new Context();
  const input = ctx.source(0);

  // "Propagate every 3rd increment" — the evidence (the counter) is IN the
  // value, so the predicate is a pure function of (old, new): propagate only
  // when the count crosses a size-3 window boundary.
  const sampled = ctx.computedRippleWhen(
    (cx) => cx.get(input),
    (old, next) => Math.floor(next / 3) !== Math.floor(old / 3),
  );

  let seen = 0;
  const observer = ctx.computed((cx) => {
    seen++;
    return cx.get(sampled);
  });

  assert.equal(ctx.get(observer), 0);
  const base = seen;

  // 0 -> 1 -> 2 stay in window [0,3): suppressed.
  ctx.set(input, 1);
  ctx.set(input, 2);
  assert.equal(ctx.get(observer), 0);
  assert.equal(seen, base, "window not crossed yet");

  // 3 crosses into [3,6): propagate.
  ctx.set(input, 3);
  assert.equal(ctx.get(observer), 3);
  assert.equal(seen, base + 1);
});

test("computed(f) matches computedRippleWhen(f, (o, n) => o !== n)", () => {
  const ctx = new Context();
  const input = ctx.source(0);

  const viaComputed = ctx.computed((cx) => Math.min(cx.get(input), 1));
  const viaWhen = ctx.computedRippleWhen(
    (cx) => Math.min(cx.get(input), 1),
    (o, n) => o !== n,
  );

  let ca = 0;
  let cb = 0;
  const obsA = ctx.computed((cx) => {
    ca++;
    return cx.get(viaComputed);
  });
  const obsB = ctx.computed((cx) => {
    cb++;
    return cx.get(viaWhen);
  });
  assert.equal(ctx.get(obsA), 0);
  assert.equal(ctx.get(obsB), 0);
  const baseA = ca;
  const baseB = cb;

  // 0 -> 5 both clamp to 1: both guards suppress identically.
  ctx.set(input, 5);
  assert.equal(ctx.get(obsA), 1);
  assert.equal(ctx.get(obsB), 1);
  assert.equal(ca, baseA + 1);
  assert.equal(cb, baseB + 1);

  // 5 -> 9 both stay 1: both suppress the dependent.
  ctx.set(input, 9);
  assert.equal(ctx.get(obsA), 1);
  assert.equal(ctx.get(obsB), 1);
  assert.equal(ca, baseA + 1, "computed suppressed equal recompute");
  assert.equal(cb, baseB + 1, "computedRippleWhen(!==) matches computed");
});

test("pass-through computedRippleWhen(() => true) always propagates", () => {
  const ctx = new Context();
  const input = ctx.source(0);

  // `() => true` installs a guard that never suppresses: even an equal recompute
  // propagates (the v2 pass-through construction; the deprecated `slot` alias is
  // guarded and would NOT re-fire here).
  const passthrough = ctx.computedRippleWhen(
    (cx) => {
      cx.get(input); // depend on input, but always yield the same value
      return 0;
    },
    () => true,
  );

  let recomputes = 0;
  const observer = ctx.computed((cx) => {
    recomputes++;
    return cx.get(passthrough);
  });

  assert.equal(ctx.get(observer), 0);
  const base = recomputes;

  // Value stays 0, but the pass-through guard never suppresses, so the dependent
  // re-fires.
  ctx.set(input, 5);
  assert.equal(ctx.get(observer), 0);
  assert.ok(
    recomputes > base,
    "pass-through propagates even when the value is unchanged",
  );
});

test("computedRippleWhen guard is cleared on dispose (no stale predicate on a recycled id)", () => {
  const ctx = new Context();
  const input = ctx.source(0);

  // A never-suppress slot, then dispose it so its id returns to the free list.
  const first = ctx.computedRippleWhen((cx) => cx.get(input), () => true);
  assert.equal(ctx.get(first), 0);
  ctx.disposeNode(first);

  // A fresh ordinary computed likely reuses the recycled id; it must guard on the
  // natural equality (suppress an equal recompute), not inherit `() => true`.
  const reused = ctx.computed((cx) => Math.min(cx.get(input), 1));
  let recomputes = 0;
  const observer = ctx.computed((cx) => {
    recomputes++;
    return cx.get(reused);
  });
  assert.equal(ctx.get(observer), 0);
  const base = recomputes;

  ctx.set(input, 5); // 0 -> 1: real change, propagate once
  assert.equal(ctx.get(observer), 1);
  assert.equal(recomputes, base + 1);

  ctx.set(input, 9); // still clamps to 1: natural guard suppresses
  assert.equal(ctx.get(observer), 1);
  assert.equal(recomputes, base + 1, "recycled id uses default guard, not a stale predicate");
});
