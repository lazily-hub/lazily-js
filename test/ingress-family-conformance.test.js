// The transport-agnostic ingress contract (`#designimplementtransport`), replayed
// against EVERY flavor this binding ships — with a ledger that is *enforced*
// rather than advisory.
//
// lazily-js ships all three: IngressCell / ThreadSafeIngressCell /
// AsyncIngressCell, matching the three README coverage rows and the contract
// ../lazily-spec/docs/transport-ingress.md declares REQUIRED of every binding x
// every flavor.
//
// The flavor axis lives in the RUNNER, not the corpus: the fixtures carry a
// `model` field naming the primitive and no execution-model field, and one model
// interface replays the same JSON against each shell. Nothing in the interface is
// async-coloured on the WRITE side — that is the finding, not an oversight: an
// admission decision is a function of the fence, the watermark, the reorder
// buffer, and the observed clock, so there is nothing to await. The async
// flavor's READS are async-coloured, purely because this binding's AsyncContext
// has no synchronous compute constructor (the same single obligation
// test/collections-family-conformance.test.js records for the map family), so
// every read below is awaited and the two synchronous flavors simply resolve
// immediately.
//
// Three things keep this suite from reporting green while testing nothing — each
// one a failure mode this family of suites has actually shipped:
//
//  1. `unshipped flavors are really absent` greps src/ for each flavor's class
//     name, in BOTH directions. A ledger row marked shipped whose class does not
//     exist fails; a class that exists while its row says unshipped fails and
//     names the runner to extend. The ledger cannot rot, because the filesystem
//     enforces it.
//  2. Every replay RETURNS its step count, and every flavor asserts the count is
//     non-zero and equal to the corpus total. An absence guard proves the
//     fixtures exist on disk; only a positive count proves this process opened
//     them.
//  3. `invalidates` is asserted in BOTH directions through a cache-validity probe
//     per reader kind. A step expecting `false` fails if the shell invalidated
//     anyway, so over-invalidation is as visible as under-. The probe itself is
//     pinned by a test that proves it can fail.
//
// `invalidates` is asserted PER CHANNEL, never by receipt count: a stale cache
// recomputes to the right count, so a count-only gate reports green.
//
// Mirrors lazily-rs/tests/ingress_family_conformance.rs.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Context } from "../src/reactive.js";
import { ThreadSafeContext } from "../src/thread-safe.js";
import { AsyncContext } from "../src/reactive-async.js";
import { IngressCell } from "../src/ingress.js";
import { ThreadSafeIngressCell } from "../src/thread-safe-ingress.js";
import { AsyncIngressCell } from "../src/async-ingress.js";
import {
  IngressAdmissionKind,
  IngressDropReason,
  IngressError,
  IngressLifecycle,
  IngressReadiness,
  IngressTransportKind,
  ingressEnvelope,
} from "../src/ingress-core.js";
import { KeepLatest, Sum } from "../src/merge.js";
import { Overflow } from "../src/relay.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src");

// Named explicitly rather than globbed: a fixture added to the corpus and not to
// this list is a MISSING REPLAY, and the conformance-coverage guard is what
// should notice, not a silently shorter run.
const FIXTURES = [
  "ingress_ordered_delivery.json",
  "ingress_reorder_and_duplication.json",
  "ingress_reorder_window_overflow.json",
  "ingress_disconnect_replay.json",
  "ingress_backpressure.json",
  "ingress_generation_handoff.json",
  "ingress_freshness_and_retry.json",
];

// The marker is grepped, not imported: a ledger you cannot write until the work
// is done is no ledger at all, and an import of a missing class throws at module
// load rather than failing one assertion.
const LEDGER = [
  { name: "single-threaded", marker: "class IngressCell", shipped: true },
  { name: "thread-safe", marker: "class ThreadSafeIngressCell", shipped: true },
  { name: "async", marker: "class AsyncIngressCell", shipped: true },
];

// ---------------------------------------------------------------------------
// corpus loading
// ---------------------------------------------------------------------------

