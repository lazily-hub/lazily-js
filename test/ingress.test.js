// The transport-agnostic reactive ingress family (`#designimplementtransport`):
// the admission algebra's invariants, and the reactivity each flavor shell adds
// on top of it.
//
// The canonical corpus is replayed against all three flavors in
// test/ingress-family-conformance.test.js. This file pins the invariants the
// corpus cannot phrase — the ordering of the admission tests, the construction
// gates, and the graph-level obligations (one frontier walk per admission, and
// the negative invalidations measured as EFFECT RERUNS rather than cache flags).
//
// Mirrors the unit-test tails of lazily-rs/src/ingress_core.rs and
// lazily-rs/src/{ingress,thread_safe_ingress,async_ingress}.rs.

import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "../src/reactive.js";
import { ThreadSafeContext } from "../src/thread-safe.js";
import { AsyncContext } from "../src/reactive-async.js";
import { IngressCell } from "../src/ingress.js";
import { ThreadSafeIngressCell } from "../src/thread-safe-ingress.js";
import { AsyncIngressCell } from "../src/async-ingress.js";
import {
  InProcIngress,
  IngressAdmissionKind,
  IngressConfigError,
  IngressCore,
  IngressDropReason,
  IngressError,
  IngressLifecycle,
  IngressReadiness,
  IngressReceiptChannel,
  IngressTransportKind,
  defaultIngressPolicy,
  ingressEnvelope,
  ingressSchedule,
  ingressChangeIsEmpty,
  isDelivered,
} from "../src/ingress-core.js";
import { KeepLatest, RawFifo, Sum } from "../src/merge.js";
import { Overflow } from "../src/relay.js";

const env = (key, generation, sequence, stampedAt, payload) =>
  ingressEnvelope(key, generation, sequence, stampedAt, payload);

function core(overrides = {}, merge = Sum) {
  return new IngressCore(defaultIngressPolicy(overrides), merge);
}

// ---------------------------------------------------------------------------
// construction
// ---------------------------------------------------------------------------

test("ingress core: Conflate is rejected for a non-conflating algebra", () => {
  assert.throws(
    () => new IngressCore(defaultIngressPolicy({ overflow: Overflow.Conflate }), RawFifo),
    (err) => err.message === IngressConfigError.ConflateNotBounding,
  );
});

test("ingress core: a zero receipt capacity is rejected", () => {
  assert.throws(
    () => core({ receiptCapacity: 0 }),
    (err) => err.message === IngressConfigError.ZeroReceiptCapacity,
  );
});

test("ingress shell: a rejected policy mints no reader", () => {
  const ctx = new Context();
  const before = ctx.instrumentationSnapshot?.();
  assert.throws(
    () => new IngressCell(ctx, { policy: { overflow: Overflow.Conflate }, merge: RawFifo }),
    (err) => err.message === IngressConfigError.ConflateNotBounding,
  );
  // The construction gate runs before any graph node is minted, so a rejected
  // policy cannot leave a half-built shell behind.
  assert.equal(before, ctx.instrumentationSnapshot?.());
});

// ---------------------------------------------------------------------------
// the admission algebra
// ---------------------------------------------------------------------------

test("ingress core: in-order delivery conflates and receipts", () => {
  const c = core();
  let out = c.admit(env("a", 1, 0, 0, 5));
  assert.deepEqual(out.admission, { kind: IngressAdmissionKind.Accepted, deliveredThrough: 0 });
  assert.ok(out.change.acceptedReceipts);
  assert.deepEqual(out.change.scopes, [
    ["a", { value: true, readiness: true, authority: true, retry: true }],
  ]);

  out = c.admit(env("a", 1, 1, 0, 7));
  assert.deepEqual(out.admission, { kind: IngressAdmissionKind.Conflated, deliveredThrough: 1 });
  assert.equal(c.peek("a"), 12);
  assert.equal(c.receipts(IngressReceiptChannel.Accepted).length, 2);
  assert.equal(c.receipts(IngressReceiptChannel.Dropped).length, 0);
  assert.ok(isDelivered(out.admission));
});

