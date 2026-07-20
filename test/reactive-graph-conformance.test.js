// Cross-language conformance for the reactive-graph plane (`#lzspecconf`),
// replayed from `../lazily-spec/conformance/reactive-graph/*.json`.
//
// ## Why this file exists
//
// Reactive-graph fixtures shipped in lazily-spec and, family-wide, only
// lazily-rs replayed them. lazily-js replayed none. The cost of that gap is not
// theoretical: an invalidation-cascade defect shipped undetected in lazily-dart
// and lazily-go while a fixture encoding the exact violated property
// (`transitive_invalidation_reaches_depth.json`) sat unrun on disk. js had never
// been checked for that defect class at all.
//
// ## Replay against every context js ships
//
// The corpus requires it, and the dart/go defects are why: both were *correct
// synchronously and broken asynchronously*. A default-context-only replay would
// have reported green against both. So every fixture is replayed against
// `Context`, `AsyncContext`, and `ThreadSafeContext` independently -- see
// `reactive-graph/models.js` for why `ThreadSafeContext` counts as a meaningful
// third model rather than an alias.
//
// ## Signal eagerness (`#lzsignaleager`)
//
// Three fixtures assert the four normative signal clauses, and they are the only
// fixtures in the corpus that assert `computes_of` -- the cumulative count of
// compute invocations. They need it because an eager signal and the lazy memo it
// is built on return IDENTICAL values for every read sequence: values alone
// cannot tell `signal()` from `memo()`. The counter is therefore wrapped around
// the real compute closure in `models.js`, never synthesized by the runner.
//
// ## Positive assertion (the non-negotiable part)
//
// An absence guard proves fixtures are *available*, not that they were *read*,
// and a runner that skips everything must fail rather than report green. This
// file is the inner layer of the two-layer mechanism already established in
// `#lzspecconf` (the outer layer is the CI grep for `fail 0` / `skipped 0` /
// `pass > 0`). It asserts, per model and in total:
//
//   1. the fixture set on disk is exactly `FIXTURES` -- an upstream addition
//      cannot arrive unexecuted;
//   2. the set of fixtures actually replayed equals the expected set exactly,
//      and its size is non-zero;
//   3. a non-zero number of ops *and* a non-zero number of assertions executed;
//   4. the skip ledger matches `EXPECTED_SKIPS` exactly, so a fixture that
//      silently stops replaying fails the build, and one that becomes
//      replayable fails it until the ledger entry is removed.
//
// Nothing here calls `t.skip()`: a node:test skip both hides the reason and
// trips the `skipped 0` gate in CI. Skips are data, asserted against a ledger.
import assert from "node:assert/strict";
import test from "node:test";

import {
  CLONE_HINT,
  FIXTURES,
  SPEC_DIR,
  fixturesOnDisk,
  loadFixture,
  replayFixture,
  specPresent,
  unsupportedReason,
} from "./reactive-graph/engine.js";
import { MODELS } from "./reactive-graph/models.js";

// Fixtures a model cannot replay, as `<model>/<fixture>` -> reason.
//
// EMPTY, and asserted as an exact match in both directions: every fixture now
// replays against every context lazily-js ships. The eight entries this ledger
// used to carry all named the same missing surface -- `ctx.scope()` /
// `TeardownScope`, per-node `disposeNode`, and dependency-edge degree
// introspection -- which `lazily-rs` was the only binding to have shipped. That
// surface now exists on `Context`, `AsyncContext`, and `ThreadSafeContext`
// (`#lzspecedgeindex`), so a skip here would be a regression, not a gap.
//
// An entry may only be added with the specific op or assertion named, and only
// when the underlying context genuinely lacks the API -- never to route around a
// failing assertion. A failing fixture belongs in `KNOWN_DIVERGENCES`, where it
// is visible as a finding.
const EXPECTED_SKIPS = {};

/**
 * Fixture assertions an execution model does not satisfy today, as
 * `<model>/<fixture>#<step>(<op>):<key>[:<id>]`.
 *
 * Each entry is a FINDING AGAINST lazily-js, not a relaxation of the fixture.
 * The runner asserts this set matches the observed set exactly: a new divergence
 * fails the build, and a fixed one fails it until the entry is removed. The
 * fixture on disk is never edited and no assertion is loosened.
 *
 * Empty today, across all three models and every fixture. The one entry this
 * ledger carried -- a live reader of a disposed slot serving its pre-disposal
 * cache forever, because `disposeSlot` detached both edge directions without
 * dirtying the surviving readers -- was fixed in `reactive.js`
 * (`invalidateDisposedDependents`). The same defect had been found and fixed in
 * lazily-rs (`5db90d2`), and lazily-dart and lazily-go each hit it on their
 * async paths.
 *
 * The `observationally_equal` relation is recorded here under the tag
 * `<model>/<fixture>:observationally_equal` if it ever diverges.
 */
