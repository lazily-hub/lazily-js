// Fixture loader + replay engine for the reactive-graph conformance corpus
// (`#lzspecconf`, `#lzspecedgeindex`).
//
// Fixtures are read from the canonical lazily-spec sibling. There is no bundled
// copy and no fallback -- a fallback is precisely what makes drift invisible,
// which is why the nine bundled fixtures under `test/conformance/` were deleted
// rather than kept as a backstop.
//
// ## Replay semantics
//
// A fixture is an ordered `steps` array, or a `scenarios` array each with its
// own `steps` and a shared `expected` tail. Each step is `{ op, expect? }`: the
// op mutates or reads the graph, then every key in `expect` is checked. An
// unrecognised op or `expect` key is a hard error, never a silent pass -- the
// whole failure mode this runner exists to close is "reported green while
// checking nothing".
//
// ## Assertion evaluation order is load-bearing
//
// `expect` keys are evaluated in sorted key order, matching the reference runner
// in lazily-rs. This is not cosmetic: `dependents_of` sorts before `read`, and a
// lazy binding re-registers its dependency edges when it recomputes, so
// evaluating the reads first would change the very degree the same step then
// asserts.
//
// ## The `scenarios` shape and `observationally_equal`
//
// `scope_teardown_equals_fold_of_disposals.json` is a *relation between two op
// streams*: ending a scope must be observationally equal to disposing each of
// its members individually. That is not expressible in a single `steps` array,
// which is why the shape exists. Each scenario replays in its OWN fresh context
// -- the claim is about two independent worlds, not one world twice -- and the
// two resulting observation records are compared field for field. Skipping the
// relation and merely checking each scenario against `expected` would leave the
// fixture's entire point unverified.
//
// ## Skips are named, never silent
//
// A model replays a fixture only if it can execute every op *and* evaluate every
// `expect` key the fixture uses. Otherwise the fixture is skipped with the
// specific unsupported op or assertion named. Skips are returned as data so the
// caller can assert the ledger exactly; nothing here calls `t.skip()`, because a
// node:test skip would both hide the reason and trip the `skipped 0` gate in CI.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DisposedNodeError } from "./models.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The single sibling-relative path constant. Mirrors `SPEC_DIR` in lazily-rs. */
export const SPEC_DIR = join(here, "..", "..", "..", "lazily-spec", "conformance", "reactive-graph");

export const CLONE_HINT =
  "clone the canonical sibling: "
  + "git clone --depth 1 https://github.com/lazily-hub/lazily-spec.git ../lazily-spec";

/**
 * The canonical fixture set, asserted against the directory listing so a fixture
 * added or renamed upstream fails loudly instead of quietly going unrun.
 */
export const FIXTURES = [
  "churn_returns_to_baseline.json",
  "cross_scope_teardown_hazard.json",
  "disarm_disposes_nothing.json",
  "disposal_does_not_run_surviving_effects.json",
  "dispose_detaches_edges_both_directions.json",
  "dispose_signal_reverts_to_lazy.json",
  // #lzmergefeed: the mergefeed/feedback fixtures landed on spec main (Step 3).
  // Five use the `merge_cell` op this runner does not model, and
  // `feedback_drain_bound_reports_exhaustion` asserts the parked
  // `drain_exhausted` key -- all accounted-for skips in `EXPECTED_SKIPS`, not
  // faked passes. They are listed here so the on-disk drift check stays green.
  "exact_fold_paths_stay_exact.json",
  "feedback_drain_bound_reports_exhaustion.json",
  "merge_cell_acquires_no_dependency_edge.json",
  "merge_feed_through_a_formula_coalesces.json",
  "merge_folds_synchronously_in_batch.json",
  "merge_per_settled_cone_not_per_write.json",
  "read_after_dispose_is_an_error.json",
  "recycled_id_inherits_nothing.json",
  "scope_teardown_equals_fold_of_disposals.json",
  "scoping_bounds_teardown_not_visibility.json",
  "signal_materializes_once_per_batch.json",
  "signal_materializes_without_a_read.json",
  "teardown_runs_members_in_reverse_creation_order.json",
  "transitive_invalidation_reaches_depth.json",
];

export function specPresent() {
  return existsSync(SPEC_DIR);
}

export function fixturesOnDisk() {
  return readdirSync(SPEC_DIR).filter((n) => n.endsWith(".json")).sort();
}