test("ingress core: reorder buffers then flushes in one invalidation", () => {
  const c = core();
  let out = c.admit(env("a", 1, 2, 0, 4));
  assert.deepEqual(out.admission, { kind: IngressAdmissionKind.Buffered, gapFrom: 0 });
  // A buffered envelope mints no receipt and moves no value. The scope's first
  // appearance DOES move it off `unknown`, and saying so is the difference
  // between a sound invalidation set and a reader stuck on `unknown` forever.
  assert.equal(out.change.acceptedReceipts, false);
  assert.equal(out.change.droppedReceipts, false);
  assert.deepEqual(out.change.scopes, [
    ["a", { value: false, readiness: true, authority: true, retry: false }],
  ]);
  assert.equal(c.peek("a"), null);

  out = c.admit(env("a", 1, 1, 0, 2));
  assert.deepEqual(out.admission, { kind: IngressAdmissionKind.Buffered, gapFrom: 0 });
  // Now the scope exists, so a second buffered envelope really is invisible.
  assert.ok(ingressChangeIsEmpty(out.change));

  out = c.admit(env("a", 1, 0, 0, 1));
  // Three ops coalesced, so the delivery reports Conflated even though the window
  // it started from was empty.
  assert.deepEqual(out.admission, { kind: IngressAdmissionKind.Conflated, deliveredThrough: 2 });
  assert.equal(c.peek("a"), 7);
  assert.equal(c.view("a").buffered, 0);
  // Exactly one accepted receipt for the delivery that unblocked the flush.
  assert.equal(c.receipts(IngressReceiptChannel.Accepted).length, 1);
});

test("ingress core: duplicates drop after delivery and while buffered", () => {
  const c = core();
  c.admit(env("a", 1, 0, 0, 1));
  assert.deepEqual(c.admit(env("a", 1, 0, 0, 1)).admission, {
    kind: IngressAdmissionKind.Dropped,
    reason: IngressDropReason.DuplicateSequence,
  });
  c.admit(env("a", 1, 5, 0, 1));
  assert.deepEqual(c.admit(env("a", 1, 5, 0, 1)).admission, {
    kind: IngressAdmissionKind.Dropped,
    reason: IngressDropReason.DuplicateBuffered,
  });
  assert.equal(c.peek("a"), 1);
});

test("ingress core: the reorder window drops rather than growing", () => {
  const c = core({ reorderWindow: 2 });
  c.admit(env("a", 1, 1, 0, 1));
  c.admit(env("a", 1, 2, 0, 1));
  assert.deepEqual(c.admit(env("a", 1, 3, 0, 1)).admission, {
    kind: IngressAdmissionKind.Dropped,
    reason: IngressDropReason.ReorderWindowOverflow,
  });
  assert.equal(c.view("a").buffered, 2);
});

test("ingress core: a zero reorder window drops every gap immediately", () => {
  const c = core({ reorderWindow: 0 });
  assert.deepEqual(c.admit(env("a", 1, 1, 0, 1)).admission, {
    kind: IngressAdmissionKind.Dropped,
    reason: IngressDropReason.ReorderWindowOverflow,
  });
});

test("ingress core: a stale generation is fenced BEFORE its sequence is consulted", () => {
  const c = core();
  c.admit(env("a", 2, 0, 0, 1));
  // Sequence 0 would be a duplicate; generation 1 is stale. The fence wins, which
  // is what makes a zombie producer distinguishable from a retry.
  assert.deepEqual(c.admit(env("a", 1, 0, 0, 9)).admission, {
    kind: IngressAdmissionKind.Dropped,
    reason: IngressDropReason.StaleGeneration,
  });
  assert.equal(c.peek("a"), 1);
});

test("ingress core: a newer generation hands off and resets the sequence space", () => {
  const c = core();
  c.admit(env("a", 1, 0, 0, 1));
  c.admit(env("a", 1, 7, 0, 1));
  assert.deepEqual(c.admit(env("a", 2, 0, 0, 4)).admission, {
    kind: IngressAdmissionKind.GenerationHandoff,
    from: 1,
    to: 2,
  });
  const view = c.view("a");
  assert.equal(view.generation, 2);
  assert.equal(view.deliveredThrough, 0);
  // The old generation's buffered successor is not replayed under the new fence —
  // its sequence numbers mean something else now.
  assert.equal(view.buffered, 0);
  // Nor is its undrained window folded into the new baseline.
  assert.equal(c.peek("a"), 4);
});

