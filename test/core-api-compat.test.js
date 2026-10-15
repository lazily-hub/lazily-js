import assert from "node:assert/strict";
import { test } from "node:test";

import { Computed, Context, Effect, Source, TeardownScope } from "../src/core.js";

test("Core entry point executes the profile lifecycle", () => {
  const context = new Context();
  const source = context.source(1);
  const values = [];
  const computed = context.computed((compute) => compute.get(source) + 1);
  const scope = context.scope();
  const effect = scope.effect((compute) => {
    values.push(compute.get(computed));
  });

  assert.ok(source instanceof Source);
  assert.ok(computed instanceof Computed);
  assert.ok(effect instanceof Effect);
  assert.ok(scope instanceof TeardownScope);
  assert.deepEqual(values, [2]);

  context.batch(() => {
    source.set(2);
    source.set(3);
  });
  assert.deepEqual(values, [2, 4]);
  scope.end();
  source.dispose();
  computed.dispose();
});