export function loadFixture(name) {
  const path = join(SPEC_DIR, name);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`failed to read fixture ${path}: ${err.message}`);
  }
}

/** Every step in a fixture, whether it is `steps`- or `scenarios`-shaped. */
function allSteps(fixture) {
  if (Array.isArray(fixture.steps)) return fixture.steps;
  return (fixture.scenarios ?? []).flatMap((s) => s.steps ?? []);
}

/**
 * Why `model` cannot replay `fixture`, or `null` if it can.
 *
 * Reports the *first* unsupported op or assertion by name. Assertion support is
 * checked as well as op support: a model that can execute every op but cannot
 * evaluate `dependents_of` would otherwise replay the ops and check nothing,
 * which is the silent-pass shape this runner is built to prevent.
 */
export function unsupportedReason(model, fixture) {
  const steps = allSteps(fixture);
  for (const step of steps) {
    const type = step.op?.type;
    if (!model.ops.has(type)) return `unsupported op: ${type}`;
  }
  for (const step of steps) {
    for (const key of Object.keys(step.expect ?? {})) {
      if (!model.assertions.has(key)) return `unsupported assertion: ${key}`;
    }
  }
  return null;
}

/** Marker recorded in place of a value when a read raised read-after-dispose. */
const DISPOSED = "read_after_dispose";

/**
 * Everything a scenario leaves behind that `observationally_equal` compares.
 *
 * Deliberately made of *observables the corpus already names* -- cleanup order,
 * readability, values, post-publish observers and reads, and degrees -- not of
 * internal state. Two runs that agree on all of these are equal in the only
 * sense the fixture claims.
 */
function newObservation() {
  return {
    cleanupOrder: [],
    readable: {},
    reads: {},
    afterPublishObserved: [],
    afterPublishReads: {},
    degrees: {},
  };
}

function sortedEntries(object) {
  return Object.keys(object)
    .sort()
    .map((k) => [k, object[k]]);
}

function describeObservation(observation) {
  return JSON.stringify({
    cleanup_order: observation.cleanupOrder,
    readable: sortedEntries(observation.readable),
    reads: sortedEntries(observation.reads),
    after_publish_observed: observation.afterPublishObserved,
    after_publish_reads: sortedEntries(observation.afterPublishReads),
    degrees: sortedEntries(observation.degrees),
  });
}

/**
 * Replay one op-stream against a fresh instance of `model`.
 *
 * Returns `{ ops, checks, observation }`. A stream that executes zero ops or
 * performs zero checks is a runner defect, and the caller fails on it.
 */