test("ingress core: a handoff that BUFFERS still reports the baseline reset", () => {
  // A newer generation arriving out of order resets the fence, the watermark AND
  // the window before parking the envelope. Reporting that as "buffered, nothing
  // changed" would leave every reader showing the superseded generation forever.
  const c = core();
  c.admit(env("a", 1, 0, 0, 5));
  const out = c.admit(env("a", 2, 3, 0, 9));
  assert.deepEqual(out.admission, { kind: IngressAdmissionKind.Buffered, gapFrom: 0 });
  assert.deepEqual(out.change.scopes, [
    ["a", { value: true, readiness: true, authority: true, retry: false }],
  ]);
  assert.equal(c.peek("a"), null);
  const view = c.view("a");
  assert.equal(view.generation, 2);
  assert.equal(view.deliveredThrough, null);
  assert.equal(view.buffered, 1);
  // A buffered envelope under the SAME generation is still invisible.
  assert.ok(ingressChangeIsEmpty(c.admit(env("a", 2, 4, 0, 1)).change));
});

test("ingress core: an expired envelope never occupies a reorder slot", () => {
  const c = core({ freshnessHorizon: 10, reorderWindow: 1 });
  c.tick(100);
  assert.deepEqual(c.admit(env("a", 1, 3, 50, 1)).admission, {
    kind: IngressAdmissionKind.Dropped,
    reason: IngressDropReason.Expired,
  });
  // A refused envelope leaves no scope behind: an expired message for an
  // untracked key is not an admission plane.
  assert.equal(c.view("a"), null);
  // The slot is still free for a fresh out-of-order envelope.
  assert.deepEqual(c.admit(env("a", 1, 3, 95, 1)).admission, {
    kind: IngressAdmissionKind.Buffered,
    gapFrom: 0,
  });
});

test("ingress core: Block refuses without losing the window OR moving the watermark", () => {
  const c = new IngressCore(
    defaultIngressPolicy({ highWater: 1, overflow: Overflow.Block }),
    KeepLatest,
  );
  c.admit(env("a", 1, 0, 0, 5));
  const out = c.admit(env("a", 1, 1, 0, 9));
  assert.deepEqual(out.admission, { kind: IngressAdmissionKind.Blocked });
  assert.ok(out.change.droppedReceipts);
  assert.equal(c.peek("a"), 5);
  // The blocked envelope did not advance the watermark, so a producer retry after
  // a drain is still IN ORDER rather than a duplicate.
  assert.equal(c.view("a").deliveredThrough, 0);
  c.drain("a");
  assert.deepEqual(c.admit(env("a", 1, 1, 0, 9)).admission, {
    kind: IngressAdmissionKind.Accepted,
    deliveredThrough: 1,
  });
});

test("ingress core: DropOldest restarts the window at the incoming op", () => {
  const c = core({ highWater: 2, overflow: Overflow.DropOldest });
  c.admit(env("a", 1, 0, 0, 1));
  c.admit(env("a", 1, 1, 0, 2));
  assert.deepEqual(c.admit(env("a", 1, 2, 0, 30)).admission, {
    kind: IngressAdmissionKind.Accepted,
    deliveredThrough: 2,
  });
  assert.equal(c.peek("a"), 30);
});

test("ingress core: DropNewest keeps the window and receipts the drop", () => {
  const c = core({ highWater: 1, overflow: Overflow.DropNewest });
  c.admit(env("a", 1, 0, 0, 5));
  const out = c.admit(env("a", 1, 1, 0, 9));
  assert.deepEqual(out.admission, {
    kind: IngressAdmissionKind.Dropped,
    reason: IngressDropReason.Backpressure,
  });
  assert.ok(out.change.droppedReceipts);
  assert.equal(c.peek("a"), 5);
});

test("ingress core: readiness derives from lifecycle and freshness", () => {
  const c = core({ freshnessHorizon: 10 });
  assert.equal(c.readiness("a"), IngressReadiness.Unknown);
  c.open("a", 1);
  assert.equal(c.readiness("a"), IngressReadiness.Warming);
  c.admit(env("a", 1, 0, 0, 1));
  assert.equal(c.readiness("a"), IngressReadiness.Ready);

  // Crossing the horizon is a readiness-ONLY transition.
  assert.deepEqual(c.tick(50).scopes, [
    ["a", { value: false, readiness: true, authority: false, retry: false }],
  ]);
  assert.equal(c.readiness("a"), IngressReadiness.Stale);
  // A further tick inside the same readiness dirties nothing.
  assert.ok(ingressChangeIsEmpty(c.tick(60)));
});

