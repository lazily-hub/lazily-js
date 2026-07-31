import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertKey, assertKeyWith } from "./support/assert-key.js";

import { Context } from "../src/reactive.js";
import { CronCell, DeadlineCell, IntervalCell, TimerCell } from "../src/temporal.js";

const here = dirname(fileURLToPath(import.meta.url));
const specTemporal = join(here, "..", "..", "lazily-spec", "conformance", "temporal");

function loadFixture(name) {
  const path = join(specTemporal, name);
  assert.ok(existsSync(path), `missing spec fixture ${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

// Each source projects its fire edge onto a reactive cell; a `computed` wrapping
// that cell lets us observe invalidation via `ctx.isSet` — the reader stays
// cached unless the tick fired.
function observe(ctx, cell) {
  const slot = ctx.computed((cx) => cx.get(cell));
  ctx.get(slot);
  return slot;
}

test("TimerCell single-shot", () => {
  const fx = loadFixture("timer_single_shot.json");
  const ctx = new Context();
  const timer = new TimerCell(ctx, fx.initial.fire_at);
  const observed = observe(ctx, timer.firedCell);

  for (const step of fx.steps) {
    assert.equal(timer.tick(step.op.now), step.returns, "fire edge");
    assertKey(step.expected, "fired", timer.hasFired());
    assertKeyWith(step.expected, "value", (want) => {
      // The corpus spells the fired unit payload `"()"`; this binding materialises
      // it as `true`, and an unfired timer as `null`. Refuse any other encoding
      // rather than silently mapping it to `null`.
      assert.ok(want === "()" || want === null, `unmodelled timer payload ${JSON.stringify(want)}`);
      assert.equal(timer.value(), want === "()" ? true : null);
    });
    assertKey(step.expected, "next_fire", timer.nextFire());

    const wasCached = ctx.isSet(observed);
    ctx.get(observed);
    assertKeyWith(step.expected, "invalidates", (want) => {
      assert.equal(!wasCached, want.fired, "invalidation");
    });
  }
});

test("IntervalCell periodic", () => {
  const fx = loadFixture("interval_periodic.json");
  const ctx = new Context();
  const iv = new IntervalCell(ctx, fx.initial.period);
  const observed = observe(ctx, iv.countCell);

  for (const step of fx.steps) {
    assert.equal(iv.tick(step.op.now), step.returns, "fire edge");
    assertKey(step.expected, "count", iv.count());
    assertKey(step.expected, "next_fire", iv.nextFire());

    const wasCached = ctx.isSet(observed);
    ctx.get(observed);
    assertKeyWith(step.expected, "invalidates", (want) => {
      assert.equal(!wasCached, want.count, "invalidation");
    });
  }
});

test("CronCell pattern", () => {
  const fx = loadFixture("cron_pattern.json");
  const ctx = new Context();
  const cron = new CronCell(ctx, fx.initial.cycle, fx.initial.offsets);
  const observed = observe(ctx, cron.countCell);

  for (const step of fx.steps) {
    assert.equal(cron.tick(step.op.now), step.returns, "fire edge");
    assertKey(step.expected, "count", cron.count());
    assertKey(step.expected, "next_fire", cron.nextFire());

    const wasCached = ctx.isSet(observed);
    ctx.get(observed);
    assertKeyWith(step.expected, "invalidates", (want) => {
      assert.equal(!wasCached, want.count, "invalidation");
    });
  }
});

test("DeadlineCell expiry", () => {
  const fx = loadFixture("deadline_expiry.json");
  const ctx = new Context();
  const d = new DeadlineCell(ctx, fx.initial.value, fx.initial.deadline);
  const observed = observe(ctx, d.expiredCell);

  for (const step of fx.steps) {
    assert.equal(d.tick(step.op.now), step.returns, "expiry edge");
    const state = d.state();
    assertKey(step.expected, "state", state.state);
    assertKey(step.expected, "value", state.value, "value preserved");

    const wasCached = ctx.isSet(observed);
    ctx.get(observed);
    assertKeyWith(step.expected, "invalidates", (want) => {
      assert.equal(!wasCached, want.state, "invalidation");
    });
  }
});
