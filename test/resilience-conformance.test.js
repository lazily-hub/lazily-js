import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { assertKey, subBlock } from "./support/assert-key.js";

import { Context } from "../src/reactive.js";
import {
  BulkheadCell,
  CircuitBreakerCell,
  RetryPolicyCell,
  TimeoutCell,
} from "../src/resilience.js";

import { specPath } from "./spec-corpus.cjs";

const specDir = specPath("resilience");

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
  // The `invalidates` sub-block, descended rather than probed by name
  // (#lzsubblockkeyset): the child tracker owns every projection the corpus
  // declares, so a second one added upstream is reported as unconsumed instead
  // of being compared by nothing while this key still reports asserted.
  const invalidates = subBlock(step.expected, "invalidates");
  assertKey(invalidates, reader, !wasCached, `${reader} invalidation`);
}

test("CircuitBreakerCell", () => {
  const fx = loadFixture("circuit_breaker.json");
  const c = fx.config;
  const ctx = new Context();
  const cb = new CircuitBreakerCell(ctx, c.window, c.failure_threshold, c.reset_timeout);
  const obs = observe(ctx, cb.stateCell);
  for (const step of fx.steps) {
    const op = step.op;
    // No closing arm (#lzscenariobodyskip): the resilience corpus union also
    // carries acquire/release/arm/tick/next, so an unmatched spelling skipped
    // the op AND its `returns` comparison, leaving `state` asserted against
    // untouched state.
    if (op.type === "record") cb.record(op.success, op.now);
    else if (op.type === "allow") assert.equal(cb.allow(op.now), step.returns, "allow");
    else throw new Error(`unknown CircuitBreakerCell op type in fixture: ${op.type}`);
    assertKey(step.expected, "state", cb.state());
    checkInval(ctx, obs, step, "state");
  }
});

test("RetryPolicyCell", () => {
  const fx = loadFixture("retry.json");
  const ctx = new Context();
  const r = new RetryPolicyCell(ctx, fx.config.base, fx.config.cap);
  const obs = observe(ctx, r.delayCell);
  for (const step of fx.steps) {
    // `op.type` was never read (#lzscenariobodyskip): every step was driven as
    // `next` whatever the fixture named it.
    if (step.op.type !== "next") {
      throw new Error(`unknown RetryPolicyCell op type in fixture: ${step.op.type}`);
    }
    assert.equal(r.nextDelay(), step.returns, "delay");
    assertKey(step.expected, "delay", r.delay());
    checkInval(ctx, obs, step, "delay");
  }
});

test("BulkheadCell", () => {
  const fx = loadFixture("bulkhead.json");
  const ctx = new Context();
  const b = new BulkheadCell(ctx, fx.config.capacity);
  const obs = observe(ctx, b.inUseCell);
  for (const step of fx.steps) {
    // The `else` assumed `release` (#lzscenariobodyskip).
    if (step.op.type === "acquire") assert.equal(b.acquire(), step.returns);
    else if (step.op.type === "release") b.release();
    else throw new Error(`unknown BulkheadCell op type in fixture: ${step.op.type}`);
    assertKey(step.expected, "in_use", b.permitsInUse());
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
    // The `else` assumed `tick` (#lzscenariobodyskip): an unrecognised spelling
    // advanced the clock instead of the op the fixture named, and the edge was
    // then asserted against the wrong transition.
    if (op.type === "arm") {
      t.arm(op.now, op.timeout);
      e = false;
    } else if (op.type === "tick") e = t.tick(op.now);
    else throw new Error(`unknown TimeoutCell op type in fixture: ${op.type}`);
    assert.equal(e, step.returns, "edge");
    assertKey(step.expected, "is_timed_out", t.isTimedOut());
    checkInval(ctx, obs, step, "is_timed_out");
  }
});
