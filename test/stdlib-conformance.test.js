import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import { assertBlock } from "./support/assert-key.js";
import { scenarios } from "./support/scenario.js";
import { RevisionBarrier, Timeout, TimeoutOperation, Timer, TimerError } from "../src/stdlib.js";

import { specPath } from "./spec-corpus.cjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = specPath("stdlib");

/** The three stdlib fixtures, in the order the canonical runner replays them. */
const FIXTURES = ["timer.json", "timeout.json", "revision_barrier.json"];

// 64-bit logical instants do not survive as JS numbers, so the loader quotes any
// 16-or-more-digit literal on its way in and the reviver turns it back into a
// BigInt. `timer.json`'s `duration_overflow_is_typed` carries
// 18446744073709551614, which is why this exists at all.
const readSource = (name) =>
  readFileSync(join(root, name), "utf8").replace(/(:\s*)(\d{16,})(?=\s*[,}])/g, '$1"$2"');
const reviveU64 = (_key, value) =>
  typeof value === "string" && /^\d{16,}$/.test(value) ? BigInt(value) : value;

const load = (name) => JSON.parse(readSource(name), reviveU64);

/**
 * The same bytes, WITHOUT the assertion-key/scenario tracker
 * (#lzstdlibmutantsallbindings).
 *
 * This binding instruments a fixture from inside `JSON.parse`, so unlike
 * lazily-py — which simply skips its `instrument()` call — opting out needs the
 * pristine parser the recorder stashes for exactly this purpose. The independent
 * interpreter below replays every scenario once unperturbed and once per declared
 * operator, and most of those replays are MEANT to diverge; routing them through
 * the tracker would book every `expect` key as READ on a run that is not
 * asserting conformance (leaving it read-but-never-asserted), and would book
 * scenarios as REPLAYED on the strength of the model rather than of the shipped
 * library. The tracked reading of these fixtures is `portable stdlib canonical
 * corpus` below, which replays the production implementation and asserts every
 * key through `assertBlock`.
 */
const loadPlain = (name) => {
  const parse = globalThis.__lazilyConformanceUntrackedParse ?? JSON.parse;
  return parse(readSource(name), reviveU64);
};

function replayTimer(steps) {
  let timer = null;
  for (const step of steps) {
    let actual;
    if (step.op === "start") {
      try {
        timer = new Timer(step.now, step.duration);
        actual = { outcome: "pending", deadline: timer.deadline };
      } catch (error) {
        assert.ok(error instanceof TimerError);
        actual = { outcome: "unavailable", reason: error.reason };
      }
    } else if (step.op === "observe") {
      assert.ok(timer);
      actual = timer.observe(step.now);
    } else {
      // The `else` assumed `observe` (#lzscenariobodyskip): the stdlib corpus
      // `op` union also spells poll/receipt/advance/register_recheck/dispose, so
      // any other op would have been replayed as an observation and its
      // `expect` block compared against the wrong call.
      throw new Error(`unknown stdlib timer op in fixture: ${step.op}`);
    }
    assertExpect(step, actual);
  }
}

function replayTimeout(steps) {
  let timeout = null;
  for (const step of steps) {
    let actual;
    if (step.op === "start") {
      timeout = new Timeout(step.now, step.duration);
      actual = { outcome: "pending", deadline: timeout.deadline };
    } else if (step.op === "poll") {
      let operationCalls = 0;
      let cancellationCalls = 0;
      actual = timeout.poll(
        step.now,
        () => {
          operationCalls += 1;
          // The fall-through assumed `pending` (#lzscenariobodyskip): an
          // unrecognised `operation` spelling made the operation report pending,
          // which silently changes WHICH outcome the `expect` block is compared
          // against.
          if (step.operation === "completed") return TimeoutOperation.completed(step.value);
          if (step.operation === "unavailable") return TimeoutOperation.unavailable();
          if (step.operation === "pending" || step.operation === undefined) {
            return TimeoutOperation.pending();
          }
          throw new Error(`unknown stdlib timeout operation in fixture: ${step.operation}`);
        },
        () => {
          cancellationCalls += 1;
          return step.cancellation;
        },
      );
      actual = {
        ...actual,
        operation_calls: operationCalls,
        cancellation_calls: cancellationCalls,
      };
    } else {
      // The chain had no closing arm (#lzscenariobodyskip): an unmatched `op`
      // left `actual` undefined, and `assertBlock` was then handed nothing to
      // compare the fixture's `expect` block against.
      throw new Error(`unknown stdlib timeout op in fixture: ${step.op}`);
    }
    assertExpect(step, actual);
  }
}

