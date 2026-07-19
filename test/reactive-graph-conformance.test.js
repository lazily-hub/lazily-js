// Cross-language conformance for the reactive-graph plane (`#lzspecconf`),
// replayed from `../lazily-spec/conformance/reactive-graph/*.json`.
//
// ## Why this file exists
//
// Nine reactive-graph fixtures shipped in lazily-spec and, family-wide, only
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
// Every entry names the specific op or assertion that is missing. These are
// findings against lazily-js, not relaxations of the corpus:
//
//   * Scope ops (`begin_scope` / `end_scope` / `disarm`) -- lazily-js exposes no
//     `ctx.scope()` / `TeardownScope` at all, so four fixtures are unreachable
//     for every model. This is the largest single gap in js's reactive-graph
//     surface relative to the corpus.
//   * `fanout` / `churn` / `dispose_fanout` / `dispose_stale_handle` -- runner
//     constructs js could express, but the fixtures using them assert
//     `dependents_of` / `dependencies_of`, and js publishes no dependency-edge
//     introspection. Replaying the ops while checking nothing would be the exact
//     silent-pass shape this runner exists to prevent.
//   * `dispose` on the async and thread-safe models -- neither exposes
//     `disposeSlot`/`disposeCell`; only the sync `Context` has lazy-node
//     teardown.
const EXPECTED_SKIPS = {
  "Context/churn_returns_to_baseline.json": "unsupported op: fanout",
  "Context/cross_scope_teardown_hazard.json": "unsupported op: begin_scope",
  "Context/disarm_disposes_nothing.json": "unsupported op: begin_scope",
  "Context/dispose_detaches_edges_both_directions.json": "unsupported op: effect",
  "Context/recycled_id_inherits_nothing.json": "unsupported op: fanout",
  "Context/scope_teardown_equals_fold_of_disposals.json": "unsupported op: begin_scope",
  "Context/scoping_bounds_teardown_not_visibility.json": "unsupported op: begin_scope",

  "AsyncContext/churn_returns_to_baseline.json": "unsupported op: fanout",
  "AsyncContext/cross_scope_teardown_hazard.json": "unsupported op: begin_scope",
  "AsyncContext/disarm_disposes_nothing.json": "unsupported op: begin_scope",
  "AsyncContext/dispose_detaches_edges_both_directions.json": "unsupported op: effect",
  "AsyncContext/read_after_dispose_is_an_error.json": "unsupported op: dispose",
  "AsyncContext/recycled_id_inherits_nothing.json": "unsupported op: fanout",
  "AsyncContext/scope_teardown_equals_fold_of_disposals.json": "unsupported op: begin_scope",
  "AsyncContext/scoping_bounds_teardown_not_visibility.json": "unsupported op: begin_scope",

  "ThreadSafeContext/churn_returns_to_baseline.json": "unsupported op: fanout",
  "ThreadSafeContext/cross_scope_teardown_hazard.json": "unsupported op: begin_scope",
  "ThreadSafeContext/disarm_disposes_nothing.json": "unsupported op: begin_scope",
  "ThreadSafeContext/dispose_detaches_edges_both_directions.json": "unsupported op: effect",
  "ThreadSafeContext/read_after_dispose_is_an_error.json": "unsupported op: dispose",
  "ThreadSafeContext/recycled_id_inherits_nothing.json": "unsupported op: fanout",
  "ThreadSafeContext/scope_teardown_equals_fold_of_disposals.json": "unsupported op: begin_scope",
  "ThreadSafeContext/scoping_bounds_teardown_not_visibility.json": "unsupported op: begin_scope",
};

/**
 * Fixture assertions an execution model does not satisfy today, as
 * `<model>/<fixture>#<step>(<op>):<key>[:<id>]`.
 *
 * Each entry is a FINDING AGAINST lazily-js, not a relaxation of the fixture.
 * The runner asserts this set matches the observed set exactly: a new divergence
 * fails the build, and a fixed one fails it until the entry is removed. The
 * fixture on disk is never edited and no assertion is loosened.
 *
 * Empty today. The one entry this ledger carried -- a live reader of a disposed
 * slot serving its pre-disposal cache forever, because `disposeSlot` detached
 * both edge directions without dirtying the surviving readers -- was fixed in
 * `reactive.js` (`invalidateDisposedDependents`), so
 * `read_after_dispose_is_an_error.json` now replays clean on `Context`. The same
 * defect had been found and fixed in lazily-rs (`5db90d2`).
 */
const KNOWN_DIVERGENCES = [];

// The fixtures each model must replay. Asserted as an exact set, so a fixture
// dropping out of the replay path fails rather than shrinking the run silently.
const EXPECTED_REPLAYS = {
  Context: [
    "read_after_dispose_is_an_error.json",
    "transitive_invalidation_reaches_depth.json",
  ],
  AsyncContext: ["transitive_invalidation_reaches_depth.json"],
  ThreadSafeContext: ["transitive_invalidation_reaches_depth.json"],
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