function fixtureDir() {
  for (const candidate of [
    join(here, "..", "..", "lazily-spec", "conformance", "ingress"),
    join(here, "conformance", "ingress"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function loadFixture(name) {
  const dir = fixtureDir();
  assert.ok(dir !== undefined, "canonical ingress corpus not found");
  const path = join(dir, name);
  assert.ok(existsSync(path), `${name}: declared ingress fixture is missing`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function sources() {
  let out = "";
  const stack = [SRC];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        stack.push(path);
      } else if (entry.endsWith(".js")) {
        out += readFileSync(path, "utf8");
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// fixture decoding — an unknown member must FAIL, never fall through
// ---------------------------------------------------------------------------

/**
 * Look a corpus spelling up in the library's own enum. The library and the
 * corpus deliberately share spellings, so this is not a translation table; it is
 * the guard that a corpus which grows a new variant fails loudly here instead of
 * silently comparing unequal somewhere downstream.
 */
function member(table, text, what) {
  const known = Object.values(table);
  assert.ok(known.includes(text), `unknown ${what} \`${text}\` (known: ${known.join(", ")})`);
  return text;
}

const OVERFLOW_BY_LABEL = Object.freeze({
  block: Overflow.Block,
  drop_newest: Overflow.DropNewest,
  drop_oldest: Overflow.DropOldest,
  conflate: Overflow.Conflate,
  spill: Overflow.Spill,
});

function overflowOf(text) {
  const mapped = OVERFLOW_BY_LABEL[text];
  assert.ok(mapped !== undefined, `unknown overflow \`${text}\``);
  return mapped;
}

const MERGE_BY_LABEL = Object.freeze({ sum: Sum, keep_latest: KeepLatest });

function mergeOf(text) {
  const mapped = MERGE_BY_LABEL[text];
  assert.ok(mapped !== undefined, `unknown merge \`${text}\``);
  return mapped;
}

function policyOf(raw) {
  return {
    reorderWindow: raw.reorder_window,
    freshnessHorizon: raw.freshness_horizon,
    highWater: raw.high_water,
    overflow: overflowOf(raw.overflow),
    receiptCapacity: raw.receipt_capacity,
    retryBase: raw.retry_base,
    retryCeiling: raw.retry_ceiling,
  };
}

function expectedAdmission(raw) {
  const kind = member(IngressAdmissionKind, raw.admission, "admission");
  switch (kind) {
    case IngressAdmissionKind.Accepted:
    case IngressAdmissionKind.Conflated:
      return { kind, deliveredThrough: raw.delivered_through };
    case IngressAdmissionKind.Buffered:
      return { kind, gapFrom: raw.gap_from };
    case IngressAdmissionKind.GenerationHandoff:
      return { kind, from: raw.from, to: raw.to };
    case IngressAdmissionKind.Dropped:
      return { kind, reason: member(IngressDropReason, raw.reason, "drop reason") };
    default:
      return { kind };
  }
}

function expectedReplay(raw) {
  if (raw === null || raw === undefined) return null;
  return { generation: raw.generation, fromSequence: raw.from_sequence };
}

// ---------------------------------------------------------------------------
// the flavor-neutral model
// ---------------------------------------------------------------------------
//
// The reader-kind probes (`*IsValid`) are the whole reason this is an interface
// rather than three copies of the runner: `invalidates` is a claim about the
// GRAPH, and only the shell can answer it.

/**
 * The two synchronous flavors differ only in which context and which shell they
 * build; their read surface and their cache probe (`isSet`) are identical. One
 * base with an injected builder keeps that identity a fact rather than a hope —
 * two hand-copied runners are how a flavor quietly stops being tested.
 */
class SyncFlavorModel {
  constructor(build, policy, merge, transport, pollInterval) {
    const { ctx, cell } = build(policy, merge, transport, pollInterval);
    this.ctx = ctx;
    this.cell = cell;
  }

  open(key, generation) {
    this.cell.open(key, generation);
  }
  admit(envelope) {
    return this.cell.admit(envelope);
  }
  suspend(key) {
    return this.cell.suspend(key);
  }
  reconnect(key, generation) {
    return this.cell.reconnect(key, generation);
  }
  close(key) {
    this.cell.close(key);
  }
  fail(key, error) {
    this.cell.fail(key, error);
  }
  tick(now) {
    this.cell.tick(now);
  }
  drain(key) {
    return this.cell.drain(key);
  }

  async value(key) {
    return this.cell.value(key);
  }
  async readiness(key) {
    return this.cell.readiness(key);
  }
  async authority(key) {
    return this.cell.authority(key);
  }
  async retry(key) {
    return this.cell.retry(key);
  }
  async acceptedLen() {
    return this.cell.accepted().length;
  }
  async droppedLen() {
    return this.cell.dropped().length;
  }
  async errorsLen() {
    return this.cell.errors().length;
  }
  async schedule() {
    return this.cell.schedule();
  }

  valueIsValid(key) {
    return this.ctx.isSet(this.cell.valueHandle(key));
  }
  readinessIsValid(key) {
    return this.ctx.isSet(this.cell.readinessHandle(key));
  }
  authorityIsValid(key) {
    return this.ctx.isSet(this.cell.authorityHandle(key));
  }
  retryIsValid(key) {
    return this.ctx.isSet(this.cell.retryHandle(key));
  }
  acceptedIsValid() {
    return this.ctx.isSet(this.cell.acceptedHandle());
  }
  droppedIsValid() {
    return this.ctx.isSet(this.cell.droppedHandle());
  }
  errorsIsValid() {
    return this.ctx.isSet(this.cell.errorsHandle());
  }

  view(key) {
    return this.cell.view(key);
  }
}

class SyncModel extends SyncFlavorModel {
  static flavor = "single-threaded";

  constructor(policy, merge, transport, pollInterval) {
    super(
      (p, m, t, i) => {
        const ctx = new Context();
        return { ctx, cell: new IngressCell(ctx, { policy: p, merge: m, transport: t, pollInterval: i }) };
      },
      policy,
      merge,
      transport,
      pollInterval,
    );
  }
}

class ThreadSafeModel extends SyncFlavorModel {
  static flavor = "thread-safe";

  constructor(policy, merge, transport, pollInterval) {
    super(
      (p, m, t, i) => {
        const ctx = new ThreadSafeContext();
        return {
          ctx,
          cell: new ThreadSafeIngressCell(ctx, {
            policy: p,
            merge: m,
            transport: t,
            pollInterval: i,
          }),
        };
      },
      policy,
      merge,
      transport,
      pollInterval,
    );
  }
}

class AsyncModel {
  static flavor = "async";

  constructor(policy, merge, transport, pollInterval) {
    this.ctx = new AsyncContext();
    this.cell = new AsyncIngressCell(this.ctx, { policy, merge, transport, pollInterval });
  }

  // Writes stay synchronous: admission is not async-coloured.
  open(key, generation) {
    this.cell.open(key, generation);
  }
  admit(envelope) {
    return this.cell.admit(envelope);
  }
  suspend(key) {
    return this.cell.suspend(key);
  }
  reconnect(key, generation) {
    return this.cell.reconnect(key, generation);
  }
  close(key) {
    this.cell.close(key);
  }
  fail(key, error) {
    this.cell.fail(key, error);
  }
  tick(now) {
    this.cell.tick(now);
  }
  drain(key) {
    return this.cell.drain(key);
  }

  value(key) {
    return this.cell.value(key);
  }
  readiness(key) {
    return this.cell.readiness(key);
  }
  authority(key) {
    return this.cell.authority(key);
  }
  retry(key) {
    return this.cell.retry(key);
  }
  async acceptedLen() {
    return (await this.cell.accepted()).length;
  }
  async droppedLen() {
    return (await this.cell.dropped()).length;
  }
  async errorsLen() {
    return (await this.cell.errors()).length;
  }
  schedule() {
    return this.cell.schedule();
  }

  valueIsValid(key) {
    return this.ctx.isResolved(this.cell.valueHandle(key));
  }
  readinessIsValid(key) {
    return this.ctx.isResolved(this.cell.readinessHandle(key));
  }
  authorityIsValid(key) {
    return this.ctx.isResolved(this.cell.authorityHandle(key));
  }
  retryIsValid(key) {
    return this.ctx.isResolved(this.cell.retryHandle(key));
  }
  acceptedIsValid() {
    return this.ctx.isResolved(this.cell.acceptedHandle());
  }
  droppedIsValid() {
    return this.ctx.isResolved(this.cell.droppedHandle());
  }
  errorsIsValid() {
    return this.ctx.isResolved(this.cell.errorsHandle());
  }

  view(key) {
    return this.cell.view(key);
  }
}

const MODELS = [SyncModel, ThreadSafeModel, AsyncModel];

const KINDS = ["value", "readiness", "authority", "retry"];
const CHANNELS = ["accepted", "dropped", "error"];

/** Cache-validity snapshot of every reader kind the fixture can speak about. */
function snapshotValidity(model, keys) {
  const scopes = new Map();
  for (const key of keys) {
    scopes.set(key, {
      value: model.valueIsValid(key),
      readiness: model.readinessIsValid(key),
      authority: model.authorityIsValid(key),
      retry: model.retryIsValid(key),
    });
  }
  return {
    scopes,
    receipts: {
      accepted: model.acceptedIsValid(),
      dropped: model.droppedIsValid(),
      error: model.errorsIsValid(),
    },
  };
}

/**
 * Read every reader kind, so the caches are warm and the next step's validity
 * probe measures THAT step's invalidation and nothing else.
 */
async function materialize(model, keys) {
  for (const key of keys) {
    await model.value(key);
    await model.readiness(key);
    await model.authority(key);
    await model.retry(key);
  }
  await model.acceptedLen();
  await model.droppedLen();
  await model.errorsLen();
  await model.schedule();
}

async function assertState(model, step, where) {
  const expected = step.expected;
  for (const [key, want] of Object.entries(expected.scopes)) {
    const view = model.view(key);
    assert.ok(view !== null, `${where}: scope ${key} absent`);
    assert.equal(
      view.lifecycle,
      member(IngressLifecycle, want.lifecycle, "lifecycle"),
      `${where}: ${key} lifecycle`,
    );
    assert.equal(view.generation, want.generation, `${where}: ${key} generation`);
    assert.equal(
      view.deliveredThrough,
      want.delivered_through === undefined ? null : want.delivered_through,
      `${where}: ${key} watermark`,
    );
    assert.equal(view.buffered, want.buffered, `${where}: ${key} buffered`);
    assert.equal(
      view.consecutiveErrors,
      want.consecutive_errors,
      `${where}: ${key} consecutive errors`,
    );
    assert.equal(await model.value(key), want.window, `${where}: ${key} window`);
    assert.equal(
      await model.readiness(key),
      member(IngressReadiness, want.readiness, "readiness"),
      `${where}: ${key} readiness`,
    );
    const authority = await model.authority(key);
    if (want.authority === null) {
      assert.equal(authority, null, `${where}: ${key} authority`);
    } else {
      assert.deepEqual(
        authority,
        {
          generation: want.authority.generation,
          deliveredThrough:
            want.authority.delivered_through === undefined
              ? null
              : want.authority.delivered_through,
          stampedAt: want.authority.stamped_at,
        },
        `${where}: ${key} authority`,
      );
    }
    const retry = await model.retry(key);
    if (want.retry === null) {
      assert.equal(retry, null, `${where}: ${key} retry`);
    } else {
      assert.deepEqual(
        retry,
        {
          attempt: want.retry.attempt,
          backoff: want.retry.backoff,
          resumeFrom: want.retry.resume_from,
        },
        `${where}: ${key} retry`,
      );
    }
  }

  const receipts = expected.receipts;
  assert.equal(await model.acceptedLen(), receipts.accepted, `${where}: accepted receipts`);
  assert.equal(await model.droppedLen(), receipts.dropped, `${where}: dropped receipts`);
  assert.equal(await model.errorsLen(), receipts.error, `${where}: error receipts`);
}

/**
 * Assert `invalidates` in both directions. `true` means the reader's cache went
 * from valid to invalid across the op; `false` means it stayed valid.
 */
function assertInvalidation(step, before, after, where) {
  const want = step.expected.invalidates;
  assert.ok(want, `${where}: expected.invalidates is missing — the matrix IS the contract`);
  assert.equal(
    step.invalidates,
    undefined,
    `${where}: \`invalidates\` appears at STEP level; this runner reads ` +
      "expected.invalidates, so a step-level copy would be silently ignored",
  );
  for (const [key, wantScope] of Object.entries(want.scopes)) {
    const beforeScope = before.scopes.get(key);
    const afterScope = after.scopes.get(key);
    assert.ok(beforeScope && afterScope, `${where}: ${key} was never probed`);
    for (const kind of KINDS) {
      const expectedFlag = wantScope[kind];
      assert.equal(
        typeof expectedFlag,
        "boolean",
        `${where}: ${key}.${kind} has no invalidation flag`,
      );
      const invalidated = beforeScope[kind] && !afterScope[kind];
      assert.equal(
        invalidated,
        expectedFlag,
        `${where}: ${key}.${kind} invalidation (was valid=${beforeScope[kind]}, ` +
          `now valid=${afterScope[kind]})`,
      );
    }
  }
  for (const channel of CHANNELS) {
    const expectedFlag = want.receipts[channel];
    assert.equal(
      typeof expectedFlag,
      "boolean",
      `${where}: receipts.${channel} has no invalidation flag`,
    );
    const invalidated = before.receipts[channel] && !after.receipts[channel];
    assert.equal(
      invalidated,
      expectedFlag,
      `${where}: receipts.${channel} invalidation — asserted per channel, never by ` +
        "receipt COUNT: a stale cache recomputes to the right count",
    );
  }
}

/**
 * Replay one fixture against one flavor. Returns the number of steps executed,
 * so a caller can prove this process really opened the corpus.
 */
async function replay(ModelCls, fixture, name) {
  const model = new ModelCls(
    policyOf(fixture.policy),
    mergeOf(fixture.merge),
    member(IngressTransportKind, fixture.transport, "transport"),
    fixture.poll_interval,
  );
  const label = `${ModelCls.flavor} ${name}`;

  // Every key the fixture ever mentions, so a reader exists (and is probed) from
  // the first step — an absent reader would silently pass a `false` expectation.
  const keys = [];
  for (const step of fixture.steps) {
    for (const key of [step.op.key, ...Object.keys(step.expected.scopes ?? {})]) {
      if (typeof key === "string" && !keys.includes(key)) keys.push(key);
    }
  }
  assert.ok(keys.length > 0, `${label}: fixture names no scope keys`);

  await materialize(model, keys);
  let steps = 0;

  for (const [index, step] of fixture.steps.entries()) {
    const op = step.op;
    const where = `${label} step ${index} (${op.type})`;
    const before = snapshotValidity(model, keys);

    switch (op.type) {
      case "admit": {
        const admission = model.admit(
          ingressEnvelope(op.key, op.generation, op.sequence, op.stamped_at, op.payload),
        );
        if (step.returns !== undefined) {
          assert.deepEqual(admission, expectedAdmission(step.returns), `${where}: admission`);
        }
        break;
      }
      case "open":
        model.open(op.key, op.generation);
        break;
      case "drain": {
        const drained = model.drain(op.key);
        if (step.returns !== undefined) {
          assert.equal(drained, step.returns.drained, `${where}: drained value`);
        }
        break;
      }
      case "suspend": {
        const replayRequest = model.suspend(op.key);
        if (step.returns !== undefined) {
          assert.deepEqual(
            replayRequest,
            expectedReplay(step.returns.replay),
            `${where}: replay request`,
          );
        }
        break;
      }
      case "reconnect": {
        const replayRequest = model.reconnect(op.key, op.generation);
        if (step.returns !== undefined) {
          assert.deepEqual(
            replayRequest,
            expectedReplay(step.returns.replay),
            `${where}: replay request`,
          );
        }
        break;
      }
      case "close":
        model.close(op.key);
        break;
      case "fail":
        model.fail(op.key, member(IngressError, op.error, "error"));
        break;
      case "tick":
        model.tick(op.now);
        break;
      default:
        assert.fail(`${where}: unknown op \`${op.type}\` — an unknown op must fail, never skip`);
    }

    // The validity snapshot must be taken BEFORE any assertion reads a reader:
    // reading re-warms the cache, which would erase the very transition the
    // invalidation matrix is about.
    const after = snapshotValidity(model, keys);
    await assertState(model, step, where);
    assertInvalidation(step, before, after, where);
    await materialize(model, keys);
    steps += 1;
  }

  return steps;
}

function corpusStepTotal() {
  return FIXTURES.reduce((total, name) => total + loadFixture(name).steps.length, 0);
}

async function replayCorpus(ModelCls) {
  let steps = 0;
  for (const name of FIXTURES) {
    const fixture = loadFixture(name);
    assert.equal(fixture.kind, "Ingress", `${name}: fixture kind`);
    assert.equal(fixture.model, "IngressCell", `${name}: fixture model`);
    assert.equal(
      fixture.execution_model,
      undefined,
      `${name}: the corpus must carry NO execution-model field — the flavor axis ` +
        "belongs to the runner",
    );
    steps += await replay(ModelCls, fixture, name);
  }
  return steps;
}

// ---------------------------------------------------------------------------
// the gates
// ---------------------------------------------------------------------------

test("ingress corpus is present and non-trivial", () => {
  assert.ok(fixtureDir() !== undefined, "canonical ingress corpus not found");
  const total = corpusStepTotal();
  assert.ok(
    total >= 30,
    `the ingress corpus replays only ${total} steps; that is not the named schedule set`,
  );
});

for (const ModelCls of MODELS) {
  test(`ingress: ${ModelCls.flavor} flavor replays the whole corpus`, async () => {
    const steps = await replayCorpus(ModelCls);
    // An absence guard proves the fixtures exist on disk. Only a positive count
    // proves THIS process opened them and ran every step.
    assert.ok(steps > 0, `${ModelCls.flavor}: replayed zero steps`);
    assert.equal(
      steps,
      corpusStepTotal(),
      `every corpus step must run against the ${ModelCls.flavor} flavor`,
    );
  });
}

test("ingress ledger: unshipped flavors are really absent", () => {
  const text = sources();
  assert.ok(text.length > 0, "read no sources from src/; the ledger check would be vacuous");
  for (const { name, marker, shipped } of LEDGER) {
    const defined = text.includes(marker);
    if (shipped) {
      assert.ok(
        defined,
        `flavor "${name}" is recorded as shipped but "${marker}" is not defined in src/ — ` +
          "the ledger claims coverage this package does not have",
      );
    } else {
      assert.ok(
        !defined,
        `flavor "${name}" now EXISTS in src/ ("${marker}") but the ingress ledger still ` +
          "records it as unshipped, so the canonical corpus is not being replayed against " +
          `it.\n\nFix: flip shipped for "${name}" in LEDGER AND add it to MODELS. Do NOT ` +
          "flip the flag alone — that restores the false green this test prevents.",
      );
    }
  }
});

test("ingress ledger: is not all skips, and every shipped row is replayed", () => {
  // In a summary line, "skipped" and "passed" are indistinguishable.
  assert.equal(LEDGER.length, 3, "one row per flavor this family defines");
  assert.ok(
    LEDGER.some((row) => row.shipped),
    "a ledger of nothing-shipped is not coverage",
  );
  const shipped = LEDGER.filter((row) => row.shipped).map((row) => row.name).sort();
  const replayed = MODELS.map((Model) => Model.flavor).sort();
  assert.deepEqual(
    replayed,
    shipped,
    "every flavor the ledger calls shipped must appear in MODELS, and nothing else may",
  );
});

// The corpus asserts NEGATIVE invalidation, so the probe itself must be able to
// fail. This pins the probe per flavor: reading warms the cache, an op that
// dirties the reader clears it, and one that does not leaves it warm.
for (const ModelCls of MODELS) {
  test(`ingress: the invalidation probe discriminates (${ModelCls.flavor})`, async () => {
    const model = new ModelCls(
      policyOf({
        reorder_window: 4,
        freshness_horizon: 100,
        high_water: 64,
        overflow: "conflate",
        receipt_capacity: 32,
        retry_base: 10,
        retry_ceiling: 80,
      }),
      Sum,
      IngressTransportKind.EventChannel,
      25,
    );
    const key = "alpha";

    await model.value(key);
    assert.ok(model.valueIsValid(key), "reading warms the cache");

    model.admit(ingressEnvelope(key, 1, 0, 0, 1));
    assert.ok(!model.valueIsValid(key), "a delivery must invalidate the value reader");

    await model.value(key);
    model.admit(ingressEnvelope(key, 1, 5, 0, 1));
    assert.ok(
      model.valueIsValid(key),
      "a buffered envelope must NOT invalidate the value reader",
    );

    // And the receipt channels are independent: a buffered envelope mints no
    // receipt at all, so no channel moves either.
    await materialize(model, [key]);
    model.admit(ingressEnvelope(key, 1, 6, 0, 1));
    assert.ok(model.acceptedIsValid(), "a buffered envelope mints no accepted receipt");
    assert.ok(model.droppedIsValid(), "a buffered envelope mints no dropped receipt");
    assert.ok(model.errorsIsValid(), "a buffered envelope mints no error receipt");
  });
}