function replayBarrier(steps) {
  let barrier = null;
  for (const step of steps) {
    let calls = 0;
    let actual;
    if (step.op === "start") {
      barrier = new RevisionBarrier(step.revision, step.required_revision, step.deadline);
      actual = barrier.receipt("");
    } else if (step.op === "observe") {
      actual = barrier.observe(step.now, step.predicate, () => {
        calls += 1;
        return step.cancellation;
      });
    } else if (step.op === "register_recheck") {
      actual = barrier.registerRecheck(step.now, step.observed_revision, step.predicate);
    } else if (step.op === "advance") {
      actual = barrier.advance(step.revision, step.predicate);
    } else if (step.op === "dispose") {
      actual = barrier.dispose();
    } else if (step.op === "receipt") {
      actual = barrier.receipt(step.key);
    } else {
      // The `else` assumed `receipt` (#lzscenariobodyskip): any other spelling
      // read a receipt instead of driving the op the fixture named, so the step's
      // `expect` block was compared against a different observation entirely.
      throw new Error(`unknown stdlib revision-barrier op in fixture: ${step.op}`);
    }
    if (step.op === "observe") actual = { ...actual, cancellation_calls: calls };
    assertExpect(step, actual);
  }
}

// Keys really compared against the corpus, counted at the point of comparison so
// `assertion_floor` measures the RUN and not the file. Reset per fixture by the
// canonical replay below.
let assertionsMade = 0;

/** Compare one replayed step against its declared `expect`, and count the keys. */
function assertExpect(step, actual, where) {
  assertionsMade += Object.keys(step.expect).length;
  assertBlock(step.expect, actual, where);
}

test("portable stdlib canonical corpus", () => {
  const runners = new Map([
    ["stdlib_timer_v1", replayTimer],
    ["stdlib_timeout_v1", replayTimeout],
    ["stdlib_revision_barrier_v1", replayBarrier],
  ]);
  for (const name of FIXTURES) {
    const fixture = load(name);
    const scenarioIds = new Set(fixture.scenarios.map((scenario) => scenario.id));

    assertionsMade = 0;
    let replayed = 0;
    for (const scenario of scenarios(fixture)) {
      runners.get(fixture.feature)(scenario.steps);
      replayed += 1;
    }

    for (const mutation of fixture.mutations) {
      assert.ok(mutation.must_fail.length > 0);
      for (const id of mutation.must_fail) assert.ok(scenarioIds.has(id));
    }

    // The three floors are REQUIRED by schemas/stdlib-fixture.schema.json and
    // were read by NOTHING in this binding — a repo-wide grep found zero
    // references, so `scenario_floor: 99` against a six-scenario fixture was
    // green. They are the corpus's own anti-vacuity budget, and the one area
    // whose fixtures carry an explicit "prove you did N things" contract was the
    // one area where nothing checked it (#lzstdlibmutantsallbindings).
    //
    // Each is compared against what this RUN did, never against the file:
    // `replayed` counts scenarios the ledger really yielded and
    // `assertionsMade` is incremented at the comparison itself. A floor computed
    // from the fixture would be a tautology.
    assert.ok(
      replayed >= fixture.scenario_floor,
      `${name}: replayed ${replayed} scenarios, below the declared scenario_floor ${fixture.scenario_floor}`,
    );
    assert.ok(
      assertionsMade >= fixture.assertion_floor,
      `${name}: made ${assertionsMade} assertions, below the declared assertion_floor ${fixture.assertion_floor}`,
    );
    // `mutation_floor` bounds the ledger's SIZE, and that is all it can do.
    // Whether each entry's central claim — "mutating the implementation this way
    // breaks exactly these scenarios" — holds is decided by
    // `every declared stdlib mutation is observed by the independent
    // interpreter` below, which APPLIES every operator.
    assert.ok(
      fixture.mutations.length >= fixture.mutation_floor,
      `${name}: carries ${fixture.mutations.length} mutations, below the declared mutation_floor ${fixture.mutation_floor}`,
    );
  }
});

