// Unit coverage for EffectCasCore beyond the canonical corpus (`#lzeffectcas`):
// the outcomes the corpus does not exercise, logical-clock retry, and the
// durable image / hydrate pair (`#lzeffectcasdurable`), mirroring
// lazily-rs/src/effect_cas_core.rs unit tests and tests/effect_cas_durable.rs.

import assert from "node:assert/strict";
import test from "node:test";

import {
  EffectCasCore,
  EffectCasHydrateError,
  EffectCasHydrateFailure,
  effectIntent,
} from "../src/effect-cas-core.js";

function intent(identity, epoch, key, expected, plan) {
  return effectIntent({ identity, epoch, key, expected, plan });
}

function claimed(core, key, generation, now = 0) {
  const { outcome } = core.claim(key, generation, now);
  assert.equal(outcome.kind, "claimed", `expected a claim, got ${outcome.kind}`);
  return outcome.attempt;
}

test("effect-CAS: upsert refusals are explicit and mutate nothing", () => {
  const core = new EffectCasCore(1);
  assert.equal(core.upsertDesired(intent("a", 2, "doc", 0, ["w"])).outcome.kind, "accepted");
  const same = core.upsertDesired(intent("a", 2, "doc", 0, ["w"]));
  assert.deepEqual([same.change.state, same.outcome.kind], [false, "unchanged"]);
  assert.equal(core.upsertDesired(intent("b", 2, "doc", 0, ["w"])).outcome.kind, "epoch_conflict");
  assert.deepEqual(core.upsertDesired(intent("c", 1, "doc", 0, ["w"])).outcome, {
    kind: "stale_epoch",
    current: 2,
  });
  const attempt = claimed(core, "doc", 1);
  core.recordApplied("doc", attempt.identity, "r", 1);
  assert.deepEqual(core.upsertDesired(intent("d", 2, "doc", 0, ["w"])).outcome, {
    kind: "already_applied",
    appliedThrough: 2,
  });
  assert.throws(() => intent("e", 3, "doc", 0, []), RangeError);
  assert.throws(() => intent("", 3, "doc", 0, ["w"]), TypeError);
});

test("effect-CAS: retry uses the logical clock and a newer desire wins", () => {
  const core = new EffectCasCore(1);
  core.upsertDesired(intent("old", 1, "doc", 1, ["write"]));
  const old = claimed(core, "doc", 1);
  assert.deepEqual(core.recordRetryable("doc", old.identity, "busy", 9).outcome, {
    kind: "retrying",
    retryAt: 9,
  });
  assert.deepEqual(core.pendingKeys(8), []);
  assert.deepEqual(core.pendingKeys(9), ["doc"]);
  assert.deepEqual(core.claim("doc", 1, 8).outcome, { kind: "waiting", retryAt: 9 });
  core.upsertDesired(intent("new", 2, "doc", 2, ["write"]));
  assert.equal(claimed(core, "doc", 1, 8).identity.effect, "new");
});

test("effect-CAS: a stale or unknown attempt never advances the frontier", () => {
  const core = new EffectCasCore(2);
  core.upsertDesired(intent("effect", 4, "doc", 8, ["write"]));
  const attempt = claimed(core, "doc", 2);
  assert.equal(core.recordSuperseded("doc", attempt.identity, 9).outcome.kind, "superseded");
  const late = core.recordApplied("doc", attempt.identity, "late", 10);
  assert.deepEqual([late.change.state, late.outcome.kind], [false, "unknown_attempt"]);
  assert.equal(core.state("doc").appliedThrough, null);
  assert.equal(
    core.recordRejected("missing", attempt.identity, "x").outcome.kind,
    "unknown_attempt",
  );
});

test("effect-CAS: recordOutcome routes every adapter result", () => {
  const core = new EffectCasCore(1);
  core.upsertDesired(intent("a", 1, "a", 0, ["w"]));
  core.upsertDesired(intent("b", 1, "b", 0, ["w"]));
  const a = claimed(core, "a", 1);
  const b = claimed(core, "b", 1);
  assert.equal(
    core.recordOutcome("a", a.identity, { kind: "applied", receipt: "r", authority: 1 }).outcome
      .kind,
    "completed",
  );
  assert.equal(
    core.recordOutcome("b", b.identity, { kind: "retryable", error: "e" }, 4).outcome.kind,
    "retrying",
  );
  assert.throws(() => core.recordOutcome("b", b.identity, { kind: "bogus" }), TypeError);
});

test("effect-CAS: hydrate is lossless for every retained field and behaves identically", () => {
  const core = new EffectCasCore(1);
  // Partial two-step plan: step 0 receipted, step 1 in flight.
  core.upsertDesired(intent("doc#1", 1, "doc", 10, [100, 200]));
  const step0 = claimed(core, "doc", 1);
  core.recordApplied("doc", step0.identity, 1000, 11);
  const step1 = claimed(core, "doc", 1);
  // A newer desired epoch waits behind the in-flight attempt.
  core.upsertDesired(intent("doc#2", 2, "doc", 11, [300]));
  // An independent key sits in logical retry.
  core.upsertDesired(intent("other#1", 1, "other", 0, [1]));
  const retrying = claimed(core, "other", 1);
  core.recordRetryable("other", retrying.identity, "busy", 42);

  // A process boundary: the only thing that survives is the JSON image.
  const image = JSON.parse(JSON.stringify(core.durableState()));
  const restored = EffectCasCore.hydrate(image);
  assert.deepEqual(restored.durableState(), core.durableState());
  assert.deepEqual(restored.snapshot(), core.snapshot());

  // The in-flight attempt is still exactly matchable after the restart.
  for (const target of [core, restored]) {
    assert.deepEqual(target.recordApplied("doc", step1.identity, 2000, 12).outcome, {
      kind: "superseded",
    });
  }
  assert.deepEqual(restored.durableState(), core.durableState());

  // Recovery: reconnect fences the crashed actor and replays the same identity.
  const recovering = EffectCasCore.hydrate(JSON.parse(JSON.stringify(core.durableState())));
  assert.equal(recovering.reconnect(2).outcome.kind, "advanced");
  assert.equal(claimed(recovering, "doc", 2).identity.effect, "doc#2");
  assert.equal(claimed(recovering, "other", 2, 42).identity.effect, "other#1");
});

test("effect-CAS: hydrate refuses a corrupt image instead of repairing it", () => {
  const core = new EffectCasCore(3);
  core.upsertDesired(intent("e", 1, "doc", 0, ["a", "b"]));
  claimed(core, "doc", 3);
  const image = () => JSON.parse(JSON.stringify(core.durableState()));
  const refuses = (mutate, reason) => {
    const bad = image();
    mutate(bad);
    assert.throws(
      () => EffectCasCore.hydrate(bad),
      (error) => error instanceof EffectCasHydrateFailure && error.reason === reason,
      reason,
    );
  };
  refuses((s) => s.keys.push(s.keys[0]), EffectCasHydrateError.DuplicateKey);
  refuses(
    (s) => (s.keys[0].inflight.retained.intent.key = "other"),
    EffectCasHydrateError.KeyMismatch,
  );
  refuses(
    (s) => (s.keys[0].inflight.retained.nextStep = 5),
    EffectCasHydrateError.CursorOutOfRange,
  );
  refuses(
    (s) => (s.keys[0].inflight.attempt.identity.attempt = 9),
    EffectCasHydrateError.AttemptMismatch,
  );
  refuses(
    (s) => (s.keys[0].inflight.attempt.identity.generation = 4),
    EffectCasHydrateError.FutureGeneration,
  );
});