test("ingress core: suspend retains the watermark and reconnect replays the gap", () => {
  const c = core();
  c.admit(env("a", 1, 0, 0, 1));
  c.admit(env("a", 1, 1, 0, 1));
  let out = c.suspend("a");
  assert.deepEqual(out.replay, { generation: 1, fromSequence: 2 });
  assert.equal(c.readiness("a"), IngressReadiness.Suspended);
  // The coalesced window survives a disconnect; only readiness changed.
  assert.equal(c.peek("a"), 2);
  // Suspending twice is idempotent and dirties nothing.
  out = c.suspend("a");
  assert.ok(ingressChangeIsEmpty(out.change));
  assert.equal(out.replay, null);

  out = c.reconnect("a", 1);
  assert.deepEqual(out.replay, { generation: 1, fromSequence: 2 });
  assert.equal(c.readiness("a"), IngressReadiness.Ready);
});

test("ingress core: reconnect at a higher generation discards the stale window", () => {
  const c = core();
  c.admit(env("a", 1, 0, 0, 5));
  c.suspend("a");
  const out = c.reconnect("a", 3);
  assert.deepEqual(out.replay, { generation: 3, fromSequence: 0 });
  assert.ok(out.change.scopes.some(([, sc]) => sc.value && sc.authority));
  assert.equal(c.peek("a"), null);
});

test("ingress core: errors deepen backoff, clamp, and a delivery clears it", () => {
  const c = core({ retryBase: 10, retryCeiling: 25 });
  c.open("a", 1);
  assert.equal(c.retry("a"), null);

  c.fail("a", IngressError.TransportClosed);
  assert.deepEqual(c.retry("a"), { attempt: 1, backoff: 10, resumeFrom: 0 });
  c.fail("a", IngressError.TransportClosed);
  assert.equal(c.retry("a").backoff, 20);
  // Clamped, not doubled past the ceiling.
  c.fail("a", IngressError.TransportClosed);
  assert.equal(c.retry("a").backoff, 25);
  assert.equal(c.receipts(IngressReceiptChannel.Error).length, 3);

  c.admit(env("a", 1, 0, 0, 1));
  assert.equal(c.retry("a"), null);
});

test("ingress core: a reconnect clears the error streak without a delivery", () => {
  const c = core();
  c.open("a", 1);
  c.fail("a", IngressError.AuthorityLost);
  const out = c.reconnect("a", 1);
  assert.ok(out.change.scopes.some(([, sc]) => sc.retry));
  assert.equal(c.retry("a"), null);
});

test("ingress core: closed scopes admit nothing and claim no authority", () => {
  const c = core();
  c.admit(env("a", 1, 0, 0, 1));
  c.close("a");
  assert.equal(c.authority("a"), null);
  assert.deepEqual(c.admit(env("a", 1, 1, 0, 1)).admission, {
    kind: IngressAdmissionKind.Dropped,
    reason: IngressDropReason.ScopeClosed,
  });
  // Reopening a CLOSED scope restarts its sequence space.
  c.open("a", 1);
  assert.deepEqual(c.admit(env("a", 1, 0, 0, 4)).admission, {
    kind: IngressAdmissionKind.Accepted,
    deliveredThrough: 0,
  });
});

test("ingress core: scopes are independent", () => {
  const c = core();
  c.admit(env("a", 1, 0, 0, 1));
  const out = c.admit(env("b", 1, 0, 0, 2));
  assert.equal(out.change.scopes.length, 1);
  assert.equal(out.change.scopes[0][0], "b");
  c.close("b");
  assert.equal(c.readiness("a"), IngressReadiness.Ready);
  assert.equal(c.peek("a"), 1);
});

test("ingress core: receipts are bounded and offsets stay monotone", () => {
  const c = core({ receiptCapacity: 2 });
  for (let seq = 0; seq < 4; seq += 1) c.admit(env("a", 1, seq, 0, 1));
  const accepted = c.receipts(IngressReceiptChannel.Accepted);
  assert.equal(accepted.length, 2);
  assert.deepEqual(
    accepted.map((r) => r.offset),
    [2, 3],
  );
});

test("ingress core: a drain is a value-only egress and empty drains dirty nothing", () => {
  const c = core();
  c.admit(env("a", 1, 0, 0, 3));
  let out = c.drain("a");
  assert.equal(out.drained, 3);
  assert.deepEqual(out.change.scopes, [
    ["a", { value: true, readiness: false, authority: false, retry: false }],
  ]);
  out = c.drain("a");
  assert.equal(out.drained, null);
  assert.ok(ingressChangeIsEmpty(out.change));
  // Draining does not move the watermark: a drain is an egress, not an ack.
  assert.equal(c.view("a").deliveredThrough, 0);
});

