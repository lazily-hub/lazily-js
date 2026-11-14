// The transport-agnostic egress contract (`#lzegress`), replayed against EVERY
// flavor this binding ships — with a ledger that is enforced rather than
// advisory.
//
// lazily-js ships all three: EgressCell / ThreadSafeEgressCell / AsyncEgressCell,
// matching the reactive-egress, egress-thread-safe and egress-async coverage rows
// of ../lazily-spec/coverage.json.
//
// The flavor axis lives in the RUNNER, not the corpus: the fixtures name the
// `EgressCore` model and no execution model, and one model interface replays the
// same JSON against each shell. Nothing on the WRITE side is async-coloured —
// enqueue/claim/ack/fail/retry_now/reconnect return plain values in every flavor.
// The async flavor's READS are awaited only because this binding's AsyncContext
// has no synchronous compute constructor (the obligation
// test/ingress-family-conformance.test.js records for ingress).
//
// The same three guards as the ingress suite keep this from reporting green
// while testing nothing:
//
//  1. The ledger greps src/ for each flavor's class name in BOTH directions, so a
//     row marked shipped whose class does not exist fails, and a class that
//     exists while its row says unshipped fails.
//  2. Every replay RETURNS the number of steps it EXECUTED, and every flavor
//     asserts that count is non-zero and equal to the number of steps LOADED. An
//     unknown `op.type` fails rather than skipping, so no step can be loaded and
//     not run. There is deliberately no hard-coded step floor
//     (#lzcorpusfloorguard): a shrinking corpus is caught upstream by
//     lazily-spec's corpus-counts.json.
//  3. `invalidates` is asserted in BOTH directions through a cache-validity probe
//     per reader kind, so over-invalidation is as visible as under-. The probe is
//     pinned by a test that proves it can fail.
//
// Every step's `returns` outcome AND full projected state (`expected`) are
// asserted through the public API, as transport-egress.md requires.
//
// Mirrors lazily-rs/tests/egress_family_conformance.rs.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertKey, subBlock } from "./support/assert-key.js";
import { Context } from "../src/reactive.js";
import { ThreadSafeContext } from "../src/thread-safe.js";
import { AsyncContext } from "../src/reactive-async.js";
import { EgressCell } from "../src/egress.js";
import { ThreadSafeEgressCell } from "../src/thread-safe-egress.js";
import { AsyncEgressCell } from "../src/async-egress.js";
import {
  EgressAckKind,
  EgressClaimKind,
  EgressFailureKind,
  EgressReconnectKind,
  EgressRetryActionKind,
} from "../src/egress-core.js";

import { specPath } from "./spec-corpus.cjs";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src");

// Named explicitly rather than globbed: a fixture added to the corpus and not to
// this list is a MISSING REPLAY, and the conformance-coverage guard is what
// notices, not a silently shorter run.
const FIXTURES = [
  "egress_ordered_ack.json",
  "egress_inflight_window.json",
  "egress_retry_budget.json",
  "egress_generation_fence.json",
];

const LEDGER = [
  { name: "single-threaded", marker: "class EgressCell", shipped: true },
  { name: "thread-safe", marker: "class ThreadSafeEgressCell", shipped: true },
  { name: "async", marker: "class AsyncEgressCell", shipped: true },
];

// ---------------------------------------------------------------------------
// corpus loading — no bundled-copy fallback (#lzoverrideallrunners)
// ---------------------------------------------------------------------------

function fixtureDir() {
  const candidate = specPath("egress");
  return existsSync(candidate) ? candidate : undefined;
}

