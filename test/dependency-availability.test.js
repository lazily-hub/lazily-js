import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { assertKey } from "./support/assert-key.js";

import { AsyncDependencyMap } from "../src/async-reactive-family.js";
import { AsyncContext } from "../src/reactive-async.js";
import { Context } from "../src/reactive.js";
import { DependencyAvailability, DependencyMap } from "../src/reactive-family.js";
import { ThreadSafeContext } from "../src/thread-safe.js";
import { ThreadSafeDependencyMap } from "../src/thread-safe-reactive-family.js";

import { specPath } from "./spec-corpus.cjs";

test("exact-key availability is a direct reactive value transition", () => {
  const fixture = JSON.parse(
    readFileSync(specPath("collections", "dependency_reactive_availability.json"), "utf8"),
  );
  const ctx = new Context();
  const dependencies = new DependencyMap(ctx);
  let runs = 0;
  const wanted = ctx.computed((compute) => {
    runs += 1;
    return dependencies.observeDependency(compute, fixture.key);
  });
  let identity;

  for (const [index, step] of fixture.steps.entries()) {
    switch (step.op.type) {
      case "observe_dependency":
        ctx.get(wanted);
        break;
      case "publish":
        dependencies.publish(step.op.key, step.op.value);
        break;
      case "unpublish":
        dependencies.unpublish(step.op.key);
        break;
      default:
        assert.fail(`step ${index}: unsupported operation ${step.op.type}`);
    }

    const state = ctx.get(wanted);
    const projected = state.available ? { Available: state.value } : "Unavailable";
    assertKey(step.expected, "state", projected, `step ${index}`);
    assertKey(step.expected, "recomputes", runs, `step ${index}`);
    assertKey(step.expected, "present_count", dependencies.presentCount(), `step ${index}`);
    identity ??= dependencies.handle(fixture.key);
    assert.equal(dependencies.handle(fixture.key), identity);
    assertKey(step.expected, "identity", "wanted-1", `step ${index}`);
  }
});

test("thread-safe and async flavors retain one availability handle", () => {
  const threadSafe = new ThreadSafeDependencyMap(new ThreadSafeContext());
  threadSafe.observeDependency("wanted");
  const threadHandle = threadSafe.handle("wanted");
  threadSafe.publish("wanted", 7);
  assert.deepEqual(threadSafe.observeDependency("wanted"), DependencyAvailability.available(7));
  assert.equal(threadSafe.handle("wanted"), threadHandle);

  const asyncMap = new AsyncDependencyMap(new AsyncContext());
  asyncMap.observeDependency("wanted");
  const asyncHandle = asyncMap.handle("wanted");
  asyncMap.publish("wanted", 9);
  assert.deepEqual(asyncMap.observeDependency("wanted"), DependencyAvailability.available(9));
  assert.equal(asyncMap.handle("wanted"), asyncHandle);
});