async function replaySteps(model, steps, label, assertFn, divergences, tail) {
  const instance = model.create();
  const observation = newObservation();
  let ops = 0;
  let checks = 0;

  // Record a known divergence instead of failing the step, and keep replaying
  // the rest of the fixture. `divergences` is a Set the caller asserts against
  // an exact ledger, so a divergence is a *recorded finding*, never a relaxed
  // assertion: a new one fails the build, and a fixed one fails it until the
  // ledger entry is removed. A divergent check is not counted in `checks`.
  const check = (where, key, id, fn) => {
    const tag = id === null ? `${where}:${key}` : `${where}:${key}:${id}`;
    if (divergences.known.has(tag)) {
      divergences.observed.add(tag);
      return;
    }
    fn();
    checks += 1;
  };

  // A top-level read. A `DisposedNodeError` -- raised by the node itself or by a
  // node it recomputes through -- is the corpus's `read_after_dispose`. Any
  // other error is a real failure and propagates.
  const readOr = async (id) => {
    try {
      return await instance.read(id);
    } catch (err) {
      if (err instanceof DisposedNodeError) return DISPOSED;
      throw err;
    }
  };

  // `readable` asks "can this node still be observed", which for an effect is
  // registration rather than a value.
  const alive = async (id) => {
    if (instance.kindOf(id) === "effect") return instance.isEffectActive(id);
    return (await readOr(id)) !== DISPOSED;
  };

  try {
    for (const [index, step] of steps.entries()) {
      const op = step.op;
      const where = `${label}#${index}(${op.type})`;
      const runsBefore = instance.runLog.length;
      let opValue;
      let opError = null;

      switch (op.type) {
        case "cell":
          await instance.source(op.id, op.value, op.scope ?? null);
          break;
        case "computed":
          await instance.computed(op.id, op.reads ?? [], op.offset ?? 0, op.scope ?? null);
          break;
        case "signal":
        // #lzcellkernel: dual-accept `eager` alongside the fixture's `signal`.
        // The eager construction is now an eager Computed (`computed().eager()`);
        // both op names route to the same model method until the corpus renames.
        case "eager":
          // Eager: the value must be materialized by the time this returns, and
          // deliberately NOT read here -- reading would materialize a lazy
          // binding and hide the very thing `computes_of` is asserting.
          await instance.signal(op.id, op.reads ?? [], op.offset ?? 0, op.scope ?? null);
          break;
        case "dispose_signal":
        // #lzcellkernel: dual-accept `lazy` alongside `dispose_signal`.
        case "lazy":
          // The eager puller only -- see clause 4. Not a node teardown, which is
          // why this is not routed through `dispose`.
          await instance.disposeSignal(op.id);
          break;
        case "batch":
          // One batch carrying all writes, so the runner needs no nesting state.
          await instance.batch(op.writes ?? []);
          break;
        case "effect":
          await instance.effect(op.id, op.reads ?? [], op.scope ?? null);
          break;
        case "read":
          try {
            opValue = await instance.read(op.id);
          } catch (err) {
            if (!(err instanceof DisposedNodeError)) throw err;
            opError = err;
          }
          break;
        case "set_cell":
          await instance.set(op.id, op.value);
          break;
        case "dispose":
          try {
            await instance.dispose(op.id);
          } catch (err) {
            if (!(err instanceof DisposedNodeError)) throw err;
            opError = err;
          }
          break;
        case "fanout":
          for (let n = 0; n < op.count; n++) {
            await instance.effect(`${op.id_prefix}_${n}`, op.reads ?? [], null);
          }
          break;
        case "dispose_fanout":
          for (let n = 0; n < op.count; n++) {
            await instance.dispose(`${op.id_prefix}_${n}`);
          }
          break;
        case "churn":
          await churn(instance, op);
          break;
        case "begin_scope":
          instance.beginScope(op.scope);
          break;
        case "end_scope":
          await instance.endScope(op.scope);
          break;
        case "disarm":
          // A disarmed scope owns nothing but stays open under the same name, so
          // the `end_scope` that follows is the no-op the fixture asserts.
          instance.disarmScope(op.scope);
          break;
        case "dispose_stale_handle":
          // The kind is read from the recorded handle, never from the graph --
          // the whole point of this op is that the id has been reissued to a
          // node of another kind, and the teardown must be a no-op.
          assertFn.equal(
            instance.kindOf(op.handle_of),
            op.handle_kind,
            `${where}: handle_kind does not match the recorded handle`,
          );
          await instance.dispose(op.handle_of);
          break;
        default:
          throw new Error(`${where}: unknown op type ${op.type}`);
      }
      ops += 1;
      await instance.settle();
      const observed = instance.runLog.slice(runsBefore);

      const expect = step.expect ?? {};
      // Sorted: see the header note. `dependents_of` must be read before the
      // reads in the same step re-register the edges it counts.
      for (const key of Object.keys(expect).sort()) {
        const want = expect[key];
        switch (key) {
          case "note":
            // Prose. Carries no assertion, and is not counted as a check.
            break;

          case "value": {
            // For a `read` op this is the value the op returned. The signal
            // fixtures also assert `value` on a `signal` creation op, meaning
            // "the node's value right now" -- so it is read here, at assertion
            // time, rather than eagerly at op time. That ordering is load-bearing:
            // `computes_of` sorts BEFORE `value`, so the compute count is checked
            // before this read can materialize a lazy binding and mask the
            // difference the fixture exists to detect.
            const got = op.type === "read" ? (opError ? DISPOSED : opValue) : await readOr(op.id);
            check(where, "value", null, () => {
              assertFn.equal(got, want, `${where}: value`);
            });
            break;
          }

          case "computes_of":
            // Cumulative invocations of the node's compute since the start of
            // the scenario, creation included -- the only caller-observable
            // difference between an eager signal and the lazy memo backing it.
            for (const id of Object.keys(want).sort()) {
              const got = instance.computesOf(id);
              check(where, "computes_of", id, () =>
                assertFn.equal(got, want[id], `${where}: computes_of ${id}`),
              );
            }
            break;

          case "read":
            // A map of id -> expected value, each read fresh after the op.
            for (const id of Object.keys(want).sort()) {
              const got = await readOr(id);
              check(where, "read", id, () =>
                assertFn.equal(got, want[id], `${where}: read ${id}`),
              );
            }
            break;

          case "error":
            check(where, "error", null, () => {
              if (want === null) {
                assertFn.equal(
                  opError,
                  null,
                  `${where}: expected no error, got ${opError?.message}`,
                );
              } else if (want === DISPOSED) {
                assertFn.ok(
                  opError !== null,
                  `${where}: expected a read_after_dispose error, op returned ${opValue}`,
                );
              } else {
                throw new Error(`${where}: unknown expected error ${want}`);
              }
            });
            break;

          case "readable":
            // A map of id -> whether the node must still be observable.
            for (const id of Object.keys(want).sort()) {
              const got = await alive(id);
              check(where, "readable", id, () =>
                assertFn.equal(got, want[id], `${where}: readable ${id}`),
              );
            }
            break;

          case "dependents_of":
            for (const id of Object.keys(want).sort()) {
              const got = instance.dependentsOf(id);
              check(where, "dependents_of", id, () =>
                assertFn.equal(got, want[id], `${where}: dependents_of ${id}`),
              );
            }
            break;

          case "dependencies_of":
            for (const id of Object.keys(want).sort()) {
              const got = instance.dependenciesOf(id);
              check(where, "dependencies_of", id, () =>
                assertFn.equal(got, want[id], `${where}: dependencies_of ${id}`),
              );
            }
            break;

          case "observed_by":
            check(where, "observed_by", null, () =>
              assertFn.deepEqual(observed, want, `${where}: observed_by`),
            );
            break;

          case "observed_count":
            check(where, "observed_count", null, () =>
              assertFn.equal(observed.length, want, `${where}: observed_count`),
            );
            break;

          case "cleanup_order":
            // Only effects run a cleanup callback, so the expected order is
            // projected onto its effect entries. Cumulative for the whole
            // stream: the individual-disposal scenario spreads three disposals
            // over three steps and pins the whole order on the last one.
            check(where, "cleanup_order", null, () =>
              assertFn.deepEqual(
                instance.cleanupLog,
                want.filter((id) => instance.kindOf(id) === "effect"),
                `${where}: cleanup_order`,
              ),
            );
            break;

          case "scope_owned_count":
            for (const name of Object.keys(want).sort()) {
              const got = instance.scopeOwned(name);
              check(where, "scope_owned_count", name, () =>
                assertFn.equal(got, want[name], `${where}: scope_owned_count ${name}`),
              );
            }
            break;

          default:
            throw new Error(`${where}: unknown expectation ${key}`);
        }
      }
    }

    observation.cleanupOrder = [...instance.cleanupLog];
    if (tail) {
      const where = `${label}#expected`;

      const finalState = tail.final_state ?? {};
      for (const id of Object.keys(finalState.dependents_of ?? {}).sort()) {
        const got = instance.dependentsOf(id);
        observation.degrees[id] = got;
        check(where, "final.dependents_of", id, () =>
          assertFn.equal(got, finalState.dependents_of[id], `${where}: dependents_of ${id}`),
        );
      }
      for (const id of Object.keys(finalState.readable ?? {}).sort()) {
        const got = await alive(id);
        observation.readable[id] = got;
        check(where, "final.readable", id, () =>
          assertFn.equal(got, finalState.readable[id], `${where}: readable ${id}`),
        );
      }
      for (const id of Object.keys(finalState.read ?? {}).sort()) {
        const got = await readOr(id);
        observation.reads[id] = got;
        check(where, "final.read", id, () =>
          assertFn.equal(got, finalState.read[id], `${where}: read ${id}`),
        );
      }

      const publish = tail.after_publish;
      if (publish?.op) {
        const before = instance.runLog.length;
        await instance.set(publish.op.id, publish.op.value);
        await instance.settle();
        observation.afterPublishObserved = instance.runLog.slice(before);
        check(where, "after_publish.observed_by", null, () =>
          assertFn.deepEqual(
            observation.afterPublishObserved,
            publish.observed_by ?? [],
            `${where}: after_publish observed_by`,
          ),
        );
        // Reads before degrees: a lazy binding re-registers edges when it
        // recomputes, and the degree assertion below counts them.
        for (const id of Object.keys(publish.read ?? {}).sort()) {
          const got = await readOr(id);
          observation.afterPublishReads[id] = got;
          check(where, "after_publish.read", id, () =>
            assertFn.equal(got, publish.read[id], `${where}: after_publish read ${id}`),
          );
        }
        for (const id of Object.keys(publish.dependents_of ?? {}).sort()) {
          const got = instance.dependentsOf(id);
          check(where, "after_publish.dependents_of", id, () =>
            assertFn.equal(
              got,
              publish.dependents_of[id],
              `${where}: after_publish dependents_of ${id}`,
            ),
          );
        }
      }
    }
  } finally {
    await instance.destroy();
  }

  return { ops, checks, observation };
}

