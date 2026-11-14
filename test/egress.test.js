// Unit coverage for the egress transport attachment and policy validation
// (`#lzegress`). The canonical corpus (test/egress-family-conformance.test.js)
// pins the delivery authority beneath any concrete transport; this file pins the
// one attached Effect per incarnation for every flavor, mirroring the unit tests
// in lazily-rs/src/egress.rs and src/async_egress.rs.

import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "../src/reactive.js";
import { ThreadSafeContext } from "../src/thread-safe.js";
import { AsyncContext } from "../src/reactive-async.js";
import { EgressCell } from "../src/egress.js";
import { ThreadSafeEgressCell } from "../src/thread-safe-egress.js";
import { AsyncEgressCell } from "../src/async-egress.js";
import { EgressConfigError, EgressCore } from "../src/egress-core.js";

function recorder({ failFirst = false } = {}) {
  const transport = {
    sent: [],
    failNext: failFirst,
    send(envelope) {
      if (transport.failNext) {
        transport.failNext = false;
        return false;
      }
      transport.sent.push(envelope.sequence);
      return true;
    },
  };
  return transport;
}

async function settle(ctx) {
  if (typeof ctx.settle === "function") {
    // Deterministic: the effect run promise is registered synchronously when
    // the reader is invalidated, and settle() awaits every run to quiescence.
    await ctx.settle();
  }
}

const FLAVORS = [
  { name: "single-threaded", make: (g, p) => [new Context(), (ctx) => new EgressCell(ctx, g, p)] },
  {
    name: "thread-safe",
    make: (g, p) => [new ThreadSafeContext(), (ctx) => new ThreadSafeEgressCell(ctx, g, p)],
  },
  { name: "async", make: (g, p) => [new AsyncContext(), (ctx) => new AsyncEgressCell(ctx, g, p)] },
];

function build(flavor, generation, policy = {}) {
  const [ctx, cell] = flavor.make(generation, policy);
  return { ctx, egress: cell(ctx) };
}

for (const flavor of FLAVORS) {
  test(`egress (${flavor.name}): one Effect projects pending to the transport and inflight`, async () => {
    const { ctx, egress } = build(flavor, 1);
    const transport = recorder();
    egress.attachTransport(transport);
    egress.enqueue(10);
    egress.enqueue(20);
    await settle(ctx);
    assert.deepEqual(transport.sent, [0, 1]);
    assert.equal((await egress.pending()).length, 0);
    assert.equal((await egress.inflight()).length, 2);
  });

  test(`egress (${flavor.name}): reconnect makes the old attachment inert`, async () => {
    const { ctx, egress } = build(flavor, 3);
    const old = recorder();
    egress.attachTransport(old);
    egress.enqueue(10);
    await settle(ctx);
    egress.reconnect(4);
    egress.enqueue(20);
    await settle(ctx);
    assert.deepEqual(old.sent, [0], "the fenced attachment sends nothing more");
    const fresh = recorder();
    egress.attachTransport(fresh);
    await settle(ctx);
    assert.deepEqual(fresh.sent, [0, 1], "the replacement replays the retained pending projection");
    assert.deepEqual(
      (await egress.inflight()).map((e) => [e.generation, e.sequence, e.attempt]),
      [
        [4, 0, 2],
        [4, 1, 1],
      ],
    );
  });

  test(`egress (${flavor.name}): an ack reopens the window without a request/ack handshake`, async () => {
    const { ctx, egress } = build(flavor, 1, { inflightLimit: 1 });
    const transport = recorder();
    egress.attachTransport(transport);
    egress.enqueue(10);
    egress.enqueue(20);
    await settle(ctx);
    assert.deepEqual(transport.sent, [0]);
    assert.equal((await egress.pending()).length, 1);
    assert.deepEqual(egress.ack(1, 0), { kind: "advanced", through: 0 });
    await settle(ctx);
    assert.deepEqual(transport.sent, [0, 1]);
    assert.equal((await egress.pending()).length, 0);
  });

  test(`egress (${flavor.name}): a refused send is parked, not spun`, async () => {
    const { ctx, egress } = build(flavor, 1, { retryBudget: 1, retryBase: 5, retryCeiling: 20 });
    const transport = recorder({ failFirst: true });
    egress.attachTransport(transport);
    egress.enqueue(10);
    await settle(ctx);
    assert.deepEqual(transport.sent, [], "the refused send is not retried immediately");
    assert.deepEqual(await egress.retry(), {
      sequence: 0,
      attempt: 1,
      backoff: 5,
      exhausted: false,
    });
    assert.equal((await egress.pending()).length, 0);
    assert.equal(egress.retryNow(1, 0).kind, "scheduled");
    await settle(ctx);
    assert.deepEqual(transport.sent, [0], "retryNow re-drives the same attachment");
    assert.equal(await egress.retry(), null);
  });
}

