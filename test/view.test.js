import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";

import { View } from "../src/view.js";
import { fixtureExists, loadFixture, specPath } from "./spec-corpus.cjs";

const FIXTURES = [
  "batch_send.json",
  "counter.json",
  "field_change.json",
  "malformed_rejected.json",
];

function replay(name) {
  const fixture = loadFixture("view", name);
  assert.equal(fixture.kind, "View");
  const view = View.install(fixture.view);
  assert.deepEqual(view.signalsJson(), fixture.signals);
  assert.deepEqual(view.expressionsJson(), fixture.expressions);
  assert.deepEqual(view.layoutJson(), fixture.layout);
  assert.deepEqual(fixture.trace, []);
  assert.deepEqual(view.chartJson(), fixture.chart);
  for (const [index, step] of fixture.steps.entries()) {
    const trace = view.dispatch(step.node, step.event, step.value);
    const label = `${name} step ${index}`;
    assert.deepEqual(view.signalsJson(), step.signals, `${label}: signals`);
    assert.deepEqual(view.expressionsJson(), step.expressions, `${label}: expressions`);
    assert.deepEqual(trace, step.trace, `${label}: trace`);
    assert.deepEqual(view.chartJson(), step.chart, `${label}: chart`);
  }
}

if (!fixtureExists("view")) {
  test("view conformance", { skip: "conformance/view is absent from this spec checkout" }, () => {});
} else {
  test("view fixture set", () => {
    const found = readdirSync(specPath("view"))
      .filter((name) => name.endsWith(".json"))
      .sort();
    assert.deepEqual(found, FIXTURES);
  });

  for (const name of ["counter.json", "field_change.json", "batch_send.json"]) {
    test(`view conformance: ${name}`, () => replay(name));
  }

  test("view malformed corpus is rejected", () => {
    const fixture = loadFixture("view", "malformed_rejected.json");
    assert.ok(fixture.cases.length > 0);
    for (const scenario of fixture.cases) {
      assert.throws(() => View.install(scenario.view), undefined, scenario.name);
    }
  });
}