/**
 * The `churn` op: a subscribe/unsubscribe workload whose LIVE width is constant.
 *
 * Each cycle settles before the next begins. That is the same quiescence
 * boundary every other op observes -- for the synchronous models it is a no-op,
 * and for the async model it is what makes "the subscriber created this cycle
 * has actually registered its edge" true before the cycle that disposes it.
 * Without it the fixture would measure scheduling latency rather than the
 * dependent-set size it is written about.
 */
async function churn(instance, op) {
  const width = op.live_width;
  const cycles = op.cycles;
  switch (op.mode) {
    // Hold `live_width` subscribers; each cycle disposes one and creates its
    // replacement, so the live count is invariant.
    case "dispose_then_create":
      for (let c = 0; c < cycles; c++) {
        const id = `${op.id_prefix}_${c % width}`;
        await instance.dispose(id);
        await instance.effect(id, [op.source], null);
        await instance.settle();
      }
      break;
    // One teardown scope per cycle; its subscriber is gone by the end of its own
    // cycle, so it contributes nothing to the steady-state count.
    case "scope_per_cycle": {
      const scopeName = `${op.id_prefix}_scoped`;
      for (let c = 0; c < cycles; c++) {
        instance.beginScope(scopeName);
        await instance.effect(`${op.id_prefix}_scoped_member`, [op.source], scopeName);
        await instance.settle();
        await instance.endScope(scopeName);
        await instance.settle();
      }
      break;
    }
    default:
      throw new Error(`unknown churn mode ${op.mode}`);
  }
}