// ---------------------------------------------------------------------------
// The independent interpreter (#lzstdlibmutantsallbindings)
//
// Each fixture declares a `mutations` ledger: "mutate the implementation THIS
// named way and exactly these scenarios must fail". Nothing here applied any of
// it. The ledger was checked against the fixture's own scenario ids and against
// its own non-emptiness — a claim satisfied by its own bookkeeping — so
// REBINDING an operator to a scenario it does not break stayed green, and the
// central claim of the ledger was untested.
//
// The reference shape is lazily-py `tests/test_stdlib_conformance.py` (ed812ab)
// and lazily-rs `tests/stdlib_conformance.rs` (`independent_failures`). The
// design point worth restating: the operator perturbs an INDEPENDENT model of
// the feature, never the shipped `src/stdlib.js`. Mutating production code to
// test the corpus would test the mutation harness, would need the library to
// carry seams that exist only for tests, and would say nothing about whether the
// corpus can TELL a correct implementation from a wrong one — which is the only
// thing the ledger claims.
// ---------------------------------------------------------------------------

/**
 * The operator under test, consulted BY NAME at every perturbable branch.
 *
 * `consulted` is what makes an unimplemented operator loud rather than silent. A
 * hand-maintained registry of "operators this file implements" would be one more
 * piece of bookkeeping to drift — the same defect one level up — so this set is
 * DERIVED from the branches the replay really evaluated, and an operator no arm
 * knows about ends the run naming itself.
 */
class Mutation {
  constructor(operator) {
    this.operator = operator;
    this.consulted = new Set();
  }

  applies(name) {
    this.consulted.add(name);
    return this.operator === name;
  }
}

const MAX_U64 = (1n << 64n) - 1n;

// Logical time is u64. Most of the corpus fits in a JS number and one scenario
// does not, so arithmetic widens to BigInt only when an operand already is one —
// which keeps every other model output the same NUMBER the fixture carries, and
// `deepStrictEqual` distinguishes 10 from 10n.
const add = (a, b) =>
  typeof a === "bigint" || typeof b === "bigint" ? BigInt(a) + BigInt(b) : a + b;
const larger = (a, b) => (a >= b ? a : b);

/** The step's op, CHECKED against the ops this model implements. */
function modelOp(step, known) {
  const op = step.op;
  if (!known.includes(op)) {
    throw new Error(`unknown model op ${JSON.stringify(op)} (known: ${known.join(", ")})`);
  }
  return op;
}

/** The latched observation: whatever this feature carries, plus no adapter calls. */
function terminal(state, adapterCounts) {
  const result = { outcome: state.status };
  for (const key of ["fired_at", "value", "reason"]) {
    if (key in state) result[key] = state[key];
  }
  if (adapterCounts) {
    result.operation_calls = 0;
    result.cancellation_calls = 0;
  }
  return result;
}

function modelTimer(state, step, mutated) {
  if (modelOp(step, ["start", "observe"]) === "start") {
    const deadline = add(step.now, step.duration);
    if (deadline > MAX_U64) {
      state.status = "unavailable";
      state.reason = "deadline_overflow";
      return terminal(state, false);
    }
    state.status = "pending";
    state.deadline = deadline;
    state.last_now = step.now;
    return { outcome: "pending", deadline };
  }
  if (mutated.applies("fixture_bookkeeping")) {
    return { outcome: "pending", deadline: state.deadline };
  }
  const latched = mutated.applies("terminal_not_latched");
  if (state.status !== "pending" && !latched) return terminal(state, false);
  if (latched) state.status = "pending";
  const now = step.now;
  if (now < state.last_now) {
    return { outcome: "unavailable", reason: "clock_regression", deadline: state.deadline };
  }
  state.last_now = now;
  const deadline = state.deadline;
  const reached = mutated.applies("deadline_strict_greater") ? now > deadline : now >= deadline;
  if (!reached) return { outcome: "pending", deadline };
  state.status = "fired";
  state.fired_at = now;
  return terminal(state, false);
}

