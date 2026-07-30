#!/usr/bin/env node
// Assertion-key consumption guard (#lzassertunknownkeys).
//
// `check-conformance-coverage.sh` proves a canonical fixture was OPENED. This
// guard is the level below it: having opened the fixture, did the runner
// actually consume the assertion the fixture exists for?
//
// The failure it exists for is silent by construction. A runner reads named keys
// out of a fixture's `assertions` / `expect` / `expected` block and lets anything
// it does not recognise fall through. The fixture round-trips, the suite goes
// green, and the assertion proves nothing. JavaScript makes that path invisible
// twice over: `const {a, b} = fx.expect` and `if ("x" in a)` both read an absent
// or misspelled key as "not mine", so an assertion key no binding implements is
// skipped in silence in every runner at once.
//
// Evidence comes from the runtime recorder in `test/support/conformance-manifest.cjs`,
// which turns every key of a tracked block into an accessor and records the read.
// Like the coverage guard, this observes what the suite REALLY did rather than
// what its source claims: a runner that stops consuming a key is caught even if
// it still names it in a comment or a dead branch.
//
// A missing manifest is missing EVIDENCE and fails. It is not "no keys were
// read"; it means the suite was not run with the recorder attached, and passing
// in that state is exactly the vacuous green this guard exists to prevent.
//
// `invariants` blocks are NOT tracked, and that exemption is enforced rather than
// assumed: their values are English prose naming a property the fixture's `steps`
// encode, and the recorder throws if one ever carries a non-string, so a
// machine-checkable assertion cannot hide in the one block nothing checks.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SPEC_DIR = process.env.LAZILY_SPEC_CONFORMANCE_DIR ?? "../lazily-spec/conformance";
const KEY_MANIFEST =
  process.env.LAZILY_CONFORMANCE_KEY_MANIFEST ?? "build/conformance-assertion-keys.txt";
const FIXTURE_MANIFEST =
  process.env.LAZILY_CONFORMANCE_MANIFEST ?? "build/conformance-fixtures-loaded.txt";

// Assertion keys this binding knowingly does not consume. Every entry is a claim
// that someone looked, with the reason and the mechanism that will retire it.
// Adding one silently is how a guard rots, so the stale-entry checks below fail
// the build the moment an excuse outlives the gap it described.
//
// `key: "*"` means the whole fixture is unconsumed, which is only ever correct
// when the fixture is not replayed at all.
const DECLARED_UNCONSUMED = [
  // The six fixtures parked in `EXPECTED_SKIPS` in
  // `test/reactive-graph-conformance.test.js`. Five use the `merge_cell` op and
  // one asserts `drain_exhausted`; neither is modelled by any of the three
  // execution models, so `unsupportedReason` refuses the fixture BEFORE replay
  // and no key in it is reached. That ledger is asserted as an exact match in
  // both directions, so when the op and the drain keys are modelled it fails the
  // build until the entry is removed there — and these entries go stale here at
  // the same moment.
  ...[
    "exact_fold_paths_stay_exact.json",
    "merge_cell_acquires_no_dependency_edge.json",
    "merge_feed_through_a_formula_coalesces.json",
    "merge_folds_synchronously_in_batch.json",
    "merge_per_settled_cone_not_per_write.json",
    "feedback_drain_bound_reports_exhaustion.json",
  ].map((name) => ({
    fixture: `reactive-graph/${name}`,
    key: "*",
    reason: "parked in EXPECTED_SKIPS (unsupported op `merge_cell` / assertion `drain_exhausted`)",
  })),
];

const TRACKED = new Set(["assertions", "expect", "expected"]);

function fail(lines) {
  for (const line of lines) console.error(line);
}

if (!existsSync(SPEC_DIR)) {
  console.error(`SKIP: canonical corpus not found at ${SPEC_DIR} (clone the lazily-spec sibling)`);
  process.exit(0);
}

if (!existsSync(KEY_MANIFEST) || statSync(KEY_MANIFEST).size === 0) {
  fail([
    `FAIL: no assertion-key manifest at ${KEY_MANIFEST}.`,
    "      Run the suite with LAZILY_CONFORMANCE_KEY_MANIFEST set and the recorder",
    "      preloaded (see the `test` script in package.json). An absent manifest is",
    "      missing evidence, not evidence that every key was consumed.",
  ]);
  process.exit(1);
}

const present = new Set();
const read = new Set();
for (const line of readFileSync(KEY_MANIFEST, "utf8").split("\n")) {
  if (line.trim() === "") continue;
  const [fixture, block, key, tag] = line.split("\t");
  (tag === "R" ? read : present).add(`${fixture}\t${block}\t${key}`);
}

