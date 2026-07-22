import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Context } from "../src/reactive.js";
import { BulkheadCell, CircuitBreakerCell, RetryPolicyCell, TimeoutCell } from "../src/resilience.js";

const here = dirname(fileURLToPath(import.meta.url));
const specDir = join(here, "..", "..", "lazily-spec", "conformance", "resilience");

function loadFixture(name) {
  const path = join(specDir, name);
  assert.ok(existsSync(path), `missing spec fixture ${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function observe(ctx, cell) {
  const obs = ctx.computed((cx) => cx.get(cell));
  ctx.get(obs);
  return obs;
}
function checkInval(ctx, obs, step, reader) {
  const wasCached = ctx.isSet(obs);
  ctx.get(obs);
  assert.equal(!wasCached, step.expected.invalidates[reader], `${reader} invalidation`);
}

test("CircuitBreakerCell", () => {
  const fx = loadFixture("circuit_breaker.json");
  const c = fx.config;
  const ctx = new Context();
  const cb = new CircuitBreakerCell(ctx, c.window, c.failure_threshold, c.reset_timeout);
  const obs = observe(ctx, cb.stateCell);
  for (const step of fx.steps) {
    const op = step.op;
    if (op.type === "record") cb.record(op.success, op.now);
    else if (op.type === "allow") assert.equal(cb.allow(op.now), step.returns, "allow");
    assert.equal(cb.state(), step.expected.state, "state");
    checkInval(ctx, obs, step, "state");
  }
});

test("RetryPolicyCell", () => {
  const fx = loadFixture("retry.json");
  const ctx = new Context();
  const r = new RetryPolicyCell(ctx, fx.config.base, fx.config.cap);
  const obs = observe(ctx, r.delayCell);
  for (const step of fx.steps) {
    assert.equal(r.nextDelay(), step.returns, "delay");
    assert.equal(r.delay(), step.expected.delay);
    checkInval(ctx, obs, step, "delay");
  }
});

test("BulkheadCell", () => {
  const fx = loadFixture("bulkhead.json");
  const ctx = new Context();
  const b = new BulkheadCell(ctx, fx.config.capacity);
  const obs = observe(ctx, b.inUseCell);
  for (const step of fx.steps) {
    if (step.op.type === "acquire") assert.equal(b.acquire(), step.returns);
    else b.release();
    assert.equal(b.permitsInUse(), step.expected.in_use);
    checkInval(ctx, obs, step, "in_use");
  }
});

test("TimeoutCell", () => {
  const fx = loadFixture("timeout.json");
  const ctx = new Context();
  const t = new TimeoutCell(ctx);
  const obs = observe(ctx, t.timedOutCell);
  for (const step of fx.steps) {
    const op = step.op;
    let e;
    if (op.type === "arm") {
      t.arm(op.now, op.timeout);
      e = false;
    } else e = t.tick(op.now);
    assert.equal(e, step.returns, "edge");
    assert.equal(t.isTimedOut(), step.expected.is_timed_out);
    checkInval(ctx, obs, step, "is_timed_out");
  }
});
