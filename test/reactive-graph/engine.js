// Fixture loader + replay engine for the reactive-graph conformance corpus
// (`#lzspecconf`).
//
// Fixtures are read from the canonical lazily-spec sibling. There is no bundled
// copy and no fallback -- a fallback is precisely what makes drift invisible,
// which is why the nine bundled fixtures under `test/conformance/` were deleted
// rather than kept as a backstop.
//
// ## Replay semantics
//
// A fixture is an ordered `steps` array (or `scenarios`, each with its own
// `steps`, replayed in a fresh context). Each step is `{ op, expect? }`: the op
// mutates or reads the graph, then every key in `expect` is checked. An
// unrecognised op or `expect` key is a hard error, never a silent pass -- the
// whole failure mode this runner exists to close is "reported green while
// checking nothing".
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
  "dispose_detaches_edges_both_directions.json",
  "read_after_dispose_is_an_error.json",
  "recycled_id_inherits_nothing.json",
  "scope_teardown_equals_fold_of_disposals.json",
  "scoping_bounds_teardown_not_visibility.json",
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

/**
 * Replay one op-stream against a fresh instance of `model`.
 *
 * Returns `{ ops, checks }` counts, which the caller folds into the positive
 * assertion. A stream that executes zero ops or performs zero checks is a
 * runner defect, and the caller fails on it.
 */
async function replaySteps(model, steps, label, assertFn, divergences) {
  const instance = model.create();
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

  try {
    for (const [index, step] of steps.entries()) {
      const op = step.op;
      const where = `${label}#${index}(${op.type})`;
      let opValue;
      let opError = null;

      switch (op.type) {
        case "cell":
          await instance.cell(op.id, op.value);
          break;
        case "computed":
          await instance.computed(op.id, op.reads ?? [], op.offset ?? 0);
          break;
        case "read":
          try {
            opValue = await instance.read(op.id);
          } catch (err) {
            opError = err;
          }
          break;
        case "set_cell":
          await instance.setCell(op.id, op.value);
          break;
        case "dispose":
          try {
            await instance.dispose(op.id);
          } catch (err) {
            opError = err;
          }
          break;
        default:
          throw new Error(`${where}: unknown op type ${op.type}`);
      }
      ops += 1;

      const expect = step.expect ?? {};
      for (const [key, want] of Object.entries(expect)) {
        switch (key) {
          case "note":
            // Prose. Carries no assertion, and is not counted as a check.
            break;

          case "value":
            check(where, "value", null, () => {
              if (opError) {
                throw new Error(`${where}: expected value ${want}, op threw: ${opError.message}`);
              }
              assertFn.equal(opValue, want, `${where}: value`);
            });
            break;

          case "read":
            // A map of id -> expected value, each read fresh after the op.
            for (const [id, wantValue] of Object.entries(want)) {
              const got = await instance.read(id);
              check(where, "read", id, () =>
                assertFn.equal(got, wantValue, `${where}: read ${id}`),
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
              } else if (want === "read_after_dispose") {
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
            // A map of id -> whether reading that node must succeed.
            for (const [id, wantReadable] of Object.entries(want)) {
              let readable = true;
              try {
                await instance.read(id);
              } catch {
                readable = false;
              }
              check(where, "readable", id, () =>
                assertFn.equal(readable, wantReadable, `${where}: readable ${id}`),
              );
            }
            break;

          default:
            throw new Error(`${where}: unknown expectation ${key}`);
        }
      }
    }
  } finally {
    await instance.destroy();
  }

  return { ops, checks };
}

/** Replay a whole fixture (all scenarios, if it is scenario-shaped). */
export async function replayFixture(model, name, fixture, assertFn, divergences) {
  if (Array.isArray(fixture.steps)) {
    return replaySteps(model, fixture.steps, `${model.name}/${name}`, assertFn, divergences);
  }
  let ops = 0;
  let checks = 0;
  for (const scenario of fixture.scenarios ?? []) {
    const label = `${model.name}/${name}[${scenario.name ?? "?"}]`;
    const r = await replaySteps(model, scenario.steps ?? [], label, assertFn, divergences);
    ops += r.ops;
    checks += r.checks;
  }
  return { ops, checks };
}