// Does a corpus fixture carry any tracked assertion block at all?
function hasTrackedBlock(value) {
  if (Array.isArray(value)) return value.some(hasTrackedBlock);
  if (value === null || typeof value !== "object") return false;
  for (const [key, child] of Object.entries(value)) {
    const isBlock =
      TRACKED.has(key) && child !== null && typeof child === "object" && !Array.isArray(child);
    if (isBlock && Object.keys(child).length > 0) return true;
    if (hasTrackedBlock(child)) return true;
  }
  return false;
}

let problems = 0;

// A fixture the suite opened whose keys produced no presence record at all means
// the recorder did not see the parse — the same missing-evidence shape as an
// absent manifest, one fixture at a time.
if (existsSync(FIXTURE_MANIFEST)) {
  const opened = new Set(
    readFileSync(FIXTURE_MANIFEST, "utf8").split("\n").map((l) => l.trim()).filter(Boolean),
  );
  for (const fixture of [...opened].sort()) {
    const path = join(SPEC_DIR, fixture);
    if (!existsSync(path)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    if (!hasTrackedBlock(parsed)) continue;
    const sawAny = [...present].some((entry) => entry.startsWith(`${fixture}\t`));
    if (!sawAny) {
      fail([
        `ERROR: '${fixture}' was opened by the suite and carries an assertion block,`,
        "       but the key recorder never saw it parsed. The bytes were read through a",
        "       path the recorder does not instrument, so nothing here can tell whether",
        "       its assertions were consumed. Load it with JSON.parse of the file text.",
      ]);
      problems += 1;
    }
  }
}

const declaredExact = new Map();
const declaredWhole = new Map();
for (const entry of DECLARED_UNCONSUMED) {
  if (entry.key === "*") declaredWhole.set(entry.fixture, entry);
  else declaredExact.set(`${entry.fixture}\t${entry.key}`, entry);
}

const excused = new Set();
let unread = 0;
let consumed = 0;
for (const entry of [...present].sort()) {
  const [fixture, block, key] = entry.split("\t");
  if (read.has(entry)) {
    consumed += 1;
    continue;
  }
  const whole = declaredWhole.get(fixture);
  const exact = declaredExact.get(`${fixture}\t${key}`);
  if (whole || exact) {
    excused.add(whole ? fixture : `${fixture}\t${key}`);
    continue;
  }
  fail([
    `ERROR: assertion key '${key}' in ${block} of '${fixture}' was NEVER CONSUMED.`,
    "       The fixture was replayed and this key was not read, so whatever it",
    "       asserts went unchecked while the suite reported green. Implement the",
    "       assertion, or declare it in DECLARED_UNCONSUMED in this script with the",
    "       capability that is genuinely missing.",
  ]);
  unread += 1;
  problems += 1;
}

// A stale excuse is its own drift, in both directions: an entry naming a fixture
// or key the corpus no longer has means the corpus moved and nobody updated the
// claim, and an entry naming something the suite DOES consume means the gap it
// described is already closed while the guard keeps reporting it as open.
for (const entry of DECLARED_UNCONSUMED) {
  const path = join(SPEC_DIR, entry.fixture);
  if (!existsSync(path)) {
    fail([
      `ERROR: DECLARED_UNCONSUMED lists '${entry.fixture}', which is not in the canonical corpus.`,
    ]);
    problems += 1;
    continue;
  }
  const id = entry.key === "*" ? entry.fixture : `${entry.fixture}\t${entry.key}`;
  if (!excused.has(id)) {
    fail([
      `ERROR: DECLARED_UNCONSUMED lists '${entry.fixture}'`
        + (entry.key === "*" ? "" : ` key '${entry.key}'`)
        + ", but nothing there is unconsumed.",
      `       Reason on file: ${entry.reason}`,
      "       The excuse is stale — the suite either consumes it now or no longer",
      "       carries it. Delete the entry; an excuse left behind understates",
      "       coverage and hides the fact that the gap it named is already closed.",
    ]);
    problems += 1;
  }
}

if (problems > 0) {
  console.error(`assertion-key consumption FAILED: ${problems} problem(s), ${unread} unread key(s)`);
  process.exit(1);
}

console.error(
  `assertion-key consumption OK: ${consumed}/${present.size} fixture assertion keys CONSUMED by the`
  + ` suite (${excused.size} declared unconsumed; runtime manifest — these values were really read)`,
);