function modelTimeout(state, step, mutated) {
  if (modelOp(step, ["start", "poll"]) === "start") {
    const deadline = add(step.now, step.duration);
    if (deadline > MAX_U64) {
      state.status = "unavailable";
      state.reason = "deadline_overflow";
      return terminal(state, false);
    }
    state.status = "pending";
    state.deadline = deadline;
    state.last_now = step.now;
    return { outcome: "pending", deadline };
  }
  if (mutated.applies("fixture_bookkeeping")) {
    return {
      outcome: "pending",
      deadline: state.deadline,
      operation_calls: 0,
      cancellation_calls: 0,
    };
  }
  const latched = mutated.applies("terminal_not_latched");
  if (state.status !== "pending" && !latched) return terminal(state, true);
  if (latched) state.status = "pending";
  const now = step.now;
  const deadline = state.deadline;
  if (now < state.last_now) {
    state.status = "unavailable";
    state.reason = "clock_regression";
    return {
      outcome: "unavailable",
      reason: "clock_regression",
      operation_calls: 0,
      cancellation_calls: 0,
    };
  }
  state.last_now = now;
  const reached = mutated.applies("deadline_strict_greater") ? now > deadline : now >= deadline;
  if (reached) {
    state.status = "timed_out";
    return { outcome: "timed_out", operation_calls: 0, cancellation_calls: 0 };
  }
  // Both drive if-chains whose tail ASSUMES `pending`; validate the spelling so
  // an unknown one names itself instead of quietly meaning "pending"
  // (#lzscenariobodyskip).
  const operation = step.operation;
  if (!["completed", "pending", "unavailable"].includes(operation)) {
    throw new Error(`unknown model operation ${JSON.stringify(operation)}`);
  }
  const cancellation = step.cancellation;
  if (!["cancelled", "pending", "unavailable"].includes(cancellation)) {
    throw new Error(`unknown model cancellation ${JSON.stringify(cancellation)}`);
  }
  if (mutated.applies("cancellation_before_completion") && cancellation === "cancelled") {
    state.status = "cancelled";
    return { outcome: "cancelled", operation_calls: 1, cancellation_calls: 1 };
  }
  if (operation === "completed") {
    state.status = "completed";
    state.value = step.value;
    return {
      outcome: "completed",
      value: step.value,
      operation_calls: 1,
      cancellation_calls: 1,
    };
  }
  if (operation === "unavailable") {
    state.status = "unavailable";
    state.reason = "operation_unavailable";
    return {
      outcome: "unavailable",
      reason: "operation_unavailable",
      operation_calls: 1,
      cancellation_calls: 1,
    };
  }
  if (cancellation === "cancelled") {
    state.status = "cancelled";
    return { outcome: "cancelled", operation_calls: 1, cancellation_calls: 1 };
  }
  if (cancellation === "unavailable") {
    state.status = "unavailable";
    state.reason = "cancellation_unavailable";
    return {
      outcome: "unavailable",
      reason: "cancellation_unavailable",
      operation_calls: 1,
      cancellation_calls: 1,
    };
  }
  return { outcome: "pending", deadline, operation_calls: 1, cancellation_calls: 1 };
}

function barrierObservation(state) {
  const result = {
    outcome: state.status,
    revision: state.revision,
    generation: state.generation,
  };
  if ("reason" in state) result.reason = state.reason;
  return result;
}

