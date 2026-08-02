import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertKey, assertKeyWith } from "./support/assert-key.js";

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
  const observed = ctx.computed((cx) => cx.get(cell.outputCell));
  ctx.get(observed);
  for (const step of fx.steps) {
    const emitted = drive(step);
    assert.equal(emitted, step.returns, "emit");
    assertKey(step.expected, "output", cell.output(), "output");
    const wasCached = ctx.isSet(observed);
    ctx.get(observed);
    assertKeyWith(step.expected, "invalidates", (want) => {
      assert.equal(!wasCached, want.output, "invalidation");
    });
  }
}

test("DebounceCell", () => {
  const fx = loadFixture("debounce.json");
  const ctx = new Context();
  const cell = new DebounceCell(ctx, fx.initial.quiet);
  replay(ctx, fx, cell, (step) => {
    // The fall-through assumed `tick` (#lzscenariobodyskip): an unrecognised
    // spelling advanced the clock instead of the op the fixture named.
    if (step.op.type === "input") {
      cell.input(step.op.now, step.op.value);
      return null;
    }
    if (step.op.type === "tick") return cell.tick(step.op.now);
    throw new Error(`unknown DebounceCell op type in fixture: ${step.op.type}`);
  });
});

function throttleTest(name, edge) {
  const fx = loadFixture(name);
  const ctx = new Context();
  const cell = new ThrottleCell(ctx, edge, fx.initial.window);
  replay(ctx, fx, cell, (step) => {
    // The ternary's false arm assumed `tick` (#lzscenariobodyskip).
    if (step.op.type === "input") return cell.input(step.op.now, step.op.value);
    if (step.op.type === "tick") return cell.tick(step.op.now);
    throw new Error(`unknown ThrottleCell op type in fixture: ${step.op.type}`);
  });
}

test("ThrottleCell leading", () => throttleTest("throttle_leading.json", ThrottleEdge.Leading));
test("ThrottleCell trailing", () => throttleTest("throttle_trailing.json", ThrottleEdge.Trailing));

test("SampleCell count", () => {
  const fx = loadFixture("sample_count.json");
  const ctx = new Context();
  const cell = new SampleCell(ctx, SampleMode.count(fx.initial.n));
  replay(ctx, fx, cell, (step) => {
    // `op.type` was never read (#lzscenariobodyskip): every step was fed as an
    // input whatever the fixture named it, so a count fixture that grew a `tick`
    // would have been replayed as a value input.
    if (step.op.type !== "input") {
      throw new Error(`unknown SampleCell (count) op type in fixture: ${step.op.type}`);
    }
    return cell.input(step.op.value);
  });
});

test("SampleCell time", () => {
  const fx = loadFixture("sample_time.json");
  const ctx = new Context();
  const cell = new SampleCell(ctx, SampleMode.time(fx.initial.period));
  replay(ctx, fx, cell, (step) => {
    // The fall-through assumed `tick` (#lzscenariobodyskip).
    if (step.op.type === "input") {
      cell.input(step.op.value);
      return null;
    }
    if (step.op.type === "tick") return cell.tick(step.op.now);
    throw new Error(`unknown SampleCell (time) op type in fixture: ${step.op.type}`);
  });
});

test("ProbabilisticSampleCell", () => {
  const fx = loadFixture("probabilistic_sample.json");
  const ctx = new Context();
  const cell = new ProbabilisticSampleCell(ctx, fx.initial.rate, new Lcg(0));
  replay(ctx, fx, cell, (step) => {
    // `op.type` was never read (#lzscenariobodyskip): see SampleCell count.
    if (step.op.type !== "input") {
      throw new Error(`unknown ProbabilisticSampleCell op type in fixture: ${step.op.type}`);
    }
    return cell.inputWithDraw(step.op.value, step.op.draw);
  });
});
