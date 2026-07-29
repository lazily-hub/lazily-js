import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  RevisionBarrier,
  Timeout,
  TimeoutOperation,
  Timer,
  TimerError,
} from "../src/stdlib.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "lazily-spec", "conformance", "stdlib");
const load = (name) => {
  const source = readFileSync(join(root, name), "utf8").replace(
    /(:\s*)(\d{16,})(?=\s*[,}])/g,
    '$1"$2"',
  );
  return JSON.parse(source, (_key, value) =>
    typeof value === "string" && /^\d{16,}$/.test(value) ? BigInt(value) : value,
  );
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
    } else {
      assert.ok(timer);
      actual = timer.observe(step.now);
    }
    assert.deepEqual(actual, step.expect);
  }
}

function replayTimeout(steps) {
  let timeout = null;
  for (const step of steps) {
    let actual;
    if (step.op === "start") {
      timeout = new Timeout(step.now, step.duration);
      actual = { outcome: "pending", deadline: timeout.deadline };
    } else {
      let operationCalls = 0;
      let cancellationCalls = 0;
      actual = timeout.poll(
        step.now,
        () => {
          operationCalls += 1;
          if (step.operation === "completed") return TimeoutOperation.completed(step.value);
          if (step.operation === "unavailable") return TimeoutOperation.unavailable();
          return TimeoutOperation.pending();
        },
        () => {
          cancellationCalls += 1;
          return step.cancellation;
        },
      );
      actual = { ...actual, operation_calls: operationCalls, cancellation_calls: cancellationCalls };
    }
    assert.deepEqual(actual, step.expect);
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
    } else {
      actual = barrier.receipt(step.key);
    }
    if (step.op === "observe") actual = { ...actual, cancellation_calls: calls };
    assert.deepEqual(actual, step.expect);
  }
}

test("portable stdlib canonical corpus", () => {
  const runners = new Map([
    ["stdlib_timer_v1", replayTimer],
    ["stdlib_timeout_v1", replayTimeout],
    ["stdlib_revision_barrier_v1", replayBarrier],
  ]);
  for (const name of ["timer.json", "timeout.json", "revision_barrier.json"]) {
    const fixture = load(name);
    const scenarios = new Set(fixture.scenarios.map((scenario) => scenario.id));
    for (const scenario of fixture.scenarios) runners.get(fixture.feature)(scenario.steps);
    for (const mutation of fixture.mutations) {
      assert.ok(mutation.must_fail.length > 0);
      for (const id of mutation.must_fail) assert.ok(scenarios.has(id));
    }
  }
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