/**
 * Replay a whole fixture.
 *
 * `steps`-shaped fixtures replay once. `scenarios`-shaped ones replay each
 * scenario in its OWN fresh context, evaluate the shared `expected` tail against
 * each, and then check the `observationally_equal` relation between the named
 * scenarios -- the property the shape exists to express.
 */
export async function replayFixture(model, name, fixture, assertFn, divergences) {
  if (Array.isArray(fixture.steps)) {
    const r = await replaySteps(
      model,
      fixture.steps,
      `${model.name}/${name}`,
      assertFn,
      divergences,
      null,
    );
    return { ops: r.ops, checks: r.checks };
  }

  const tail = fixture.expected ?? null;
  const scenarios = fixture.scenarios ?? [];
  const byName = new Map();
  let ops = 0;
  let checks = 0;

  for (const scenario of scenarios) {
    const label = `${model.name}/${name}[${scenario.name ?? "?"}]`;
    const r = await replaySteps(model, scenario.steps ?? [], label, assertFn, divergences, tail);
    ops += r.ops;
    checks += r.checks;
    byName.set(scenario.name, r.observation);
  }

  const equal = tail?.observationally_equal ?? [];
  if (equal.length > 1) {
    const tag = `${model.name}/${name}:observationally_equal`;
    if (divergences.known.has(tag)) {
      divergences.observed.add(tag);
    } else {
      for (const scenarioName of equal) {
        if (!byName.has(scenarioName)) {
          throw new Error(`${model.name}/${name}: unknown scenario ${scenarioName}`);
        }
      }
      for (let i = 1; i < equal.length; i++) {
        const a = describeObservation(byName.get(equal[i - 1]));
        const b = describeObservation(byName.get(equal[i]));
        assertFn.equal(
          a,
          b,
          `${model.name}/${name}: ${equal[i - 1]} and ${equal[i]} are not `
          + "observationally equal — ending a scope must equal disposing its members",
        );
      }
      checks += 1;
    }
  }

  return { ops, checks };
}
