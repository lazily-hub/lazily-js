// Scenario replay helpers (#lzscenariocoverage).
//
// Rung 4 of the conformance ladder. Rung 1 (`check-conformance-coverage.sh`)
// proves the fixture FILE was opened; rungs 2-3 (`check-assertion-keys.mjs`)
// prove every assertion key of a block a runner REACHED was read and compared.
// None of them can see a fixture whose four scenarios were replayed three times:
// opening the file once satisfies rung 1, and an unreplayed scenario contributes
// no unconsumed and no unasserted key, because rungs 2-3 only inspect the
// scenarios you ran.
//
// Key records are keyed by `fixture\tblock\tkey`, which makes it worse than
// blind — sibling scenarios that share an `expect` key name MASK each other.
// `collections/stableid_alignment.json` carried a scenario this runner's
// name-matching if/else chain fell straight through, and its `key_equal` was
// already marked asserted by the scenario before it, so both existing guards
// reported green over a scenario nothing ran.
//
// The evidence is a runtime ledger, not a declaration: a hand-authored list of
// "scenarios this runner covers" is the very thing being guarded against.
// `test/support/conformance-manifest.cjs` registers every element of a corpus
// `scenarios` array against its fixture as the fixture is parsed, resolving the
// id in the corpus-wide fixed order (`id`, else `name`, else `#<n>`). These
// helpers hand the scenario OBJECT back to that registry, so a runner never
// names its own fixture and never spells its own scenario id — both are claims,
// and a claim rots.
//
// When the recorder is not attached (a plain `node --test` with no
// `LAZILY_CONFORMANCE_SCENARIO_MANIFEST`) every helper here is inert, so the
// suite behaves identically either way.

const recorder = () => globalThis.__lazilyConformanceScenarios ?? null;

/**
 * Mark `scenario` replayed.
 *
 * Call this at the TOP OF THE LOOP BODY, after any `continue` — a scenario the
 * runner skips must not record itself. Runners that select a scenario by name or
 * by index instead of iterating call it on the object they selected.
 *
 * Throws when the recorder is attached and the object is not a registered corpus
 * scenario. That is nearly always a runner replaying a `structuredClone` or a
 * hand-built stand-in: the fixture's own scenario would then never be marked and
 * the guard would report it as skipped, which is true but says nothing about
 * why. Failing here names the cause.
 */
export function recordScenario(scenario) {
  const rec = recorder();
  if (rec === null) return scenario;
  if (rec.record(scenario) === false) {
    throw new Error(
      "recordScenario: this object is not an element of a corpus fixture's `scenarios` " +
        "array. Mark the parsed fixture's own scenario object — a copy (structuredClone, " +
        "a spread, a hand-built stand-in) is not the thing the ledger tracks, and marking " +
        "one would credit a replay the guard cannot tie to the corpus.",
    );
  }
  return scenario;
}

/**
 * Iterate a fixture's scenarios, recording each one as it is yielded.
 *
 * This is the form to prefer: recording is automatic, so a new runner cannot
 * forget it, and a `break` out of the loop leaves the remaining scenarios
 * unrecorded — which is exactly true. A `continue` inside the body does NOT undo
 * the record, so a runner that means to skip a scenario must iterate
 * `fixture.scenarios` by hand and call `recordScenario` past the skip.
 */
export function* scenarios(fixture) {
  const list = fixture?.scenarios;
  if (!Array.isArray(list)) {
    throw new TypeError(`scenarios(): fixture has no \`scenarios\` array (got ${typeof list})`);
  }
  for (const scenario of list) {
    recordScenario(scenario);
    yield scenario;
  }
}