const KNOWN_DIVERGENCES = [];

// The fixtures each model must replay. Asserted as an exact set, so a fixture
// dropping out of the replay path fails rather than shrinking the run silently.
const EXPECTED_REPLAYS = {
  Context: FIXTURES,
  AsyncContext: FIXTURES,
  ThreadSafeContext: FIXTURES,
};

test("reactive-graph corpus is the canonical sibling's, unmodified", () => {
  assert.ok(specPresent(), `${SPEC_DIR} not found — ${CLONE_HINT}`);
  assert.deepEqual(
    fixturesOnDisk(),
    [...FIXTURES].sort(),
    "reactive-graph fixture set drifted; every fixture must be accounted for by this runner",
  );
});

// The corpus is replayed once per execution model. Each model gets its own test
// so a failure names the context, which is the whole point: the dart/go defects
// were sync-clean and async-broken.
for (const model of MODELS) {
  test(`reactive-graph conformance [${model.name}]`, async () => {
    assert.ok(specPresent(), `${SPEC_DIR} not found — ${CLONE_HINT}`);

    const replayed = [];
    const skips = {};
    const divergences = {
      known: new Set(KNOWN_DIVERGENCES.filter((d) => d.startsWith(`${model.name}/`))),
      observed: new Set(),
    };
    let totalOps = 0;
    let totalChecks = 0;

    for (const name of FIXTURES) {
      const fixture = loadFixture(name);
      const reason = unsupportedReason(model, fixture);
      if (reason) {
        skips[`${model.name}/${name}`] = reason;
        continue;
      }

      const { ops, checks } = await replayFixture(model, name, fixture, assert, divergences);
      assert.ok(ops > 0, `${model.name}/${name}: replayed zero ops`);
      assert.ok(checks > 0, `${model.name}/${name}: performed zero assertions`);
      replayed.push(name);
      totalOps += ops;
      totalChecks += checks;
    }

    // --- positive assertion -------------------------------------------------
    assert.ok(
      replayed.length > 0,
      `${model.name}: zero fixtures replayed — the runner tested nothing`,
    );
    assert.deepEqual(
      replayed.sort(),
      [...EXPECTED_REPLAYS[model.name]].sort(),
      `${model.name}: replayed fixture set changed`,
    );
    assert.ok(totalOps > 0, `${model.name}: zero ops executed`);
    assert.ok(totalChecks > 0, `${model.name}: zero assertions executed`);

    // --- skip ledger --------------------------------------------------------
    const expectedForModel = Object.fromEntries(
      Object.entries(EXPECTED_SKIPS).filter(([k]) => k.startsWith(`${model.name}/`)),
    );
    assert.deepEqual(
      skips,
      expectedForModel,
      `${model.name}: skip ledger drifted — a skipped fixture is not a passing fixture`,
    );

    // --- divergence ledger --------------------------------------------------
    // Exact match in both directions: an unrecorded divergence has already
    // failed the step above, and a recorded-but-no-longer-observed one fails
    // here so a fix cannot leave a stale entry masking a future regression.
    assert.deepEqual(
      [...divergences.observed].sort(),
      [...divergences.known].sort(),
      `${model.name}: divergence ledger drifted — a ledger entry whose divergence `
      + "no longer reproduces must be removed, not left masking the assertion",
    );

    console.log(
      `reactive-graph[${model.name}]: replayed ${replayed.length} fixtures, `
      + `${totalOps} ops, ${totalChecks} assertions, ${Object.keys(skips).length} skipped, `
      + `${divergences.observed.size} known divergences`,
    );
  });
}

// The discriminating fixture, called out on its own so its status is legible in
// the test output rather than buried in a corpus loop. It is the fixture whose
// property lazily-dart and lazily-go both violated on their async paths.
test("transitive invalidation reaches depth on every context js ships", async () => {
  assert.ok(specPresent(), `${SPEC_DIR} not found — ${CLONE_HINT}`);
  const name = "transitive_invalidation_reaches_depth.json";
  const fixture = loadFixture(name);

  const covered = [];
  for (const model of MODELS) {
    assert.equal(
      unsupportedReason(model, fixture),
      null,
      `${model.name} cannot replay ${name} — the cascade contract must reach every context`,
    );
    // No ledger: the cascade fixture must pass cleanly on every context, with
    // no divergence tolerated. This is the property dart and go both violated.
    const empty = { known: new Set(), observed: new Set() };
    const { checks } = await replayFixture(model, name, fixture, assert, empty);
    assert.ok(checks > 0, `${model.name}: ${name} asserted nothing`);
    covered.push(model.name);
  }

  assert.deepEqual(
    covered,
    ["Context", "AsyncContext", "ThreadSafeContext"],
    "every context lazily-js ships must replay the cascade fixture",
  );
});