function modelBarrier(state, step, mutated) {
  const op = modelOp(step, [
    "start",
    "register_recheck",
    "advance",
    "observe",
    "dispose",
    "receipt",
  ]);
  if (op === "start") {
    state.status = "pending";
    state.revision = step.revision;
    state.generation = 0;
    state.required = step.required_revision;
    state.deadline = step.deadline;
    state.last_now = null;
    return barrierObservation(state);
  }
  if (mutated.applies("fixture_bookkeeping")) {
    state.status = "pending";
    return barrierObservation(state);
  }
  const latched = mutated.applies("terminal_not_latched");
  if (state.status !== "pending" && !latched) {
    const result = barrierObservation(state);
    if (op === "observe") result.cancellation_calls = 0;
    return result;
  }
  if (latched) state.status = "pending";
  if (op === "dispose") {
    state.status = "disposed";
    return barrierObservation(state);
  }
  if (op === "receipt") {
    // An application-owned effect receipt is NOT barrier authority: it wakes the
    // waiter and changes no revision. The operator makes it authority.
    if (mutated.applies("receipt_is_authority")) {
      state.revision = state.required;
      state.generation += 1;
      state.status = "satisfied";
    }
    return barrierObservation(state);
  }
  if (op === "advance") {
    state.revision = larger(state.revision, step.revision);
    state.generation += 1;
    if (state.revision >= state.required && step.predicate === true) state.status = "satisfied";
    return barrierObservation(state);
  }
  const now = step.now;
  const regressed = state.last_now !== null && now < state.last_now;
  if (regressed && !mutated.applies("barrier_accept_clock_regression")) {
    state.status = "unavailable";
    state.reason = "clock_regression";
    const result = barrierObservation(state);
    if (op === "observe") result.cancellation_calls = 0;
    return result;
  }
  state.last_now = now;
  if (op === "register_recheck") {
    state.generation += 1;
    if (!mutated.applies("barrier_skip_post_registration_recheck")) {
      state.revision = larger(state.revision, step.observed_revision);
      if (state.revision >= state.required && step.predicate === true) state.status = "satisfied";
    }
    return barrierObservation(state);
  }
  const deadline = state.deadline;
  let reached;
  if (deadline === null) reached = false;
  else reached = mutated.applies("deadline_strict_greater") ? now > deadline : now >= deadline;
  if (reached) {
    state.status = "timed_out";
    const result = barrierObservation(state);
    result.cancellation_calls = 0;
    return result;
  }
  if (state.revision >= state.required && step.predicate === true) {
    state.status = "satisfied";
    const result = barrierObservation(state);
    result.cancellation_calls = 0;
    return result;
  }
  // Fail-closed tail (#lzscenariobodyskip): a cancellation spelling this model
  // does not know must not behave like `pending`.
  const cancellation = step.cancellation;
  if (cancellation === "cancelled") {
    state.status = "cancelled";
  } else if (cancellation === "unavailable") {
    state.status = "unavailable";
    state.reason = "cancellation_unavailable";
  } else if (cancellation !== "pending") {
    throw new Error(`unknown model cancellation ${JSON.stringify(cancellation)}`);
  }
  const result = barrierObservation(state);
  result.cancellation_calls = 1;
  return result;
}

const MODELS = new Map([
  ["stdlib_timer_v1", modelTimer],
  ["stdlib_timeout_v1", modelTimeout],
  ["stdlib_revision_barrier_v1", modelBarrier],
]);

/**
 * Replay every scenario of `fixture` through the model, perturbed by `operator`.
 *
 * Returns the scenario ids that DIVERGED from their declared `expect`, and the
 * operator names the replay's branches consulted.
 */
function independentFailures(fixture, operator) {
  const model = MODELS.get(fixture.feature);
  if (model === undefined) throw new Error(`unknown stdlib feature ${fixture.feature}`);
  const mutated = new Mutation(operator);
  const failed = new Set();
  for (const scenario of fixture.scenarios) {
    const state = {};
    for (const step of scenario.steps) {
      if (!isDeepStrictEqual(model(state, step, mutated), step.expect)) failed.add(scenario.id);
    }
  }
  return { failed, consulted: mutated.consulted };
}

test("the independent stdlib model reproduces the unperturbed corpus", () => {
  // The non-vacuity control. Without it a mutation proves nothing: a scenario
  // that fails whether or not the operator is applied is not evidence that the
  // operator broke it.
  for (const name of FIXTURES) {
    const fixture = loadPlain(name);
    assert.ok(fixture.scenarios.length > 0, `stdlib/${name}: no scenarios to replay`);
    const { failed } = independentFailures(fixture, null);
    assert.deepStrictEqual(
      [...failed].sort(),
      [],
      `stdlib/${name}: the independent model diverged from the canonical corpus with NO operator applied`,
    );
  }
});

