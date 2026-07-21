import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Context } from "../src/reactive.js";
import {
  DebounceCell,
  Lcg,
  ProbabilisticSampleCell,
  SampleCell,
  SampleMode,
  ThrottleCell,
  ThrottleEdge,
} from "../src/rateshape.js";

const here = dirname(fileURLToPath(import.meta.url));
const specDir = join(here, "..", "..", "lazily-spec", "conformance", "rateshape");

function loadFixture(name) {
  const path = join(specDir, name);
  assert.ok(existsSync(path), `missing spec fixture ${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

// Replay a fixture, asserting the emitted value, the projected output, and that
// the output reader invalidates exactly on an emit (via ctx.isSet).
function replay(ctx, fx, cell, drive) {
  const observed = ctx.computed(() => ctx.get(cell.outputCell));
  ctx.get(observed);
  for (const step of fx.steps) {
    const emitted = drive(step);
    assert.equal(emitted, step.returns, "emit");
    assert.equal(cell.output(), step.expected.output, "output");
    const wasCached = ctx.isSet(observed);
    ctx.get(observed);
    assert.equal(!wasCached, step.expected.invalidates.output, "invalidation");
  }
}

test("DebounceCell", () => {
  const fx = loadFixture("debounce.json");
  const ctx = new Context();
  const cell = new DebounceCell(ctx, fx.initial.quiet);
  replay(ctx, fx, cell, (step) => {
    if (step.op.type === "input") {
      cell.input(step.op.now, step.op.value);
      return null;
    }
    return cell.tick(step.op.now);
  });
});

function throttleTest(name, edge) {
  const fx = loadFixture(name);
  const ctx = new Context();
  const cell = new ThrottleCell(ctx, edge, fx.initial.window);
  replay(ctx, fx, cell, (step) =>
    step.op.type === "input" ? cell.input(step.op.now, step.op.value) : cell.tick(step.op.now),
  );
}

test("ThrottleCell leading", () => throttleTest("throttle_leading.json", ThrottleEdge.Leading));
test("ThrottleCell trailing", () => throttleTest("throttle_trailing.json", ThrottleEdge.Trailing));

test("SampleCell count", () => {
  const fx = loadFixture("sample_count.json");
  const ctx = new Context();
  const cell = new SampleCell(ctx, SampleMode.count(fx.initial.n));
  replay(ctx, fx, cell, (step) => cell.input(step.op.value));
});

test("SampleCell time", () => {
  const fx = loadFixture("sample_time.json");
  const ctx = new Context();
  const cell = new SampleCell(ctx, SampleMode.time(fx.initial.period));
  replay(ctx, fx, cell, (step) => {
    if (step.op.type === "input") {
      cell.input(step.op.value);
      return null;
    }
    return cell.tick(step.op.now);
  });
});

test("ProbabilisticSampleCell", () => {
  const fx = loadFixture("probabilistic_sample.json");
  const ctx = new Context();
  const cell = new ProbabilisticSampleCell(ctx, fx.initial.rate, new Lcg(0));
  replay(ctx, fx, cell, (step) => cell.inputWithDraw(step.op.value, step.op.draw));
});
