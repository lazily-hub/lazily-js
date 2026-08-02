#!/usr/bin/env node
// Per-scenario replay guard (#lzscenariocoverage).
//
// Rung 4 of the conformance ladder:
//
//   1. `check-conformance-coverage.sh`  — the fixture FILE was opened.
//   2. `check-assertion-keys.mjs`       — every assertion key of a block the
//   3. `check-assertion-keys.mjs`       — runner reached was READ, and reached a
//                                         COMPARISON against its own value.
//   4. this guard                       — every SCENARIO in the fixture was
//                                         REPLAYED.
//
// The defect rung 4 exists for: a fixture with several named scenarios can be
// PARTIALLY replayed and nothing notices. Both guards below it are blind to that
// by construction — rung 1 asks only whether the file was opened, and one
// scenario is enough; rungs 2-3 bind only the blocks a runner actually reaches,
// so an unreplayed scenario contributes no unconsumed key and no unasserted key.
// Skipping a whole scenario is invisible to a guard that only inspects the
// scenarios you ran.
//
// In this binding it was worse than invisible. Key records are keyed by
// `fixture\tblock\tkey`, so sibling scenarios that share an `expect` key name
// mask each other: `collections/stableid_alignment.json` scenario "anchored key
// survives full body rewrite" fell straight through the runner's name-matching
// if/else chain, and its `key_equal` was already marked asserted by the scenario
// before it. Two guards, both green, over a scenario nothing ran.
//
// The evidence is the RUNTIME ledger in
// `build/conformance-scenarios.txt`, written by
// `test/support/conformance-manifest.cjs` and marked through
// `test/support/scenario.js`. It records what the suite REALLY replayed, in the
// same spirit as the fixture manifest and the key manifest. A hand-authored list
// of "scenarios this binding covers" is the thing being guarded against: it is a
// claim, and a claim rots.
//
// A missing manifest is missing EVIDENCE and fails. It is not "no scenarios were
// replayed"; it means the suite was not run with the recorder attached, and
// passing in that state is the vacuous green the whole ladder exists to prevent.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SPEC_DIR = process.env.LAZILY_SPEC_CONFORMANCE_DIR ?? "../lazily-spec/conformance";
const SCENARIO_MANIFEST =
  process.env.LAZILY_CONFORMANCE_SCENARIO_MANIFEST ?? "build/conformance-scenarios.txt";
const FIXTURE_MANIFEST =
  process.env.LAZILY_CONFORMANCE_MANIFEST ?? "build/conformance-fixtures-loaded.txt";

/**
 * Declare that this binding does not replay one scenario of a fixture it DOES
 * open, and why.
 *
 * This is the fallback, not the default: prefer implementing the scenario. An
 * excuse is the shape a permanent gap takes — a capability this binding cannot
 * express — not a shape for "not done yet".
 *
 * Excuses go stale in BOTH directions, exactly as `KNOWN_UNCOVERED` in
 * `check-conformance-coverage.sh` and `DECLARED_UNCONSUMED` in
 * `check-assertion-keys.mjs` do: an excuse for a scenario the same run DID
 * replay fails, because it is hiding nothing and understates what this binding
 * proves; and an excuse naming an id the fixture does not carry fails, because
 * the corpus moved and the excuse outlived it.
 */
function excuseScenario(fixture, id, reason) {
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new Error(
      `excuseScenario(${fixture}, ${id}): a reason is required. An undeclared exception ` +
        "is the silent skip this guard exists to catch.",
    );
  }
  return { fixture, id, reason: reason.replace(/\s+/g, " ").trim() };
}

// Scenarios this binding knowingly does not replay. Read this list together with
// `KNOWN_UNCOVERED` in `scripts/check-conformance-coverage.sh` (whole fixtures
// this binding does not open) and `DECLARED_UNCONSUMED` in
// `scripts/check-assertion-keys.mjs` (assertion keys it does not consume) — the
// three are the same allowlist at three resolutions, and between them they are
// the complete statement of what lazily-js does not prove against the canonical
// corpus.
//
// A scenario inside a fixture listed in `KNOWN_UNCOVERED` does NOT belong here:
// that fixture is never opened, rung 1 already reports it, and an excuse would
// double-count the same gap. Excusing an unopened fixture's scenario fails.
const EXCUSED_SCENARIOS = [];

function fail(lines) {
  for (const line of lines) console.error(line);
}

// A missing corpus is a legitimate local state (no sibling checkout) and an
// illegitimate CI state (#lzvacuousrun). Skipping under CI is the vacuous green
// this rung exists to prevent: every check below walks the scenarios of fixtures
// the run OPENED, so an absent corpus reports OK over nothing at all — zero
// opened fixtures means zero unreplayed scenarios and zero stale excuses, so
// nothing else here can contradict it. This mirrors how a missing MANIFEST is
// already treated below: missing evidence, not evidence of absence. Locally it
// stays a skip, because a contributor without the sibling is not making a false
// claim.
if (!existsSync(SPEC_DIR)) {
  if (process.env.CI) {
    fail([
      `ERROR: canonical corpus not found at ${SPEC_DIR}, and CI is set.`,
      "       Under CI this is missing EVIDENCE, not evidence of absence: the checkout",
      "       is wrong, not the corpus. Exiting 0 here would report scenario replay OK",
      "       having compared zero scenarios (#lzvacuousrun).",
    ]);
    process.exit(1);
  }
  console.error(`SKIP: canonical corpus not found at ${SPEC_DIR} (clone the lazily-spec sibling)`);
  console.error("      Local checkout only — this would be a hard failure under CI.");
  process.exit(0);
}