test("every declared stdlib mutation is observed by the independent interpreter", () => {
  let pairs = 0;
  for (const name of FIXTURES) {
    const fixture = loadPlain(name);
    const baseline = independentFailures(fixture, null).failed;
    assert.deepStrictEqual(
      [...baseline].sort(),
      [],
      `stdlib/${name}: the unperturbed replay already fails`,
    );
    assert.ok(fixture.mutations.length > 0, `stdlib/${name}: empty mutation ledger`);
    for (const mutation of fixture.mutations) {
      const operator = mutation.operator;
      const mustFail = [...new Set(mutation.must_fail)];
      assert.ok(mustFail.length > 0, `stdlib/${name}: ${operator} names no scenario`);
      const { failed, consulted } = independentFailures(fixture, operator);
      // An operator with no interpreter arm is a HARD failure, never a skip: a
      // silently unimplemented operator is the same vacuity as a ledger checked
      // against itself.
      assert.ok(
        consulted.has(operator),
        `stdlib/${name}: mutation operator ${JSON.stringify(operator)} is declared by the corpus ` +
          "but no arm of the independent interpreter implements it; the replay consulted " +
          `${JSON.stringify([...consulted].sort())}`,
      );
      const escaped = mustFail.filter((id) => !failed.has(id)).sort();
      assert.deepStrictEqual(
        escaped,
        [],
        `stdlib/${name}: mutation ${JSON.stringify(operator)} did NOT break ${JSON.stringify(escaped)} — ` +
          "the ledger claims those scenarios detect it",
      );
      // Redundant given the empty baseline, but it names the PAIR rather than
      // the fixture when it fires.
      const stillGreen = mustFail.filter((id) => baseline.has(id)).sort();
      assert.deepStrictEqual(
        stillGreen,
        [],
        `stdlib/${name}: ${operator}/${JSON.stringify(stillGreen)} fail with the operator applied ` +
          "AND without it, so the mutation proves nothing",
      );
      pairs += mustFail.length;
    }
    // Every entry contributes at least one (operator, scenario) pair, so the
    // corpus's own `mutation_floor` is also a floor on what this run APPLIED.
    assert.ok(pairs >= fixture.mutation_floor);
  }
  // timer 4 + timeout 5 + revision_barrier 6. A floor, not an equality: the
  // corpus may grow pairs, and this run must never apply fewer than it does
  // today.
  assert.ok(pairs >= 15, `applied only ${pairs} (operator, scenario) pairs`);
});

test("the stdlib mutation complement is not asserted because the corpus does not support it", () => {
  // Some operators break scenarios their ledger entry does not name. The obvious
  // complement — "a scenario NOT named in `must_fail` survives the operator" —
  // is FALSE for this corpus, and asserting it would invent a claim the fixtures
  // never make. `deadline_strict_greater` on `timer.json` also breaks
  // `clock_regression_is_rejected_without_state_change`, whose final step
  // observes exactly at the deadline; `must_fail` is a LOWER BOUND on detection
  // ("these scenarios catch it"), not a partition. lazily-rs makes the same
  // choice (`must_fail.is_subset(&failed)`, not equality), and so does lazily-py.
  //
  // Recorded as a test rather than a comment so the day the corpus DOES become a
  // partition, this stops being true and someone has to decide deliberately
  // whether to tighten the assertion above.
  const fixture = loadPlain("timer.json");
  const { failed } = independentFailures(fixture, "deadline_strict_greater");
  const entry = fixture.mutations.find(
    (mutation) => mutation.operator === "deadline_strict_greater",
  );
  const unnamed = [...failed].filter((id) => !entry.must_fail.includes(id)).sort();
  assert.deepStrictEqual(unnamed, ["clock_regression_is_rejected_without_state_change"]);
});

