// Canonical generic effect-CAS corpus replay (`#lzeffectcas`), against the pure
// `EffectCasCore` and each of its three reactive shells.
//
// Every scenario's steps are EXECUTED and counted; each step's `returns` outcome
// is compared exactly, and each scenario's `final` per-key state is read back
// through the public API — the snapshot reader of the reactive shells, or
// `snapshot()` on the bare core. An unknown op fails rather than skipping, and
// the executed scenario/step counts are asserted equal to the counts LOADED, so
// no scenario can be parsed and not run (there is no hard-coded floor,
// #lzcorpusfloorguard). Scenarios are booked through `recordScenario` so rung 4
// (`check-scenario-coverage.mjs`) sees each one replayed.
//
// Invariant 2 of docs/durable-sinks.md — a stale generation, unknown attempt, or
// non-matching receipt changes no state and NO READER VERSION — is asserted per
// step on the shells: a refused/no-op outcome must leave the snapshot reader
// warm, and an accepted transition must invalidate it.
//
// Mirrors lazily-rs/tests/effect_cas_conformance.rs.

import assert from "node:assert/strict";
import test from "node:test";

import { AsyncContext } from "../src/reactive-async.js";
import { Context } from "../src/reactive.js";
import { ThreadSafeContext } from "../src/thread-safe.js";
import {
  AsyncEffectCas,
  EffectCas,
  EffectCasAppliedKind,
  EffectCasClaimKind,
  EffectCasCore,
  EffectCasFailureKind,
  EffectCasReconnectKind,
  EffectCasUpsertKind,
  ThreadSafeEffectCas,
  effectIntent,
} from "../src/effect-cas.js";
import { requireFlag } from "./support/assert-key.js";
import { recordScenario } from "./support/scenario.js";
import { loadFixture } from "./spec-corpus.cjs";

const fixture = loadFixture("egress", "effect_cas.json");

// Outcomes that, by contract, mutate nothing and therefore must invalidate no
// reader. Every other outcome is an accepted transition.
const NO_OP = new Set([
  `upsert:${EffectCasUpsertKind.Unchanged}`,
  `upsert:${EffectCasUpsertKind.AlreadyApplied}`,
  `upsert:${EffectCasUpsertKind.StaleEpoch}`,
  `upsert:${EffectCasUpsertKind.EpochConflict}`,
  `claim:${EffectCasClaimKind.Empty}`,
  `claim:${EffectCasClaimKind.Busy}`,
  `claim:${EffectCasClaimKind.Waiting}`,
  `claim:${EffectCasClaimKind.StaleGeneration}`,
  `applied:${EffectCasAppliedKind.Duplicate}`,
  `applied:${EffectCasAppliedKind.UnknownAttempt}`,
  `applied:${EffectCasAppliedKind.StaleGeneration}`,
  `failure:${EffectCasFailureKind.UnknownAttempt}`,
  `failure:${EffectCasFailureKind.StaleGeneration}`,
  `reconnect:${EffectCasReconnectKind.Unchanged}`,
  `reconnect:${EffectCasReconnectKind.StaleGeneration}`,
]);

function wireUpsert(outcome) {
  switch (outcome.kind) {
    case EffectCasUpsertKind.AlreadyApplied:
      return { upsert: outcome.kind, applied_through: outcome.appliedThrough };
    case EffectCasUpsertKind.StaleEpoch:
      return { upsert: outcome.kind, current: outcome.current };
    case EffectCasUpsertKind.Accepted:
    case EffectCasUpsertKind.Unchanged:
    case EffectCasUpsertKind.EpochConflict:
      return { upsert: outcome.kind };
    default:
      return assert.fail(`unmapped upsert kind \`${outcome.kind}\``);
  }
}

function wireClaim(outcome) {
  switch (outcome.kind) {
    case EffectCasClaimKind.Claimed:
      return {
        claim: outcome.kind,
        identity: outcome.attempt.identity.effect,
        step: outcome.attempt.identity.step,
        attempt: outcome.attempt.identity.attempt,
        expected: outcome.attempt.expected,
        payload: outcome.attempt.payload,
      };
    case EffectCasClaimKind.Waiting:
      return { claim: outcome.kind, retry_at: outcome.retryAt };
    case EffectCasClaimKind.StaleGeneration:
      return { claim: outcome.kind, current: outcome.current };
    case EffectCasClaimKind.Empty:
    case EffectCasClaimKind.Busy:
      return { claim: outcome.kind };
    default:
      return assert.fail(`unmapped claim kind \`${outcome.kind}\``);
  }
}