test("ingress core: out-of-order arrival converges to the in-order fold", () => {
  // The reordering tax is paid by the BUFFER, not by the algebra: for any arrival
  // permutation of a contiguous run, the drained window equals the in-order fold,
  // so a merely associative merge suffices.
  for (const order of [
    [0, 1, 2, 3],
    [3, 2, 1, 0],
    [1, 0, 3, 2],
    [2, 0, 1, 3],
    [0, 3, 1, 2],
  ]) {
    const c = core();
    for (const seq of order) c.admit(env("a", 1, seq, 0, 1 << seq));
    assert.equal(c.peek("a"), 15, `order ${order}`);
    assert.equal(c.view("a").deliveredThrough, 3, `order ${order}`);
  }
});

test("ingress schedule: a poll interval exists only without event delivery", () => {
  assert.equal(ingressSchedule(IngressTransportKind.EventChannel, 50).pollInterval, null);
  assert.equal(ingressSchedule(IngressTransportKind.RpcTriggered, 50).pollInterval, null);
  assert.equal(ingressSchedule(IngressTransportKind.BoundedPolling, 50).pollInterval, 50);
  // A zero interval would be an unbounded refresh loop.
  assert.equal(ingressSchedule(IngressTransportKind.BoundedPolling, 0).pollInterval, 1);
});

// ---------------------------------------------------------------------------
// the flavor shells
// ---------------------------------------------------------------------------

/**
 * The two synchronous flavors are driven through one description so a shell that
 * silently stops honouring the contract cannot hide behind the other's tests.
 */
const SYNC_FLAVORS = [
  {
    name: "IngressCell",
    build(options) {
      const ctx = new Context();
      return { ctx, cell: new IngressCell(ctx, options) };
    },
  },
  {
    name: "ThreadSafeIngressCell",
    build(options) {
      const ctx = new ThreadSafeContext();
      return { ctx, cell: new ThreadSafeIngressCell(ctx, options) };
    },
  },
];