test("promise adapters are caller-driven and module is browser-safe", async () => {
  const timeout = new Timeout(0, 10);
  const calls = [];
  assert.deepEqual(
    await timeout.pollAsync(
      1,
      async () => {
        calls.push("operation");
        return TimeoutOperation.completed("async");
      },
      async () => {
        calls.push("cancellation");
        return "pending";
      },
    ),
    { outcome: "completed", value: "async" },
  );
  assert.deepEqual(calls, ["operation", "cancellation"]);
  assert.equal(readFileSync(join(here, "..", "src", "stdlib.js"), "utf8").includes("node:"), false);
});

test("logical Number inputs must be safe integers; bigint preserves full uint64", () => {
  const unsafe = Number.MAX_SAFE_INTEGER + 1;
  assert.throws(() => new Timer(unsafe, 0), /safe integer or bigint/);
  assert.throws(() => new Timeout(0, unsafe), /safe integer or bigint/);
  assert.throws(() => new RevisionBarrier(0, unsafe), /safe integer or bigint/);

  const exact = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  const timer = new Timer(exact, 0n);
  assert.equal(timer.deadline, exact);
  assert.deepEqual(timer.observe(exact), { outcome: "fired", fired_at: exact });

  const barrier = new RevisionBarrier(0n, exact);
  assert.throws(() => barrier.advance(unsafe, false), /safe integer or bigint/);
  assert.deepEqual(barrier.advance(exact, true), {
    outcome: "satisfied",
    revision: exact,
    generation: 1,
  });
});

test("barrier rejects regressed clocks without cancellation and latches", () => {
  const barrier = new RevisionBarrier(0, 2, null);
  let cancellationCalls = 0;
  const pending = () => {
    cancellationCalls += 1;
    return "pending";
  };

  assert.equal(barrier.observe(5, false, pending).outcome, "pending");
  assert.deepEqual(barrier.observe(4, false, pending), {
    outcome: "unavailable",
    reason: "clock_regression",
    revision: 0,
    generation: 0,
  });
  assert.equal(cancellationCalls, 1);

  assert.deepEqual(barrier.registerRecheck(4, 2, true), {
    outcome: "unavailable",
    reason: "clock_regression",
    revision: 0,
    generation: 0,
  });
  assert.deepEqual(barrier.advance(2, true), {
    outcome: "unavailable",
    reason: "clock_regression",
    revision: 0,
    generation: 0,
  });
});

test("sync adapters preserve a reentrant first terminal result", () => {
  const timeout = new Timeout(0, 10);
  const outer = timeout.poll(
    1,
    () => {
      assert.deepEqual(
        timeout.poll(
          2,
          () => TimeoutOperation.completed("first"),
          () => "pending",
        ),
        { outcome: "completed", value: "first" },
      );
      return TimeoutOperation.pending();
    },
    () => "cancelled",
  );
  assert.deepEqual(outer, { outcome: "completed", value: "first" });

  const barrier = new RevisionBarrier(0, 1, null);
  assert.equal(
    barrier.observe(0, false, () => {
      assert.equal(barrier.dispose().outcome, "disposed");
      return "cancelled";
    }).outcome,
    "disposed",
  );
  assert.equal(barrier.receipt("").outcome, "disposed");
});

test("promise adapters start together and preserve reentrant terminal state", async () => {
  const timeout = new Timeout(0, 10);
  const calls = [];
  let releaseOperation;
  const operationResult = new Promise((resolve) => {
    releaseOperation = resolve;
  });
  const poll = timeout.pollAsync(
    1,
    () => {
      calls.push("operation");
      return operationResult;
    },
    async () => {
      calls.push("cancellation");
      return "cancelled";
    },
  );
  await Promise.resolve();
  assert.deepEqual(calls, ["operation", "cancellation"]);
  releaseOperation(TimeoutOperation.pending());
  assert.deepEqual(await poll, { outcome: "cancelled" });

  const barrier = new RevisionBarrier(0, 1, null);
  assert.equal(
    (
      await barrier.observeAsync(0, false, async () => {
        barrier.dispose();
        return "cancelled";
      })
    ).outcome,
    "disposed",
  );
});
