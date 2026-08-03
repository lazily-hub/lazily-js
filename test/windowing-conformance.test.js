import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertKey, subBlock } from "./support/assert-key.js";

import { Context } from "../src/reactive.js";
import {
  SessionWindow,
  SlidingWindow,
  TumblingCountWindow,
  TumblingTimeWindow,
} from "../src/windowing.js";

const here = dirname(fileURLToPath(import.meta.url));
const specDir = join(here, "..", "..", "lazily-spec", "conformance", "windowing");
const sum = (a, b) => a + b;

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
function check(ctx, obs, step, out) {
  assertKey(step.expected, "output", out, "output");
  const wasCached = ctx.isSet(obs);
  ctx.get(obs);
  // Descended, not probed by name (#lzsubblockkeyset): the child tracker owns
  // every projection `invalidates` declares, so a second one added upstream is
  // reported as unconsumed rather than compared by nothing.
  const invalidates = subBlock(step.expected, "invalidates");
  assertKey(invalidates, "output", !wasCached, "invalidation");
}

test("TumblingCountWindow", () => {
  const fx = loadFixture("tumbling_count.json");
  const ctx = new Context();
  const w = new TumblingCountWindow(ctx, fx.config.n, sum);
  const obs = observe(ctx, w.outputCell);
  for (const step of fx.steps) {
    // `op.type` was never read (#lzscenariobodyskip): every step was pushed
    // whatever the fixture named it, and the windowing corpus union carries
    // push/flush/tick — a count fixture that grew a `tick` would have been
    // replayed as a value push.
    if (step.op.type !== "push") {
      throw new Error(`unknown TumblingCountWindow op type in fixture: ${step.op.type}`);
    }
    assert.equal(w.push(step.op.value), step.returns, "emit");
    check(ctx, obs, step, w.output());
  }
});

test("TumblingTimeWindow", () => {
  const fx = loadFixture("tumbling_time.json");
  const ctx = new Context();
  const w = new TumblingTimeWindow(ctx, fx.config.period, sum);
  const obs = observe(ctx, w.outputCell);
  for (const step of fx.steps) {
    let e;
    // The `else` assumed `tick` (#lzscenariobodyskip): a `flush` — which this
    // corpus also spells — would have advanced the clock instead.
    if (step.op.type === "push") {
      w.push(step.op.now, step.op.value);
      e = null;
    } else if (step.op.type === "tick") e = w.tick(step.op.now);
    else throw new Error(`unknown TumblingTimeWindow op type in fixture: ${step.op.type}`);
    assert.equal(e, step.returns, "emit");
    check(ctx, obs, step, w.output());
  }
});

test("SlidingWindow", () => {
  const fx = loadFixture("sliding_count.json");
  const ctx = new Context();
  const w = new SlidingWindow(ctx, fx.config.size, fx.config.slide, sum);
  const obs = observe(ctx, w.outputCell);
  for (const step of fx.steps) {
    // `op.type` was never read (#lzscenariobodyskip): see TumblingCountWindow.
    if (step.op.type !== "push") {
      throw new Error(`unknown SlidingWindow op type in fixture: ${step.op.type}`);
    }
    assert.equal(w.push(step.op.value), step.returns, "emit");
    check(ctx, obs, step, w.output());
  }
});

test("SessionWindow", () => {
  const fx = loadFixture("session.json");
  const ctx = new Context();
  const w = new SessionWindow(ctx, fx.config.gap, sum);
  const obs = observe(ctx, w.outputCell);
  for (const step of fx.steps) {
    // The ternary's false arm assumed `flush` (#lzscenariobodyskip): a `tick`
    // would have been replayed as a session flush.
    let e;
    if (step.op.type === "push") e = w.push(step.op.now, step.op.value);
    else if (step.op.type === "flush") e = w.flush(step.op.now);
    else throw new Error(`unknown SessionWindow op type in fixture: ${step.op.type}`);
    assert.equal(e, step.returns, "emit");
    check(ctx, obs, step, w.output());
  }
});
