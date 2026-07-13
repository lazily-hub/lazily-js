import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "../src/reactive.js";
import { KeepLatest, Max, Sum, RawFifo } from "../src/merge.js";
import {
  BackpressurePolicy,
  BoundDim,
  ExpiryPolicy,
  FramedTransport,
  Inbox,
  InProcTransport,
  IngressOutcome,
  KeyedRelay,
  Outbox,
  Overflow,
  PriorityStorage,
  RatePolicy,
  RelayCell,
  RelayConfigError,
  SpillMode,
  SpillStore,
  WindowPolicy,
} from "../src/relay.js";

// RelayCell Phases 2–6 spike (#relaycell) for the stackless JS binding. The doc
// §8 mandate is that JS converges identically to lazily-rs — these prove the
// operational invariants: relay_converges, transport_independent, spill_lossless,
// spill_replay_idempotent, plus overflow behaviour, roles, and the Phase-6
// policies.

function relay(ctx, policy, { highWater = 1_000_000, overflow = Overflow.Conflate } = {}) {
  return new RelayCell(
    ctx,
    new BackpressurePolicy(ctx, BoundDim.Count, highWater, Math.floor(highWater / 2), overflow),
    policy,
  );
}

// -- Phase 2 -----------------------------------------------------------------

test("converged egress independent of drain schedule", () => {
  for (const policy of [Sum, Max]) {
    const ops = [3, 1, 4, 1, 5, 9, 2, 6];
    const flat = ops.reduce((a, b) => policy.merge(a, b));

    const ctxA = new Context();
    const rA = relay(ctxA, policy);
    let accA = null;
    for (const op of ops) {
      rA.ingress(op);
      const d = rA.drain();
      if (d === null) continue;
      accA = accA === null ? d : policy.merge(accA, d);
    }
    assert.equal(accA, flat, `${policy.name}: drain-every`);

    const ctxB = new Context();
    const rB = relay(ctxB, policy);
    for (const op of ops) rB.ingress(op);
    assert.equal(rB.drain(), flat, `${policy.name}: drain-once`);
  }
});

test("reactive depth / isFull / isEmpty", () => {
  const ctx = new Context();
  const r = relay(ctx, Sum, { highWater: 3 });
  assert.equal(r.isEmpty(), true);
  assert.equal(r.depth(), 0);
  assert.equal(r.isFull(), false);

  r.ingress(1);
  r.ingress(1);
  assert.equal(r.isEmpty(), false);
  assert.equal(r.depth(), 2);
  assert.equal(r.isFull(), false);

  r.ingress(1);
  assert.equal(r.depth(), 3);
  assert.equal(r.isFull(), true);

  r.drain();
  assert.equal(r.isEmpty(), true);
  assert.equal(r.depth(), 0);
});

test("Block overflow refuses ingress", () => {
  const ctx = new Context();
  const r = relay(ctx, Sum, { highWater: 2, overflow: Overflow.Block });
  assert.equal(r.ingress(1), IngressOutcome.Accepted);
  assert.equal(r.ingress(1), IngressOutcome.Conflated);
  assert.equal(r.ingress(1), IngressOutcome.Blocked);
  assert.equal(r.drain(), 2);
});

test("DropNewest and DropOldest", () => {
  const ctxN = new Context();
  const rn = relay(ctxN, Sum, { highWater: 2, overflow: Overflow.DropNewest });
  rn.ingress(1);
  rn.ingress(1);
  assert.equal(rn.ingress(9), IngressOutcome.Dropped);
  assert.equal(rn.drain(), 2);

  const ctxO = new Context();
  const ro = relay(ctxO, Sum, { highWater: 2, overflow: Overflow.DropOldest });
  ro.ingress(1);
  ro.ingress(1);
  assert.equal(ro.ingress(9), IngressOutcome.Dropped);
  assert.equal(ro.drain(), 9);
});

test("construction rejects Conflate for RawFifo", () => {
  const ctx = new Context();
  assert.throws(
    () =>
      new RelayCell(
        ctx,
        new BackpressurePolicy(ctx, BoundDim.Count, 4, 2, Overflow.Conflate),
        RawFifo,
      ),
    (e) => e.message === RelayConfigError.ConflateNotBounding,
  );
});

// -- Phase 3 -----------------------------------------------------------------

test("spill_lossless both modes", () => {
  for (const mode of [SpillMode.CompactOnWrite, SpillMode.AppendCompact]) {
    const store = new SpillStore(mode, 2, Sum);
    const windows = [1, 2, 3, 4, 5];
    for (const w of windows) store.spill(w, 1);
    const hot = 10;
    const flat = [...windows, hot].reduce((a, b) => a + b);
    assert.equal(store.reconstruct(0, hot), flat, mode);
  }
});