function wireApplied(outcome) {
  switch (outcome.kind) {
    case EffectCasAppliedKind.StepApplied:
      return { applied: outcome.kind, next_step: outcome.nextStep };
    case EffectCasAppliedKind.Completed:
      return { applied: outcome.kind, applied_through: outcome.appliedThrough };
    case EffectCasAppliedKind.StaleGeneration:
      return { applied: outcome.kind, current: outcome.current };
    case EffectCasAppliedKind.Superseded:
    case EffectCasAppliedKind.Duplicate:
    case EffectCasAppliedKind.UnknownAttempt:
      return { applied: outcome.kind };
    default:
      return assert.fail(`unmapped applied kind \`${outcome.kind}\``);
  }
}

function wireFailure(outcome) {
  switch (outcome.kind) {
    case EffectCasFailureKind.Retrying:
      return { failure: outcome.kind, retry_at: outcome.retryAt };
    case EffectCasFailureKind.StaleGeneration:
      return { failure: outcome.kind, current: outcome.current };
    case EffectCasFailureKind.Superseded:
    case EffectCasFailureKind.Rejected:
    case EffectCasFailureKind.UnknownAttempt:
      return { failure: outcome.kind };
    default:
      return assert.fail(`unmapped failure kind \`${outcome.kind}\``);
  }
}

function wireReconnect(outcome) {
  switch (outcome.kind) {
    case EffectCasReconnectKind.Advanced:
      return {
        reconnect: outcome.kind,
        generation: outcome.generation,
        requeued: outcome.requeued,
        superseded: outcome.superseded,
      };
    case EffectCasReconnectKind.Unchanged:
      return { reconnect: outcome.kind, generation: outcome.generation };
    case EffectCasReconnectKind.StaleGeneration:
      return { reconnect: outcome.kind, current: outcome.current };
    default:
      return assert.fail(`unmapped reconnect kind \`${outcome.kind}\``);
  }
}

/** Run one op; returns `[wire outcome, outcome family, claimed attempt identity]`. */
function runStep(target, attempts, op, where) {
  const attempt = () => {
    const saved = attempts.get(op.attempt);
    assert.ok(saved !== undefined, `${where}: attempt label \`${op.attempt}\` was never saved`);
    return saved;
  };
  switch (op.type) {
    case "upsert": {
      const intent = effectIntent({
        identity: op.identity,
        epoch: op.epoch,
        key: op.key,
        expected: op.expected,
        plan: op.plan,
      });
      return [wireUpsert(target.upsertDesired(intent)), "upsert"];
    }
    case "claim": {
      const outcome = target.claim(op.key, op.generation, op.now);
      return [wireClaim(outcome), "claim", outcome.attempt?.identity];
    }
    case "applied":
      return [
        wireApplied(target.recordApplied(op.key, attempt(), op.receipt, op.authority)),
        "applied",
      ];
    case "superseded":
      // The adapter contract: a failed comparison mutated nothing in the backend.
      assert.deepStrictEqual(
        op.backend_after,
        op.backend_before,
        `${where}: zero backend mutation`,
      );
      return [wireFailure(target.recordSuperseded(op.key, attempt(), op.observed)), "failure"];
    case "retryable":
      return [
        wireFailure(target.recordRetryable(op.key, attempt(), op.error, op.retry_at)),
        "failure",
      ];
    case "rejected":
      return [wireFailure(target.recordRejected(op.key, attempt(), op.error)), "failure"];
    case "reconnect":
      return [wireReconnect(target.reconnect(op.generation)), "reconnect"];
    default:
      return assert.fail(`${where}: unknown effect-CAS op \`${op.type}\` — must fail, never skip`);
  }
}

function wireFinal(snapshot) {
  const out = {};
  for (const { key, state } of snapshot.keys) {
    out[key] = {
      pending_identity: state.pending === null ? null : state.pending.intent.identity,
      inflight_identity: state.inflight === null ? null : state.inflight.identity.effect,
      applied_through: state.appliedThrough,
      terminal: state.terminal === null ? null : state.terminal.kind,
      receipt_count: state.terminal === null ? 0 : state.terminal.receipts.length,
      retry_at: state.retry === null ? null : state.retry.retryAt,
    };
  }
  return out;
}

