import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ChartDef, StateChart } from "../src/statechart.js";

const here = dirname(fileURLToPath(import.meta.url));
const specStatechart = join(here, "..", "..", "lazily-spec", "conformance", "statechart");

const FIXTURES = [
  "flat_cycle.json",
  "hierarchical_player.json",
  "guarded_door.json",
  "parallel_regions.json",
  "history_shallow.json",
  "history_deep.json",
  "entry_exit_actions.json",
];

function loadFixture(name) {
  const path = join(specStatechart, name);
  assert.ok(existsSync(path), `statechart fixture ${name} missing from lazily-spec`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function asSortedArray(value) {
  return Array.isArray(value) ? value.slice().sort() : [value];
}

function assertActiveLeaves(chart, expected) {
  const exp = asSortedArray(expected);
  assert.deepEqual(chart.activeLeaves(), exp);
}

/**
 * Replay every statechart conformance fixture from lazily-spec and assert
 * `initial_active`, `initial_actions`, and per-step `accepted`, `active`,
 * `matches`, and `actions`. This is the cross-language behavior contract fixed
 * by `docs/state-charts.md` and the Lean `StateChart` formal model.
 */
for (const name of FIXTURES) {
  test(`statechart conformance: ${name}`, () => {
    const fixture = loadFixture(name);
    assert.equal(fixture.kind, "StateChart");

    const chart = new StateChart(ChartDef.fromChart(fixture.chart));

    assertActiveLeaves(chart, fixture.initial_active);
    if (fixture.initial_actions !== undefined) {
      assert.deepEqual(chart.lastActions(), fixture.initial_actions);
    }

    for (const [index, step] of fixture.steps.entries()) {
      const label = `${name} step ${index} (${step.event})`;
      const accepted = chart.send(step.event, step.guards ?? {});

      assert.equal(accepted, step.accepted, `${label}: accepted`);
      assertActiveLeaves(chart, step.active);

      if (step.matches !== undefined) {
        for (const [id, expected] of Object.entries(step.matches)) {
          assert.equal(chart.matches(id), expected, `${label}: matches(${id})`);
        }
      }
      if (step.actions !== undefined) {
        assert.deepEqual(chart.lastActions(), step.actions, `${label}: actions trace`);
      }
    }
  });
}

test("flat single-region chart resolves transitions via walk-up + LCA", () => {
  const chart = new StateChart(
    ChartDef.fromChart({
      initial: "green",
      states: {
        root: { initial: "green" },
        red: { parent: "root", on: { TICK: "green" } },
        green: { parent: "root", on: { TICK: "yellow" } },
        yellow: { parent: "root", on: { TICK: "red" } },
      },
    }),
  );

  assert.deepEqual(chart.activeLeaves(), ["green"]);
  assert.equal(chart.send("TICK"), true);
  assert.deepEqual(chart.activeLeaves(), ["yellow"]);
  assert.equal(chart.send("UNKNOWN"), false);
  assert.deepEqual(chart.activeLeaves(), ["yellow"]);
  assert.equal(chart.configuration().includes("root"), true);
  assert.equal(chart.matches("green"), false);
});

test("named guards are fail-closed when absent from the guard map", () => {
  const chart = new StateChart(
    ChartDef.fromChart({
      initial: "closed",
      states: {
        root: { initial: "closed" },
        closed: {
          parent: "root",
          on: { OPEN: { target: "open", guard: "allowed" } },
        },
        open: { parent: "root", on: { CLOSE: "closed" } },
      },
    }),
  );

  assert.equal(chart.send("OPEN"), false);
  assert.deepEqual(chart.activeLeaves(), ["closed"]);
  assert.equal(chart.send("OPEN", { allowed: true }), true);
  assert.deepEqual(chart.activeLeaves(), ["open"]);
});

test("unsupported features are rejected explicitly, not silently ignored", () => {
  assert.throws(
    () => ChartDef.fromChart({
      initial: "a",
      states: { root: { initial: "a" }, a: { parent: "root", run: ["doThing"] } },
    }),
    /run/,
  );
  assert.throws(
    () => ChartDef.fromChart({
      initial: "a",
      states: {
        root: { initial: "a" },
        a: { parent: "root", on: { GO: { target: "a", guard: { expr: "x" } } } },
      },
    }),
    /expr/,
  );
});

test("a rejected event clears the action trace and leaves configuration unchanged", () => {
  const chart = new StateChart(
    ChartDef.fromChart({
      initial: "a1",
      states: {
        root: { initial: "a" },
        a: { parent: "root", initial: "a1", entry: ["enterA"] },
        a1: { parent: "a", on: { SWAP: "a2" } },
        a2: { parent: "a" },
      },
    }),
  );

  assert.deepEqual(chart.lastActions(), ["enterA"]);
  assert.equal(chart.send("NOPE"), false);
  assert.deepEqual(chart.lastActions(), []);
  assert.deepEqual(chart.activeLeaves(), ["a1"]);
});