test("spill_replay_idempotent for idempotent policy", () => {
  const store = new SpillStore(SpillMode.AppendCompact, 1, Max);
  for (const w of [3, 7, 5]) store.spill(w, 1);
  const once = store.replayUnacked(0);
  const twice = store.replayUnacked(once);
  assert.equal(once, twice);
  assert.equal(once, 7);
});

test("CompactOnWrite bounds pages and ack reclaims", () => {
  const store = new SpillStore(SpillMode.CompactOnWrite, 2, Sum);
  for (let i = 0; i < 5; i++) store.spill(1, 1); // page size 2 → 3 pages
  assert.equal(store.pageCount(), 3);
  const [firstId] = store.manifest()[0];
  store.ackThrough(firstId);
  assert.equal(store.pendingPages().length, 2);
  store.reclaim();
  assert.equal(store.pageCount(), 2);
});

// -- Phase 4 -----------------------------------------------------------------

test("transport_independent across framing", () => {
  for (const policy of [Sum, Max, KeepLatest]) {
    const ops = [3, 1, 4, 1, 5, 9];
    const flat = ops.reduce((a, b) => policy.merge(a, b));
    for (const transport of [new InProcTransport(), new FramedTransport(2), new FramedTransport(3)]) {
      for (const op of ops) transport.deliver(op);
      const ctx = new Context();
      const r = relay(ctx, policy);
      while (transport.hasPending()) {
        for (const op of transport.poll()) r.ingress(op);
      }
      assert.equal(r.drain(), flat, policy.name);
    }
  }
});

// -- Phase 5 -----------------------------------------------------------------

test("Outbox conflates state broadcast", () => {
  const ctx = new Context();
  const out = new Outbox(ctx, 8, KeepLatest);
  out.send(1);
  out.send(2);
  out.send(3);
  assert.equal(out.drain(), 3);
});

test("Inbox credit meters remote", () => {
  const ctx = new Context();
  const inbox = new Inbox(ctx, 100, 2, Sum);
  assert.equal(inbox.ready(), true);
  inbox.receive(5);
  inbox.receive(5);
  assert.equal(inbox.ready(), false);
  assert.equal(inbox.consume(2), 10);
  assert.equal(inbox.ready(), true);
});

test("Outbox → Inbox link converges", () => {
  const ctx = new Context();
  const out = new Outbox(ctx, 64, Sum);
  const inbox = new Inbox(ctx, 64, 64, Sum);
  const transport = new InProcTransport();
  const ops = [1, 2, 3, 4];
  for (const op of ops) out.send(op);
  transport.deliver(out.drain());
  while (transport.hasPending()) {
    for (const frame of transport.poll()) inbox.receive(frame);
  }
  assert.equal(inbox.consume(64), ops.reduce((a, b) => a + b));
});

// -- Phase 6 -----------------------------------------------------------------

test("RatePolicy token bucket", () => {
  const rate = new RatePolicy(2, 1);
  assert.equal(rate.tryEgress(), true);
  assert.equal(rate.tryEgress(), true);
  assert.equal(rate.tryEgress(), false);
  rate.tick();
  assert.equal(rate.tryEgress(), true);
});

test("WindowPolicy flush on fill and tick", () => {
  const window = new WindowPolicy(3);
  assert.equal(window.onIngress(), false);
  assert.equal(window.onIngress(), false);
  assert.equal(window.onIngress(), true);
  assert.equal(window.onIngress(), false);
  assert.equal(window.tick(), true);
  assert.equal(window.tick(), false);
});

test("ExpiryPolicy drops aged", () => {
  const expiry = new ExpiryPolicy(5);
  expiry.advance(10);
  const batch = [
    [3, "old"],
    [7, "fresh"],
    [10, "now"],
  ];
  assert.deepEqual(expiry.retainLive(batch), ["fresh", "now"]);
});

test("PriorityStorage pops highest first, FIFO within", () => {
  const pq = new PriorityStorage();
  pq.push(1, "low");
  pq.push(3, "highA");
  pq.push(2, "mid");
  pq.push(3, "highB");
  assert.equal(pq.pop(), "highA");
  assert.equal(pq.pop(), "highB");
  assert.equal(pq.pop(), "mid");
  assert.equal(pq.pop(), "low");
  assert.equal(pq.pop(), null);
});

test("KeyedRelay shards per key", () => {
  const ctx = new Context();
  const keyed = new KeyedRelay(ctx, 64, Overflow.Conflate, Sum);
  keyed.ingress("a", 1);
  keyed.ingress("b", 10);
  keyed.ingress("a", 2);
  assert.equal(keyed.drain("a"), 3);
  assert.equal(keyed.drain("b"), 10);
  assert.deepEqual([...keyed.keys()], ["a", "b"]);
});
