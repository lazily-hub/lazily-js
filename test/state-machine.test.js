import assert from "node:assert/strict";
import test from "node:test";

import { Context } from "../src/reactive.js";
import { StateMachine } from "../src/state-machine.js";

const traffic = (s, event) => {
  if (event !== "advance") {
    return null;
  }
  switch (s) {
    case "Red":
      return "Green";
    case "Green":
      return "Yellow";
    case "Yellow":
      return "Red";
    default:
      return null;
  }
};

test("Lean guard_rejection: a rejected event (null) leaves current unchanged", () => {
  const ctx = new Context();
  const m = new StateMachine(ctx, "Red", traffic);
  assert.equal(m.send("unknown"), false);
  assert.equal(m.state, "Red");
});

test("Lean accepted_advances: an accepted Some(next) sets current = next", () => {
  const ctx = new Context();
  const m = new StateMachine(ctx, "Red", traffic);
  assert.equal(m.send("advance"), true);
  assert.equal(m.state, "Green");
  assert.equal(m.send("advance"), true);
  assert.equal(m.state, "Yellow");
});

test("PartialEq no-op suppression: an equal self-transition is accepted but suppresses dependents", () => {
  const ctx = new Context();
  const echo = (s, event) => (event === "echo" ? s : null);
  const m = new StateMachine(ctx, "X", echo);
  const seen = [];
  m.onTransition((old, next) => seen.push([old, next]));

  assert.equal(m.send("echo"), true); // accepted
  assert.equal(m.state, "X"); // unchanged
  assert.deepEqual(seen, []); // NOT fired (cell == guard suppressed)
});

test("onTransition fires with (old, new) on a real state change", () => {
  const ctx = new Context();
  const m = new StateMachine(ctx, "Red", traffic);
  const seen = [];
  m.onTransition((old, next) => seen.push([old, next]));
  m.send("advance");
  assert.deepEqual(seen, [["Red", "Green"]]);
});

test("stateIs is a reactive signal predicate", () => {
  const ctx = new Context();
  const m = new StateMachine(ctx, "Red", traffic);
  const isGreen = m.stateIs("Green");
  assert.equal(ctx.getSignal(isGreen), false);
  m.send("advance");
  assert.equal(ctx.getSignal(isGreen), true); // eager: already materialized
});

test("Lean send_preserves_chart: send never changes the transition function", () => {
  const ctx = new Context();
  const m = new StateMachine(ctx, "Red", traffic);
  m.send("advance");
  m.send("advance");
  assert.equal(m.state, "Yellow");
  assert.equal(m.send("advance"), true);
  assert.equal(m.state, "Red");
  assert.equal(m.send("bogus"), false);
  assert.equal(m.state, "Red");
});

test("reading state reactively invalidates a dependent slot on transition", () => {
  const ctx = new Context();
  const m = new StateMachine(ctx, "Red", traffic);
  const stateView = ctx.computed(() => `state is ${m.state}`);
  assert.equal(ctx.get(stateView), "state is Red");
  m.send("advance");
  assert.equal(ctx.get(stateView), "state is Green"); // recomputed
});

test("batch coalesces multiple sends into one observer fire", () => {
  const ctx = new Context();
  const m = new StateMachine(ctx, "Red", traffic);
  const seen = [];
  m.onTransition((old, next) => seen.push([old, next]));
  ctx.batch(() => {
    m.send("advance"); // Red -> Green
    m.send("advance"); // Green -> Yellow
  });
  assert.deepEqual(seen, [["Red", "Yellow"]]); // net change, one fire
});