if (!existsSync(SCENARIO_MANIFEST) || statSync(SCENARIO_MANIFEST).size === 0) {
  fail([
    `FAIL: no scenario manifest at ${SCENARIO_MANIFEST}.`,
    "      Run the suite with LAZILY_CONFORMANCE_SCENARIO_MANIFEST set and the recorder",
    "      preloaded (see the `test` script in package.json). An absent manifest is",
    "      missing evidence, not evidence that every scenario was replayed.",
  ]);
  process.exit(1);
}

if (!existsSync(FIXTURE_MANIFEST) || statSync(FIXTURE_MANIFEST).size === 0) {
  fail([
    `FAIL: no fixture manifest at ${FIXTURE_MANIFEST}.`,
    "      This guard checks the scenarios of every fixture the suite opened, so",
    "      without that list it cannot tell a fully-replayed run from an empty one.",
  ]);
  process.exit(1);
}

const replayed = new Set(
  readFileSync(SCENARIO_MANIFEST, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean),
);
const opened = new Set(
  readFileSync(FIXTURE_MANIFEST, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean),
);

// The corpus-wide fixed resolution order, identical in every binding:
//   1. `id` if present   2. else `name` if present   3. else `#<n>` (0-based).
function resolveId(scenario, index) {
  if (scenario === null || typeof scenario !== "object" || Array.isArray(scenario)) {
    return { id: `#${index}`, fallback: true };
  }
  if (scenario.id !== undefined && scenario.id !== null) {
    return { id: String(scenario.id), fallback: false };
  }
  if (scenario.name !== undefined && scenario.name !== null) {
    return { id: String(scenario.name), fallback: false };
  }
  return { id: `#${index}`, fallback: true };
}

function corpusFixtures() {
  const found = [];
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.name.endsWith(".json")) found.push(rel);
    }
  };
  walk(SPEC_DIR, "");
  return found.sort();
}

// fixture -> ordered [{ id, fallback }], for every corpus fixture that carries a
// `scenarios` array. Read from DISK, never from the ledger: the ledger is what
// the run claims, and the corpus is what it has to account for.
const corpusScenarios = new Map();
for (const fixture of corpusFixtures()) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(SPEC_DIR, fixture), "utf8"));
  } catch {
    continue;
  }
  if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.scenarios)) continue;
  corpusScenarios.set(
    fixture,
    parsed.scenarios.map((s, i) => resolveId(s, i)),
  );
}

const excusedByFixture = new Map();
for (const entry of EXCUSED_SCENARIOS) {
  const key = `${entry.fixture}\t${entry.id}`;
  if (excusedByFixture.has(key)) {
    fail([`ERROR: EXCUSED_SCENARIOS lists '${entry.fixture}' scenario '${entry.id}' twice.`]);
    process.exit(1);
  }
  excusedByFixture.set(key, entry);
}

let problems = 0;
let covered = 0;
let total = 0;
let excusedOk = 0;
const positional = [];
const checkedFixtures = [];

for (const [fixture, ids] of [...corpusScenarios].sort()) {
  if (!opened.has(fixture)) continue;
  checkedFixtures.push(fixture);

  // Two scenarios resolving to the same id are indistinguishable in the ledger:
  // replaying one would credit both. That is a corpus-shaped hole in this guard's
  // evidence, so it fails rather than quietly halving the count.
  const seen = new Set();
  for (const { id } of ids) {
    if (seen.has(id)) {
      fail([
        `ERROR: '${fixture}' carries two scenarios that both resolve to the id '${id}'.`,
        "       The ledger cannot tell them apart, so replaying one would credit both.",
        "       Give them distinct `id`/`name` values upstream in lazily-spec.",
      ]);
      problems += 1;
    }
    seen.add(id);
  }

  for (const { id, fallback } of ids) {
    total += 1;
    if (fallback) positional.push(`${fixture} ${id}`);
    const key = `${fixture}\t${id}`;
    const excuse = excusedByFixture.get(key);
    const didReplay = replayed.has(key);

    if (excuse !== undefined && didReplay) {
      fail([
        `ERROR: scenario '${id}' of '${fixture}' is EXCUSED and REPLAYED in the same run.`,
        `       Reason on file: ${excuse.reason}`,
        "       The excuse is stale — the gap it named is already closed. Delete the",
        "       excuseScenario() entry; an excuse that hides nothing understates coverage.",
      ]);
      problems += 1;
      continue;
    }
    if (didReplay) {
      covered += 1;
      continue;
    }
    if (excuse !== undefined) {
      excusedOk += 1;
      continue;
    }
    fail([
      `ERROR: scenario '${id}' of '${fixture}' was NEVER REPLAYED.`,
      "       The suite opened this fixture and ran some other scenario in it, so both",
      "       the coverage guard and the assertion-key guard report green while whatever",
      "       this scenario pins goes unchecked. Replay it, or declare it with",
      "       excuseScenario() in this script naming the capability that is missing.",
    ]);
    problems += 1;
  }
}