const families = [
  {
    name: "core",
    create: (generation) => {
      // The pure core returns `{change, outcome}`; this replay asserts the
      // outcome and, from the change, that no-op outcomes report no change.
      const core = new EffectCasCore(generation);
      const unwrap =
        (method) =>
        (...args) => {
          const { change, outcome } = core[method](...args);
          core.lastChange = change;
          return outcome;
        };
      const target = Object.fromEntries(
        [
          "upsertDesired",
          "claim",
          "recordApplied",
          "recordSuperseded",
          "recordRetryable",
          "recordRejected",
          "reconnect",
        ].map((method) => [method, unwrap(method)]),
      );
      // "Valid" for the core means "this transition reported no change".
      return {
        target,
        snapshot: async () => core.snapshot(),
        isValid: () => !requireFlag(core.lastChange.state, "EffectCasChange.state"),
        warm: false,
      };
    },
  },
  {
    name: "sync reactive",
    create: (generation) => {
      const ctx = new Context();
      const target = new EffectCas(ctx, generation);
      return {
        target,
        snapshot: async () => target.snapshot(),
        isValid: () => ctx.isSet(target.stateHandle),
      };
    },
  },
  {
    name: "thread-safe reactive",
    create: (generation) => {
      const ctx = new ThreadSafeContext();
      const target = new ThreadSafeEffectCas(ctx, generation);
      return {
        target,
        snapshot: async () => target.snapshot(),
        isValid: () => ctx.isSet(target.stateHandle),
      };
    },
  },
  {
    name: "async reactive",
    create: (generation) => {
      const ctx = new AsyncContext();
      const target = new AsyncEffectCas(ctx, generation);
      return {
        target,
        snapshot: () => target.snapshot(),
        isValid: () => ctx.isResolved(target.stateHandle),
      };
    },
  },
];

function loadedCounts() {
  return {
    scenarios: fixture.scenarios.length,
    steps: fixture.scenarios.reduce((total, scenario) => total + scenario.steps.length, 0),
  };
}

test("effect-CAS corpus is present and every scenario carries steps", () => {
  assert.equal(fixture.kind, "EffectCas");
  assert.equal(fixture.model, "EffectCasCore");
  assert.ok(fixture.scenarios.length > 0, "an effect-CAS corpus with no scenarios is vacuous");
  for (const scenario of fixture.scenarios) {
    assert.ok(scenario.steps.length > 0, `${scenario.id}: a scenario with no steps is vacuous`);
  }
});

for (const family of families) {
  test(`${family.name} replays the EffectCasCore conformance corpus`, async () => {
    let scenarios = 0;
    let steps = 0;
    for (const scenario of fixture.scenarios) {
      recordScenario(scenario);
      const { target, snapshot, isValid, warm } = family.create(scenario.generation);
      const attempts = new Map();
      for (const [index, step] of scenario.steps.entries()) {
        const where = `${family.name} ${scenario.id} step ${index} (${step.op.type})`;
        if (warm !== false) {
          await snapshot();
          assert.ok(isValid(), `${where}: the snapshot reader must be warm before the step`);
        }
        const [returned, family_, claimed] = runStep(target, attempts, step.op, where);
        const stillValid = isValid();
        assert.deepStrictEqual(returned, step.returns, `${where}: returned outcome`);
        if (step.save !== undefined) {
          assert.ok(claimed !== undefined, `${where}: a saved step must claim`);
          attempts.set(step.save, claimed);
        }
        {
          const noOp = NO_OP.has(`${family_}:${returned[family_]}`);
          assert.equal(
            stillValid,
            noOp,
            `${where}: ${noOp ? "a no-op must invalidate no reader" : "a transition must invalidate the state reader"}`,
          );
        }
        steps += 1;
      }
      assert.deepStrictEqual(
        wireFinal(await snapshot()),
        scenario.final,
        `${scenario.id}: final state`,
      );
      scenarios += 1;
    }
    assert.deepEqual(
      { scenarios, steps },
      loadedCounts(),
      "every loaded scenario and step EXECUTED",
    );
  });
}
