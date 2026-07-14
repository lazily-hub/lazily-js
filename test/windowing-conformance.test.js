import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Context } from "../src/reactive.js";
import { SessionWindow, SlidingWindow, TumblingCountWindow, TumblingTimeWindow } from "../src/windowing.js";

const here = dirname(fileURLToPath(import.meta.url));
const specDir = join(here, "..", "..", "lazily-spec", "conformance", "windowing");
const sum = (a, b) => a + b;

function loadFixture(name) {
  const path = join(specDir, name);
  assert.ok(existsSync(path), `missing spec fixture ${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function observe(ctx, cell) {
  const obs = ctx.computed(() => ctx.getCell(cell));
  ctx.get(obs);
  return obs;
}
function check(ctx, obs, step, out) {
  assert.equal(out, step.expected.output, "output");
  const wasCached = ctx.isSet(obs);
  ctx.get(obs);
  assert.equal(!wasCached, step.expected.invalidates.output, "invalidation");
}

test("TumblingCountWindow", () => {
  const fx = loadFixture("tumbling_count.json");
  const ctx = new Context();
  const w = new TumblingCountWindow(ctx, fx.config.n, sum);
  const obs = observe(ctx, w.outputCell);
  for (const step of fx.steps) {
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
    if (step.op.type === "push") {
      w.push(step.op.now, step.op.value);
      e = null;
    } else e = w.tick(step.op.now);
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
    const e = step.op.type === "push" ? w.push(step.op.now, step.op.value) : w.flush(step.op.now);
    assert.equal(e, step.returns, "emit");
    check(ctx, obs, step, w.output());
  }
});
