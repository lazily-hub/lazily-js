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
// In this binding it was worse than invisible. Key records were keyed by
// `fixture\t<bare block name>\tkey`, so sibling scenarios that share an `expect`
// key name masked each other: `collections/stableid_alignment.json` scenario
// "anchored key survives full body rewrite" fell straight through the runner's
// name-matching if/else chain, and its `key_equal` was already marked asserted by
// the scenario before it. Two guards, both green, over a scenario nothing ran.
//
// That particular masking is gone — the `block` component of a key record is now
// the block's JSON PATH, so `scenarios[0].expect` and `scenarios[1].expect` are
// distinct records (#lzjsblocknamemasking). This rung is NOT thereby redundant.
// It reports the scenario nothing entered at all, which even a fully
// path-qualified key ledger cannot: an unreplayed scenario's keys are not
// unasserted, nothing reads them, so the rungs below still see exactly nothing.
// De-masking turns the failure from "another scenario covered for it" into "this
// scenario reports nothing", and naming it is this guard's job.
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

const SPEC_DIR_OVERRIDDEN = process.env.LAZILY_SPEC_CONFORMANCE_DIR !== undefined;
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
// An EXPLICIT override that cannot be read is never a skip and never a fallback
// (#lzoverrideallrunners). This branch runs before the local-skip branch so the
// skip cannot swallow it.
if (SPEC_DIR_OVERRIDDEN && !existsSync(SPEC_DIR)) {
  fail([
    `ERROR: LAZILY_SPEC_CONFORMANCE_DIR is set to '${SPEC_DIR}' but that is not a`,
    "       readable directory. An explicit corpus override must fail closed: falling",
    "       back to the canonical sibling would audit a corpus nobody asked for, and",
    "       skipping would report OK over zero scenarios (#lzvacuousrun).",
  ]);
  process.exit(1);
}

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
//   1. `id` if present   2. else `name` if present.
//
// There is no third step (#lzspecscenarioids). The positional `#<n>` fallback
// let this guard identify a scenario BY POSITION, which silently rebinds to a
// different scenario when the corpus array is reordered — the ledger says "index
// 1 was replayed", this reader looks at whatever now sits at index 1, and the two
// agree with each other about the wrong thing. An unidentified scenario is a
// problem to report, not an id to invent.
function resolveId(scenario, index) {
  const identifier = (value) =>
    typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  if (scenario !== null && typeof scenario === "object" && !Array.isArray(scenario)) {
    const id = identifier(scenario.id);
    if (id !== "") return { id, unidentified: false };
    const name = identifier(scenario.name);
    if (name !== "") return { id: name, unidentified: false };
  }
  return { id: `#${index}`, unidentified: true };
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

// fixture -> ordered [{ id, unidentified }], for every corpus fixture that carries a
// `scenarios` array. Read from DISK, never from the ledger: the ledger is what
// the run claims, and the corpus is what it has to account for.
const corpusScenarios = new Map();
for (const fixture of corpusFixtures()) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(SPEC_DIR, fixture), "utf8"));
  } catch (error) {
    // The only unnamed swallow in this ladder used to live here: `catch { continue; }`
    // dropped an unparseable corpus fixture without saying which one
    // (#lzjsscenarioswallow). It could not hide a coverage gap — rung 1 still
    // demands the file be opened, and any runner that opens it dies on
    // JSON.parse — but a fixture that vanishes from scenario accounting without
    // naming itself is the shape every other rung here refuses. A corpus file
    // that is PRESENT but unreadable is a broken input, not the absent-corpus
    // case this script skips on a checkout without the sibling.
    console.error(
      `ERROR: canonical fixture '${fixture}' (${join(SPEC_DIR, fixture)}) is not valid JSON: ${error.message}\n` +
        `       It is PRESENT but unusable, so scenario coverage computed without it\n` +
        `       would be an undercount reported as a pass. Restore it from a clean\n` +
        `       lazily-spec checkout. If this is a perturbation probe under\n` +
        `       LAZILY_SPEC_CONFORMANCE_DIR, the PROBE is broken: a truncated fixture perturbs nothing\n` +
        `       a runner can disagree with — flip an assertion VALUE instead.`,
    );
    process.exit(1);
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

  for (const { id, unidentified } of ids) {
    total += 1;
    if (unidentified) {
      fail([
        `ERROR: '${fixture}' scenario at ${id} carries neither \`id\` nor \`name\`.`,
        "       The ledger would record it by POSITION, which silently rebinds on a",
        "       corpus reorder. Give it a stable id upstream in lazily-spec",
        "       (#lzspecscenarioids).",
      ]);
      problems += 1;
      continue;
    }
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
// PINNED TO REALITY (#lzscenariofloordrift). This floor equals what CI actually
// replays, with NO margin: the run that pinned it REPLAYED exactly 155
// scenarios, and 156 fails. (153 -> 155: the two lossless-tree apply_update
// fixtures lazily-spec 39df4b3 added carry one scenario each,
// #lzspecoutoforderfixtures.)
//
// It replaces the convention this comment used to record -- "its eight
// scenarios took the observed run from 118 to 126, so the floor moves by the
// same eight and keeps the margin it had". Raising by the delta and preserving
// the margin means the gap never closes, only widens; here it had reached 23.
// A floor 23 below reality tolerates 23 scenarios silently detaching, which is
// precisely what this floor is for.
//
// When the corpus moves, re-derive from the gate's own output instead of adding
// a delta: run `make check`, read the "scenario replay OK: <n>/..." line, set
// this to that <n>, then prove it exact by setting it to <n>+1 and watching
// this guard fail. A floor you never watched fail is a floor you have not
// verified.
const MIN_SCENARIOS = Number(process.env.MIN_SCENARIOS ?? "155");
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
    ` opened scenario-bearing fixtures (${excusedOk} excused;` +
    " runtime ledger — these scenarios were really run)",
);