for (const flavor of SYNC_FLAVORS) {
  test(`${flavor.name}: delivery is visible through the value reader`, () => {
    const { cell } = flavor.build({ merge: Sum });
    assert.equal(cell.value("a"), null);
    cell.admit(env("a", 1, 0, 0, 5));
    assert.equal(cell.value("a"), 5);
    cell.admit(env("a", 1, 1, 0, 7));
    assert.equal(cell.value("a"), 12);
    assert.equal(cell.drain("a"), 12);
    assert.equal(cell.value("a"), null);
  });

  test(`${flavor.name}: readiness and authority are derives of the same transitions`, () => {
    const { cell } = flavor.build({ merge: Sum, policy: { freshnessHorizon: 10 } });
    assert.equal(cell.readiness("a"), IngressReadiness.Unknown);
    assert.equal(cell.authority("a"), null);

    cell.open("a", 4);
    assert.equal(cell.readiness("a"), IngressReadiness.Warming);
    assert.deepEqual(cell.authority("a"), {
      generation: 4,
      deliveredThrough: null,
      stampedAt: 0,
    });

    cell.admit(env("a", 4, 0, 5, 1));
    assert.equal(cell.readiness("a"), IngressReadiness.Ready);
    assert.deepEqual(cell.authority("a"), {
      generation: 4,
      deliveredThrough: 0,
      stampedAt: 5,
    });

    cell.tick(100);
    assert.equal(cell.readiness("a"), IngressReadiness.Stale);
  });

  test(`${flavor.name}: a buffered envelope reruns no effect`, () => {
    const { ctx, cell } = flavor.build({ merge: Sum });
    cell.open("a", 1);

    const handle = cell.valueHandle("a");
    let runs = 0;
    const observed = [];
    ctx.effect((cx) => {
      runs += 1;
      observed.push(cx.get(handle));
    });
    assert.equal(runs, 1);

    // Out of order: nothing observable moved, so the value effect must not run.
    cell.admit(env("a", 1, 2, 0, 4));
    cell.admit(env("a", 1, 1, 0, 2));
    assert.equal(runs, 1, "a buffered envelope is invisible to a value reader");

    // The delivery that closes the gap flushes all three as ONE value change.
    cell.admit(env("a", 1, 0, 0, 1));
    assert.equal(observed.at(-1), 7);
    assert.ok(runs > 1, "the delivery that unblocks the flush IS a value change");
  });

  test(`${flavor.name}: a tick inside the horizon reruns no readiness effect`, () => {
    const { ctx, cell } = flavor.build({ merge: Sum, policy: { freshnessHorizon: 100 } });
    cell.admit(env("a", 1, 0, 0, 1));

    const handle = cell.readinessHandle("a");
    let runs = 0;
    ctx.effect((cx) => {
      runs += 1;
      cx.get(handle);
    });
    assert.equal(runs, 1);

    cell.tick(50);
    assert.equal(runs, 1, "a tick inside the horizon is not a change");
    cell.tick(500);
    assert.equal(runs, 2, "crossing the horizon IS a change");
  });

  test(`${flavor.name}: an error moves retry without touching the value`, () => {
    const { ctx, cell } = flavor.build({ merge: Sum });
    cell.admit(env("a", 1, 0, 0, 9));

    const handle = cell.valueHandle("a");
    let runs = 0;
    ctx.effect((cx) => {
      runs += 1;
      cx.get(handle);
    });
    cell.fail("a", IngressError.TransportClosed);
    assert.equal(runs, 1, "an error must not re-render a value that did not change");
    assert.equal(cell.retry("a").attempt, 1);
    assert.equal(cell.value("a"), 9);
  });

  test(`${flavor.name}: receipt channels are independent readers`, () => {
    const { cell } = flavor.build({ merge: Sum });
    cell.admit(env("a", 2, 0, 0, 1));
    assert.equal(cell.accepted().length, 1);
    assert.equal(cell.dropped().length, 0);
    assert.equal(cell.errors().length, 0);

    // A fenced zombie shows up only on the dropped channel.
    cell.admit(env("a", 1, 0, 0, 1));
    assert.equal(cell.accepted().length, 1);
    const dropped = cell.dropped();
    assert.equal(dropped.length, 1);
    assert.deepEqual(dropped[0].outcome, {
      kind: "dropped",
      reason: IngressDropReason.StaleGeneration,
    });

    cell.fail("a", IngressError.DecodeFailed);
    assert.equal(cell.errors().length, 1);
    assert.equal(cell.dropped().length, 1);
  });

  test(`${flavor.name}: the schedule derives from the transport and retunes live`, () => {
    const { cell } = flavor.build({ merge: Sum, pollInterval: 25 });
    assert.equal(cell.schedule().pollInterval, null);

    cell.setTransport(IngressTransportKind.BoundedPolling);
    assert.equal(cell.schedule().pollInterval, 25);
    cell.setPollInterval(200);
    assert.equal(cell.schedule().pollInterval, 200);

    cell.setTransport(IngressTransportKind.RpcTriggered);
    assert.equal(cell.schedule().pollInterval, null);
  });

  test(`${flavor.name}: pump admits a batch and replays a surviving gap`, () => {
    const { cell } = flavor.build({ merge: Sum });
    const transport = new InProcIngress(IngressTransportKind.EventChannel);
    transport.push(env("a", 1, 0, 0, 1));
    transport.push(env("a", 1, 2, 0, 4));

    const outcomes = cell.pump(transport);
    assert.equal(outcomes.length, 2);
    assert.ok(isDelivered(outcomes[0]));
    assert.deepEqual(outcomes[1], { kind: IngressAdmissionKind.Buffered, gapFrom: 1 });
    assert.deepEqual(transport.replays(), [["a", { generation: 1, fromSequence: 1 }]]);

    // The replay closes the gap, and a second pump asks for nothing more.
    transport.push(env("a", 1, 1, 0, 2));
    cell.pump(transport);
    assert.equal(cell.value("a"), 7);
    assert.equal(transport.replays().length, 1);
  });

  test(`${flavor.name}: a polling transport cannot serve a replay`, () => {
    const { cell } = flavor.build({ merge: Sum });
    const transport = new InProcIngress(IngressTransportKind.BoundedPolling);
    transport.push(env("a", 1, 3, 0, 1));
    cell.pump(transport);
    assert.deepEqual(transport.replays(), []);
  });

  // The frontier-walk gate. This is the shape the gate has to take in this
  // binding: an EFFECT-RUN COUNT does not discriminate here, because the JS
  // kernel re-runs an effect once more when the effect lazily refreshes a SECOND
  // dirty dependency during its own run — two runs for one walk, before any
  // ingress code is involved. What a second walk really costs is a TORN
  // observation, and that is what is asserted.
  test(`${flavor.name}: a generation handoff never shows a new value with stale authority`, () => {
    const { ctx, cell } = flavor.build({ merge: Sum });
    cell.admit(env("a", 1, 0, 0, 5));

    const valueHandle = cell.valueHandle("a");
    const authorityHandle = cell.authorityHandle("a");
    const seen = [];
    ctx.effect((cx) => {
      const value = cx.get(valueHandle);
      const authority = cx.get(authorityHandle);
      seen.push([value, authority === null ? null : authority.generation]);
    });
    assert.deepEqual(seen, [[5, 1]]);

    cell.admit(env("a", 2, 0, 0, 9));
    // Value and authority land together: every observation is a state the scope
    // was really in. `[9, 1]` (the new baseline under the superseded fence) or
    // `[5, 2]` would each be a partial fan-out.
    for (const observation of seen) {
      assert.ok(
        (observation[0] === 5 && observation[1] === 1) ||
          (observation[0] === 9 && observation[1] === 2),
        `torn observation ${JSON.stringify(observation)} — one admission must be ONE ` +
          "frontier walk",
      );
    }
    assert.deepEqual(seen.at(-1), [9, 2]);
    assert.ok(seen.length > 1, "the handoff must be observed at all");
  });

  test(`${flavor.name}: scopes do not invalidate each other`, () => {
    const { ctx, cell } = flavor.build({ merge: Sum });
    cell.admit(env("a", 1, 0, 0, 1));

    const handle = cell.valueHandle("a");
    let runs = 0;
    ctx.effect((cx) => {
      runs += 1;
      cx.get(handle);
    });
    assert.equal(runs, 1);
    cell.admit(env("b", 1, 0, 0, 2));
    cell.close("b");
    assert.equal(runs, 1);
    assert.equal(cell.value("a"), 1);
  });

  test(`${flavor.name}: suspend and reconnect move readiness and report the gap`, () => {
    const { cell } = flavor.build({ merge: Sum });
    cell.admit(env("a", 1, 0, 0, 1));
    cell.admit(env("a", 1, 1, 0, 1));

    assert.deepEqual(cell.suspend("a"), { generation: 1, fromSequence: 2 });
    assert.equal(cell.readiness("a"), IngressReadiness.Suspended);
    assert.equal(cell.value("a"), 2);

    assert.equal(cell.reconnect("a", 1).fromSequence, 2);
    assert.equal(cell.readiness("a"), IngressReadiness.Ready);
  });
}

