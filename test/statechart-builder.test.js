import assert from "node:assert/strict";
import test from "node:test";

import { ChartBuilder, ChartDef, StateBuilder, StateChart } from "../src/statechart.js";

// A parallel root over two regions, one guarded transition, one final leaf.
const jsonSrc = {
  initial: "root",
  states: {
    root: { parallel: true },
    flow: { parent: "root", initial: "idle" },
    idle: { parent: "flow", on: { go: { target: "done", guard: "ready" } } },
    done: { parent: "flow", kind: "final" },
    net: { parent: "root", initial: "up" },
    up: { parent: "net", on: { drop: { target: "down" } } },
    down: { parent: "net", on: { restore: { target: "up" } } },
  },
};

function builtChart() {
  return new ChartBuilder()
    .state(StateBuilder.parallel("root"))
    .state(StateBuilder.compound("flow", "idle").parent("root"))
    .state(StateBuilder.atomic("idle").parent("flow").onGuarded("go", "done", "ready"))
    .state(StateBuilder.final("done").parent("flow"))
    .state(StateBuilder.compound("net", "up").parent("root"))
    .state(StateBuilder.atomic("up").parent("net").on("drop", "down"))
    .state(StateBuilder.atomic("down").parent("net").on("restore", "up"))
    .build();
}

const sorted = (set) => [...set].sort();

test("ChartBuilder produces a chart behaviourally identical to fromChart", () => {
  const cj = new StateChart(ChartDef.fromChart(jsonSrc));
  const cb = new StateChart(builtChart());
  assert.deepEqual(sorted(cj.configuration()), sorted(cb.configuration()));

  // Guard false: rejected on both.
  assert.equal(cj.send("go", { ready: false }), cb.send("go", { ready: false }));
  assert.deepEqual(sorted(cj.configuration()), sorted(cb.configuration()));

  // Orthogonal region transition on both.
  assert.equal(cj.send("drop"), true);
  assert.equal(cb.send("drop"), true);

  // Guard true: accepted on both, identical resulting configuration.
  assert.equal(cj.send("go", { ready: true }), true);
  assert.equal(cb.send("go", { ready: true }), true);
  assert.deepEqual(sorted(cj.configuration()), sorted(cb.configuration()));
  assert.equal(cb.matches("done"), true);
  assert.equal(cb.matches("down"), true);
});

test("ChartBuilder rejects a duplicate state id", () => {
  assert.throws(
    () =>
      new ChartBuilder()
        .state(StateBuilder.parallel("root"))
        .state(StateBuilder.atomic("dup").parent("root"))
        .state(StateBuilder.atomic("dup").parent("root"))
        .build(),
    /duplicate state id/,
  );
});