test("egress: the async attachment awaits an async-coloured transport", async () => {
  const ctx = new AsyncContext();
  const egress = new AsyncEgressCell(ctx, 1);
  const sent = [];
  egress.attachTransport({
    async send(envelope) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      sent.push(envelope.sequence);
      return true;
    },
  });
  egress.enqueue(7);
  await settle(ctx);
  assert.deepEqual(sent, [0]);
  assert.equal((await egress.inflight()).length, 1);
});

test("egress: a refused policy throws before any reader is minted", () => {
  assert.throws(() => new EgressCore(1, { inflightLimit: 0 }), {
    message: EgressConfigError.ZeroInflightLimit,
  });
  assert.throws(() => new EgressCore(1, { retryBase: 0 }), {
    message: EgressConfigError.ZeroRetryBase,
  });
  assert.throws(() => new EgressCore(1, { retryBase: 10, retryCeiling: 5 }), {
    message: EgressConfigError.RetryCeilingBelowBase,
  });
  assert.throws(() => new EgressCell(new Context(), 1, { inflightLimit: 0 }));
  assert.throws(() => new EgressCell({}, 1), TypeError);
});

test("egress: backoff doubles to the ceiling and reconnect rejects a stale generation", () => {
  const core = new EgressCore(1, { retryBudget: 5, retryBase: 5, retryCeiling: 12 });
  core.enqueue("a");
  const backoffs = [];
  for (let i = 0; i < 3; i++) {
    core.claim(1);
    backoffs.push(core.fail(1, 0).failure.retry.backoff);
    core.retryNow(1, 0);
  }
  assert.deepEqual(backoffs, [5, 10, 12]);
  assert.deepEqual(core.reconnect(0).reconnect, { kind: "stale_generation", current: 1 });
  assert.deepEqual(core.reconnect(1).reconnect, { kind: "unchanged", generation: 1 });
  assert.equal(
    core.reconnect(2).reconnect.replayed,
    0,
    "a pending record is rewritten, not replayed",
  );
  assert.equal(core.pending()[0].generation, 2);
});

test("egress: an ACK past the end of the sequence space is refused and changes nothing", () => {
  for (const flavor of FLAVORS.slice(0, 2)) {
    const { ctx, egress } = build(flavor, 1);
    egress.enqueue(10);
    egress.claim(1);
    egress.pending();
    egress.inflight();
    egress.ackedThrough();
    const handles = [egress.pendingHandle(), egress.inflightHandle(), egress.ackedThroughHandle()];
    assert.deepEqual(egress.ack(1, 1), { kind: "beyond_sent", nextSequence: 1 }, flavor.name);
    assert.ok(
      handles.every((handle) => ctx.isSet(handle)),
      `${flavor.name}: a refused ACK invalidates nothing`,
    );
    assert.equal(egress.ackedThrough(), null, `${flavor.name}: the watermark did not move`);
    assert.equal(egress.inflight().length, 1, `${flavor.name}: nothing was pruned`);
    // The generation fence is checked first: a stale beyond-the-end ACK is stale.
    assert.equal(egress.ack(0, 99).kind, "stale_generation");
    assert.deepEqual(egress.ack(1, 0), { kind: "advanced", through: 0 });
  }
});

test("egress: reconnect invalidates pending when it only rewrites retained envelopes", async () => {
  for (const flavor of FLAVORS) {
    const { ctx, egress } = build(flavor, 1);
    egress.enqueue(10);
    await egress.pending();
    await egress.inflight();
    const valid = (handle) =>
      typeof ctx.isResolved === "function" ? ctx.isResolved(handle) : ctx.isSet(handle);
    assert.deepEqual(egress.reconnect(2), { kind: "advanced", generation: 2, replayed: 0 });
    assert.ok(!valid(egress.pendingHandle()), `${flavor.name}: pending must be invalidated`);
    assert.ok(valid(egress.inflightHandle()), `${flavor.name}: inflight did not change`);
    assert.deepEqual(
      (await egress.pending()).map((e) => e.generation),
      [2],
      `${flavor.name}: the reader observes the rewritten generation`,
    );
    // With nothing retained, the pending projection did not change.
    const idle = build(flavor, 1);
    await idle.egress.pending();
    const idleValid = (handle) =>
      typeof idle.ctx.isResolved === "function"
        ? idle.ctx.isResolved(handle)
        : idle.ctx.isSet(handle);
    assert.equal(idle.egress.reconnect(2).replayed, 0);
    assert.ok(idleValid(idle.egress.pendingHandle()), `${flavor.name}: empty pending stays valid`);
  }
});