// ---------------------------------------------------------------------------
// the async flavor
// ---------------------------------------------------------------------------

test("AsyncIngressCell: admission is not async-coloured", async () => {
  const ctx = new AsyncContext();
  const cell = new AsyncIngressCell(ctx, { merge: Sum });
  // Every mutator returns a plain value with no await anywhere.
  const admission = cell.admit(env("a", 1, 0, 0, 5));
  assert.deepEqual(admission, { kind: IngressAdmissionKind.Accepted, deliveredThrough: 0 });
  assert.deepEqual(cell.suspend("a"), { generation: 1, fromSequence: 1 });
  assert.deepEqual(cell.reconnect("a", 1), { generation: 1, fromSequence: 1 });
  assert.equal(cell.drain("a"), 5);
  assert.equal(cell.drain("a"), null);
  assert.equal(cell.view("a").lifecycle, IngressLifecycle.Live);
  // Reads resolve through the async graph — the one async-coloured obligation.
  assert.equal(await cell.value("a"), null);
  assert.equal(await cell.readiness("a"), IngressReadiness.Ready);
});

test("AsyncIngressCell: a buffered envelope reruns no effect", async () => {
  const ctx = new AsyncContext();
  const cell = new AsyncIngressCell(ctx, { merge: Sum });
  cell.open("a", 1);
  const handle = cell.valueHandle("a");
  let runs = 0;
  const observed = [];
  ctx.effectAsync(async (cx) => {
    runs += 1;
    observed.push(await cx.getAsync(handle));
  });
  await ctx.settle();
  assert.equal(runs, 1);

  cell.admit(env("a", 1, 2, 0, 4));
  cell.admit(env("a", 1, 1, 0, 2));
  await ctx.settle();
  assert.equal(runs, 1, "a buffered envelope is invisible to a value reader");

  cell.admit(env("a", 1, 0, 0, 1));
  await ctx.settle();
  assert.ok(runs > 1, "the delivery that unblocks the flush IS a value change");
  assert.equal(observed.at(-1), 7);
});