// A ledger entry the corpus cannot account for means the recorder attributed a
// replay to a fixture/id pair that is not there — drift in the instrument itself,
// which would otherwise inflate the covered count in silence.
for (const key of [...replayed].sort()) {
  const [fixture, id] = key.split("\t");
  const ids = corpusScenarios.get(fixture);
  if (ids !== undefined && ids.some((s) => s.id === id)) continue;
  fail([
    `ERROR: the ledger records a replay of scenario '${id}' in '${fixture}', which the`,
    "       canonical corpus does not carry. The recorder attributed a replay to",
    "       something that is not a corpus scenario; the covered count below cannot be",
    "       trusted until that is explained.",
  ]);
  problems += 1;
}

// The other half of the both-directions rule for the excuse list itself.
for (const entry of EXCUSED_SCENARIOS) {
  const ids = corpusScenarios.get(entry.fixture);
  if (ids === undefined) {
    fail([
      `ERROR: excuseScenario names '${entry.fixture}', which the canonical corpus does not`,
      "       carry as a fixture with scenarios.",
      `       Reason on file: ${entry.reason}`,
      "       Delete the entry — the corpus moved and the excuse outlived it.",
    ]);
    problems += 1;
    continue;
  }
  if (!ids.some((s) => s.id === entry.id)) {
    fail([
      `ERROR: excuseScenario names scenario '${entry.id}' of '${entry.fixture}', which that`,
      "       fixture does not carry. Resolution order is `id`, else `name`, else `#<n>`.",
      `       Reason on file: ${entry.reason}`,
      `       Ids it does carry: ${ids.map((s) => s.id).join(", ")}`,
      "       Delete or correct the entry — a stale excuse hides a real gap.",
    ]);
    problems += 1;
    continue;
  }
  if (!opened.has(entry.fixture)) {
    fail([
      `ERROR: excuseScenario names '${entry.fixture}', which the suite never opened at all.`,
      `       Reason on file: ${entry.reason}`,
      "       A fixture nobody replays is already reported by the coverage guard's",
      "       KNOWN_UNCOVERED list; excusing one of its scenarios here double-counts the",
      "       same gap and makes the scenario ledger read as more complete than it is.",
    ]);
    problems += 1;
  }
}

// The positional fallback is REPORTED, never silently accepted. It exists so this
// rung is not blocked on a shared-corpus edit — `collections/mergecell_algebra.json`
// distinguishes its scenarios only by `policy` — and this output is what keeps the
// corpus gap visible so it can be fixed upstream in lazily-spec.
if (positional.length > 0) {
  console.error(
    `NOTE: ${positional.length} scenario(s) have neither \`id\` nor \`name\` and were` +
      " identified by POSITION, which is not stable under a corpus reorder:",
  );
  for (const entry of positional) console.error(`      ${entry}`);
  console.error(
    "      Fixing that is an upstream lazily-spec change (add `id`/`name`), out of scope here.",
  );
}

if (problems > 0) {
  console.error(
    `scenario replay FAILED: ${problems} problem(s); ${covered}/${total} scenarios replayed` +
      ` across ${checkedFixtures.length} opened fixture(s)`,
  );
  process.exit(1);
}

// ---- Positive-evidence floor (#lzvacuousrun) ----
// Every check above walks the scenarios of OPENED fixtures. Zero opened fixtures
// means zero scenarios, which means zero unreplayed scenarios and zero stale
// excuses, which reports OK having compared nothing. The loop cannot distinguish
// "nothing is wrong" from "nothing was examined", so assert the magnitude before
// claiming green. Do not lower MIN_SCENARIOS to fix a red run — a drop here means
// a scenario dispatch stopped matching or the ledger detached, which is the
// finding.
const MIN_SCENARIOS = Number(process.env.MIN_SCENARIOS ?? "110");
if (total === 0) {
  fail([
    "ERROR: ZERO scenarios were found across the opened fixtures.",
    "       Every check above is vacuously green over an empty population: no",
    "       scenario can go unreplayed when none was examined (#lzvacuousrun).",
  ]);
  process.exit(1);
}
if (covered < MIN_SCENARIOS) {
  fail([
    `ERROR: only ${covered} distinct scenarios were REPLAYED, expected >= ${MIN_SCENARIOS}.`,
    "       A scenario dispatch stopped matching, or the ledger detached mid-run.",
    "       Do not lower MIN_SCENARIOS to fix this.",
  ]);
  process.exit(1);
}

console.error(
  `scenario replay OK: ${covered}/${total} scenarios REPLAYED across ${checkedFixtures.length}` +
    ` opened scenario-bearing fixtures (${excusedOk} excused, ${positional.length} identified by` +
    " position; runtime ledger — these scenarios were really run)",
);