function loadFixture(name) {
  const dir = fixtureDir();
  assert.ok(dir !== undefined, "canonical egress corpus not found");
  const path = join(dir, name);
  assert.ok(existsSync(path), `${name}: declared egress fixture is missing`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function sources() {
  let out = "";
  const stack = [SRC];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) stack.push(path);
      else if (entry.endsWith(".js")) out += readFileSync(path, "utf8");
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// wire projection of library values (the corpus spelling)
// ---------------------------------------------------------------------------

function policyOf(raw) {
  return {
    inflightLimit: raw.inflight_limit,
    retryBudget: raw.retry_budget,
    retryBase: raw.retry_base,
    retryCeiling: raw.retry_ceiling,
  };
}

function wireEnvelope(envelope) {
  return {
    generation: envelope.generation,
    sequence: envelope.sequence,
    attempt: envelope.attempt,
    payload: envelope.payload,
  };
}

function wireRetry(retry) {
  if (retry === null) return null;
  return {
    sequence: retry.sequence,
    attempt: retry.attempt,
    backoff: retry.backoff,
    exhausted: retry.exhausted,
  };
}

/**
 * Every outcome kind is mapped explicitly; an unmapped kind FAILS rather than
 * comparing a partial object (#lzscenariobodyskip).
 */
function wireClaim(claim) {
  switch (claim.kind) {
    case EgressClaimKind.Claimed:
      return { claim: claim.kind, envelope: wireEnvelope(claim.envelope) };
    case EgressClaimKind.Empty:
    case EgressClaimKind.WindowFull:
      return { claim: claim.kind };
    case EgressClaimKind.StaleGeneration:
      return { claim: claim.kind, current: claim.current };
    default:
      return assert.fail(`unmapped claim kind \`${claim.kind}\``);
  }
}

function wireAck(ack) {
  switch (ack.kind) {
    case EgressAckKind.Advanced:
    case EgressAckKind.Unchanged:
      return { ack: ack.kind, through: ack.through };
    case EgressAckKind.StaleGeneration:
      return { ack: ack.kind, current: ack.current };
    default:
      return assert.fail(`unmapped ack kind \`${ack.kind}\``);
  }
}

function wireFailure(failure) {
  switch (failure.kind) {
    case EgressFailureKind.Retrying:
    case EgressFailureKind.Exhausted:
      return { failure: failure.kind, retry: wireRetry(failure.retry) };
    case EgressFailureKind.UnknownSequence:
      return { failure: failure.kind };
    case EgressFailureKind.StaleGeneration:
      return { failure: failure.kind, current: failure.current };
    default:
      return assert.fail(`unmapped failure kind \`${failure.kind}\``);
  }
}

function wireRetryAction(action) {
  switch (action.kind) {
    case EgressRetryActionKind.Scheduled:
      return { retry_action: action.kind, sequence: action.sequence };
    case EgressRetryActionKind.UnknownSequence:
      return { retry_action: action.kind };
    case EgressRetryActionKind.StaleGeneration:
      return { retry_action: action.kind, current: action.current };
    default:
      return assert.fail(`unmapped retry action kind \`${action.kind}\``);
  }
}

function wireReconnect(reconnect) {
  switch (reconnect.kind) {
    case EgressReconnectKind.Advanced:
      return {
        reconnect: reconnect.kind,
        generation: reconnect.generation,
        replayed: reconnect.replayed,
      };
    case EgressReconnectKind.Unchanged:
      return { reconnect: reconnect.kind, generation: reconnect.generation };
    case EgressReconnectKind.StaleGeneration:
      return { reconnect: reconnect.kind, current: reconnect.current };
    default:
      return assert.fail(`unmapped reconnect kind \`${reconnect.kind}\``);
  }
}

// ---------------------------------------------------------------------------
// the flavor-neutral model
// ---------------------------------------------------------------------------

/** The two synchronous flavors share a read surface and a cache probe (`isSet`). */
class SyncFlavorModel {
  constructor(ctx, cell) {
    this.ctx = ctx;
    this.cell = cell;
  }
  async pending() {
    return this.cell.pending();
  }
  async inflight() {
    return this.cell.inflight();
  }
  async ackedThrough() {
    return this.cell.ackedThrough();
  }
  async retry() {
    return this.cell.retry();
  }
  isValid(handle) {
    return this.ctx.isSet(handle);
  }
}

class SyncModel extends SyncFlavorModel {
  static flavor = "single-threaded";
  constructor(generation, policy) {
    const ctx = new Context();
    super(ctx, new EgressCell(ctx, generation, policy));
  }
}

class ThreadSafeModel extends SyncFlavorModel {
  static flavor = "thread-safe";
  constructor(generation, policy) {
    const ctx = new ThreadSafeContext();
    super(ctx, new ThreadSafeEgressCell(ctx, generation, policy));
  }
}

class AsyncModel {
  static flavor = "async";
  constructor(generation, policy) {
    this.ctx = new AsyncContext();
    this.cell = new AsyncEgressCell(this.ctx, generation, policy);
  }
  pending() {
    return this.cell.pending();
  }
  inflight() {
    return this.cell.inflight();
  }
  ackedThrough() {
    return this.cell.ackedThrough();
  }
  retry() {
    return this.cell.retry();
  }
  isValid(handle) {
    return this.ctx.isResolved(handle);
  }
}

const MODELS = [SyncModel, ThreadSafeModel, AsyncModel];

// Fixture spelling -> shell handle accessor. The fixture's `invalidates` block is
// descended, so a fifth reader kind added upstream is reported as unconsumed.
const KINDS = [
  ["pending", (cell) => cell.pendingHandle()],
  ["inflight", (cell) => cell.inflightHandle()],
  ["acked_through", (cell) => cell.ackedThroughHandle()],
  ["retry", (cell) => cell.retryHandle()],
];

function validity(model) {
  return Object.fromEntries(
    KINDS.map(([kind, handle]) => [kind, model.isValid(handle(model.cell))]),
  );
}

/** Warm every reader so the next step's probe measures THAT step's invalidation. */
async function materialize(model) {
  await model.pending();
  await model.inflight();
  await model.ackedThrough();
  await model.retry();
}

function runOp(model, op, where) {
  switch (op.type) {
    case "enqueue":
      return { sequence: model.cell.enqueue(op.payload) };
    case "claim":
      return wireClaim(model.cell.claim(op.generation));
    case "ack":
      return wireAck(model.cell.ack(op.generation, op.through));
    case "fail":
      return wireFailure(model.cell.fail(op.generation, op.sequence));
    case "retry_now":
      return wireRetryAction(model.cell.retryNow(op.generation, op.sequence));
    case "reconnect":
      return wireReconnect(model.cell.reconnect(op.generation));
    default:
      return assert.fail(
        `${where}: unknown op \`${op.type}\` — an unknown op must fail, never skip`,
      );
  }
}

async function assertState(model, expected, where) {
  assertKey(expected, "generation", model.cell.generation, `${where}: generation`);
  assertKey(expected, "next_sequence", model.cell.nextSequence, `${where}: next_sequence`);
  assertKey(expected, "pending", (await model.pending()).map(wireEnvelope), `${where}: pending`);
  assertKey(expected, "inflight", (await model.inflight()).map(wireEnvelope), `${where}: inflight`);
  assertKey(expected, "acked_through", await model.ackedThrough(), `${where}: acked_through`);
  assertKey(expected, "retry", wireRetry(await model.retry()), `${where}: retry`);
}

function assertInvalidation(expected, before, after, where) {
  const want = subBlock(expected, "invalidates");
  for (const [kind] of KINDS) {
    assertKey(
      want,
      kind,
      before[kind] && !after[kind],
      `${where}: ${kind} invalidation (was valid=${before[kind]}, now valid=${after[kind]})`,
    );
  }
}

/** Replay one fixture against one flavor; returns the number of steps EXECUTED. */
async function replay(ModelCls, fixture, name) {
  assert.equal(fixture.kind, "Egress", `${name}: fixture kind`);
  assert.equal(fixture.model, "EgressCore", `${name}: fixture model`);
  assert.equal(
    fixture.execution_model,
    undefined,
    `${name}: the corpus must carry NO execution-model field — the flavor axis belongs to the runner`,
  );
  const model = new ModelCls(fixture.generation, policyOf(fixture.policy));
  const label = `${ModelCls.flavor} ${name}`;
  await materialize(model);
  assert.deepEqual(
    validity(model),
    { pending: true, inflight: true, acked_through: true, retry: true },
    `${label}: every reader must be warm before the first step`,
  );

  let steps = 0;
  for (const [index, step] of fixture.steps.entries()) {
    const where = `${label} step ${index} (${step.op.type})`;
    const before = validity(model);
    const returned = runOp(model, step.op, where);
    // The validity snapshot must be taken BEFORE any assertion reads a reader:
    // reading re-warms the cache and would erase the transition under test.
    const after = validity(model);
    assert.deepStrictEqual(returned, step.returns, `${where}: returned outcome`);
    await assertState(model, step.expected, where);
    assertInvalidation(step.expected, before, after, where);
    await materialize(model);
    steps += 1;
  }
  return steps;
}

function corpusStepTotal() {
  return FIXTURES.reduce((total, name) => total + loadFixture(name).steps.length, 0);
}

async function replayCorpus(ModelCls) {
  let steps = 0;
  for (const name of FIXTURES) steps += await replay(ModelCls, loadFixture(name), name);
  return steps;
}

// ---------------------------------------------------------------------------
// the gates
// ---------------------------------------------------------------------------

test("egress corpus is present and every declared fixture carries steps", () => {
  assert.ok(fixtureDir() !== undefined, "canonical egress corpus not found");
  for (const name of FIXTURES) {
    assert.ok(
      loadFixture(name).steps.length > 0,
      `${name}: a fixture with no steps is a vacuous replay`,
    );
  }
});

for (const ModelCls of MODELS) {
  test(`egress: ${ModelCls.flavor} flavor replays the whole corpus`, async () => {
    const steps = await replayCorpus(ModelCls);
    assert.ok(steps > 0, `${ModelCls.flavor}: replayed zero steps`);
    assert.equal(
      steps,
      corpusStepTotal(),
      `every corpus step must run against the ${ModelCls.flavor} flavor`,
    );
  });
}

test("egress ledger: shipped flavors exist and unshipped flavors are really absent", () => {
  const text = sources();
  assert.ok(text.length > 0, "read no sources from src/; the ledger check would be vacuous");
  for (const { name, marker, shipped } of LEDGER) {
    assert.equal(
      text.includes(marker),
      shipped,
      shipped
        ? `flavor "${name}" is recorded as shipped but "${marker}" is not defined in src/`
        : `flavor "${name}" now EXISTS in src/ ("${marker}") but the ledger records it as ` +
            "unshipped; flip the row AND add it to MODELS",
    );
  }
});

test("egress ledger: every shipped row is replayed, and nothing else", () => {
  assert.equal(LEDGER.length, 3, "one row per flavor this family defines");
  const shipped = LEDGER.filter((row) => row.shipped)
    .map((row) => row.name)
    .sort();
  assert.ok(shipped.length > 0, "a ledger of nothing-shipped is not coverage");
  assert.deepEqual(
    MODELS.map((Model) => Model.flavor).sort(),
    shipped,
    "every flavor the ledger calls shipped must appear in MODELS, and nothing else may",
  );
});

// The corpus asserts NEGATIVE invalidation, so the probe itself must be able to
// fail: reading warms the cache, an op that dirties the reader clears it, and one
// that does not leaves it warm.
for (const ModelCls of MODELS) {
  test(`egress: the invalidation probe discriminates (${ModelCls.flavor})`, async () => {
    const model = new ModelCls(
      1,
      policyOf({ inflight_limit: 1, retry_budget: 1, retry_base: 5, retry_ceiling: 20 }),
    );
    await materialize(model);
    assert.deepEqual(validity(model), {
      pending: true,
      inflight: true,
      acked_through: true,
      retry: true,
    });
    model.cell.enqueue(1);
    assert.deepEqual(
      validity(model),
      { pending: false, inflight: true, acked_through: true, retry: true },
      "an enqueue invalidates pending and nothing else",
    );
    await materialize(model);
    assert.equal(model.cell.claim(7).kind, EgressClaimKind.StaleGeneration);
    assert.deepEqual(
      validity(model),
      { pending: true, inflight: true, acked_through: true, retry: true },
      "a stale-generation claim invalidates nothing",
    );
  });
}