test("AsyncIngressCell: a tick inside the horizon reruns no readiness effect", async () => {
  const ctx = new AsyncContext();
  const cell = new AsyncIngressCell(ctx, { merge: Sum, policy: { freshnessHorizon: 100 } });
  cell.admit(env("a", 1, 0, 0, 1));
  const handle = cell.readinessHandle("a");
  let runs = 0;
  ctx.effectAsync(async (cx) => {
    runs += 1;
    await cx.getAsync(handle);
  });
  await ctx.settle();
  assert.equal(runs, 1);

  cell.tick(50);
  await ctx.settle();
  assert.equal(runs, 1, "a tick inside the horizon is not a change");
  cell.tick(500);
  await ctx.settle();
  assert.ok(runs > 1, "crossing the horizon IS a change");
});

test("AsyncIngressCell: a generation handoff never shows a new value with stale authority", async () => {
  const ctx = new AsyncContext();
  const cell = new AsyncIngressCell(ctx, { merge: Sum });
  cell.admit(env("a", 1, 0, 0, 5));
  const valueHandle = cell.valueHandle("a");
  const authorityHandle = cell.authorityHandle("a");
  const seen = [];
  ctx.effectAsync(async (cx) => {
    const value = await cx.getAsync(valueHandle);
    const authority = await cx.getAsync(authorityHandle);
    seen.push([value, authority === null ? null : authority.generation]);
  });
  await ctx.settle();
  assert.deepEqual(seen, [[5, 1]]);

  cell.admit(env("a", 2, 0, 0, 9));
  await ctx.settle();
  for (const observation of seen) {
    assert.ok(
      (observation[0] === 5 && observation[1] === 1) ||
        (observation[0] === 9 && observation[1] === 2),
      `torn observation ${JSON.stringify(observation)} — one admission must be ONE walk`,
    );
  }
  assert.deepEqual(seen.at(-1), [9, 2]);
  assert.ok(seen.length > 1, "the handoff must be observed at all");
});

test("AsyncIngressCell: receipt channels are independent readers", async () => {
  const ctx = new AsyncContext();
  const cell = new AsyncIngressCell(ctx, { merge: Sum });
  cell.admit(env("a", 2, 0, 0, 1));
  assert.equal((await cell.accepted()).length, 1);
  assert.equal((await cell.dropped()).length, 0);
  assert.equal((await cell.errors()).length, 0);

  cell.admit(env("a", 1, 0, 0, 1));
  assert.equal((await cell.accepted()).length, 1);
  assert.equal((await cell.dropped()).length, 1);

  cell.fail("a", IngressError.DecodeFailed);
  assert.equal((await cell.errors()).length, 1);
  assert.equal((await cell.dropped()).length, 1);
});

test("AsyncIngressCell: pump admits a batch and replays a surviving gap", async () => {
  const ctx = new AsyncContext();
  const cell = new AsyncIngressCell(ctx, { merge: Sum });
  const transport = new InProcIngress(IngressTransportKind.EventChannel);
  transport.push(env("a", 1, 0, 0, 1));
  transport.push(env("a", 1, 2, 0, 4));
  const outcomes = cell.pump(transport);
  assert.equal(outcomes.length, 2);
  assert.deepEqual(transport.replays(), [["a", { generation: 1, fromSequence: 1 }]]);
  transport.push(env("a", 1, 1, 0, 2));
  cell.pump(transport);
  assert.equal(await cell.value("a"), 7);
});

test("ingress shells: every flavor refuses a foreign context", () => {
  assert.throws(() => new IngressCell({}), TypeError);
  assert.throws(() => new ThreadSafeIngressCell({}), TypeError);
  assert.throws(() => new AsyncIngressCell({}), TypeError);
  // The async graph has no synchronous `computed`, and the sync shell needs one:
  // handing the wrong context to the wrong shell must fail loudly.
  assert.throws(() => new IngressCell(new AsyncContext()), TypeError);
  assert.throws(() => new AsyncIngressCell(new Context()), TypeError);
});
