#!/usr/bin/env node
// Assertion-key consumption guard (#lzassertunknownkeys, #lzconsumednotasserted).
//
// Three rungs of the same ladder, each proving what the one above it assumes:
//
//   1. `check-conformance-coverage.sh`  — the fixture was OPENED.
//   2. this guard, unconsumed-key half  — every assertion key was READ.
//   3. this guard, unasserted-key half  — every read key reached a COMPARISON
//                                         against the fixture's own value.
//   4. `check-scenario-coverage.mjs`     — every SCENARIO of the fixture was
//                                         replayed. Rungs 2-3 bind only the
//                                         blocks a runner reaches, so a whole
//                                         unreplayed scenario is invisible here.
//
// Rung 3 exists because a read is not an assertion. A runner can iterate the
// block (marking every key read) and `continue` past one; bind a value and never
// compare it; or read the key and then assert against a hardcoded literal so that
// editing the fixture changes nothing. All three report green at rung 2.
//
// Evidence for rung 3 cannot come from watching property access, so it comes from
// the runner: `test/support/assert-key.js` is the only path that marks a key
// asserted, and `excuseKey(block, key, reason)` is the only way to declare a key
// unassertable at its call site. Runner excuses go stale in BOTH directions, as
// the static allowlist below does — an excuse for a key the same run also asserts
// fails the build, because it is hiding nothing.
//
// Rung 2's failure is silent by construction. A runner reads named keys out of a
// fixture's `assertions` / `expect` / `expected` block and lets anything it does
// not recognise fall through. The fixture round-trips, the suite goes green, and
// the assertion proves nothing. JavaScript makes that path invisible twice over:
// `const {a, b} = fx.expect` and `if ("x" in a)` both read an absent or
// misspelled key as "not mine", so an assertion key no binding implements is
// skipped in silence in every runner at once.
//
// Evidence for rung 2 comes from the runtime recorder in `test/support/conformance-manifest.cjs`,
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
// The finest of three allowlists at three resolutions — see `KNOWN_UNCOVERED` in
// check-conformance-coverage.sh (whole fixtures) and `EXCUSED_SCENARIOS` in
// check-scenario-coverage.mjs (single scenarios of an opened fixture).
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

const TRACKED = new Set(["assertions", "expect", "expected", "expect_initial", "expect_after"]);

function fail(lines) {
  for (const line of lines) console.error(line);
}

// A missing corpus is a legitimate local state (no sibling checkout) and an
// illegitimate CI state (#lzvacuousrun) — the same split rungs 1 and 4 make. Every
// check below reasons about keys of blocks the run REACHED, so an absent corpus
// reports OK over nothing at all. This mirrors how the missing MANIFEST below is
// already treated: missing evidence, not evidence of absence.
if (!existsSync(SPEC_DIR)) {
  if (process.env.CI) {
    fail([
      `ERROR: canonical corpus not found at ${SPEC_DIR}, and CI is set.`,
      "       Under CI this is missing EVIDENCE, not evidence of absence: the checkout",
      "       is wrong, not the corpus. Exiting 0 here would report assertion-key",
      "       coverage OK having examined zero fixtures (#lzvacuousrun).",
    ]);
    process.exit(1);
  }
  console.error(`SKIP: canonical corpus not found at ${SPEC_DIR} (clone the lazily-spec sibling)`);
  console.error("      Local checkout only — this would be a hard failure under CI.");
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
const asserted = new Set();
const excusedInRunner = new Map();
// Prose keys the run DISCHARGED, and the fixtures whose discharge claims were
// really verified (#lzprosekeyconvention). Rules 1-7 are checked at runtime by
// `verifyProse` in test/support/assert-key.js, because only the run knows which
// keys it asserted. What this script adds is the one thing a runtime check
// cannot do for itself: notice that the verification never ran at all.
const dischargedInRunner = new Map();
const verifiedFixtures = new Set();
for (const line of readFileSync(KEY_MANIFEST, "utf8").split("\n")) {
  if (line.trim() === "") continue;
  const [fixture, block, key, tag, reason] = line.split("\t");
  const id = `${fixture}\t${block}\t${key}`;
  if (tag === "R") read.add(id);
  else if (tag === "A") asserted.add(id);
  else if (tag === "X") excusedInRunner.set(id, reason ?? "");
  else if (tag === "D") dischargedInRunner.set(id, reason ?? "");
  else if (tag === "V") verifiedFixtures.add(fixture);
  else present.add(id);
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
    readFileSync(FIXTURE_MANIFEST, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
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
    // A fixture whose corpus block declares `prose` must have reached
    // `verifyProse` (#lzprosekeyconvention). Rules 1-7 are runtime checks, so a
    // runner that discharges nothing and never verifies would otherwise be
    // reported only through the unconsumed `prose` key — true, but silent about
    // the cause. An UNVERIFIED discharge claim is as bad as an unconsumed key:
    // the claim was recorded and nothing ever checked it.
    if (sawAny && Array.isArray(parsed?.assertions?.prose) && !verifiedFixtures.has(fixture)) {
      fail([
        `ERROR: '${fixture}' declares \`assertions.prose\` and its replay never called`,
        "       verifyProse(fixture). The discharge claims this run recorded were never",
        "       checked against what it asserted, so every one of them is a free-text",
        "       excuse again. Call verifyProse(fixture) at the end of the replay.",
      ]);
      problems += 1;
    }
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
let unasserted = 0;
let stale = 0;
let consumed = 0;
let declaredHere = 0;
let dischargedHere = 0;
for (const entry of [...present].sort()) {
  const [fixture, block, key] = entry.split("\t");
  const runnerExcuse = excusedInRunner.get(entry);
  const runnerDischarge = dischargedInRunner.get(entry);

  // A prose key is discharged, never asserted and never excused. Both collisions
  // are runtime failures in `verifyProse` (rules 1 and 2); they are repeated here
  // because this script reads the manifest of a run that may have been assembled
  // from several processes, and two paths satisfying one key is the ambiguity the
  // convention removes.
  if (runnerDischarge !== undefined && (asserted.has(entry) || runnerExcuse !== undefined)) {
    fail([
      `ERROR: assertion key '${key}' in ${block} of '${fixture}' is DISCHARGED as prose and`,
      `       also ${asserted.has(entry) ? "ASSERTED" : "EXCUSED"} in the same run.`,
      `       Discharged by: ${runnerDischarge}`,
      "       A prose key has exactly one treatment. Delete the other call.",
    ]);
    stale += 1;
    problems += 1;
    continue;
  }
  if (runnerDischarge !== undefined) {
    dischargedHere += 1;
    continue;
  }

  // A runner excuse is stale in both directions, exactly as the static allowlist
  // is. An excuse for a key the same run also asserts is hiding nothing, and
  // leaving it behind understates what this binding checks.
  if (runnerExcuse !== undefined && asserted.has(entry)) {
    fail([
      `ERROR: assertion key '${key}' in ${block} of '${fixture}' is EXCUSED and ASSERTED`,
      "       in the same run.",
      `       Reason on file: ${runnerExcuse}`,
      "       The excuse is stale — the gap it named is already closed. Delete the",
      "       excuseKey() call; an excuse that hides nothing understates coverage.",
    ]);
    stale += 1;
    problems += 1;
    continue;
  }
  if (runnerExcuse !== undefined) {
    declaredHere += 1;
    continue;
  }

  if (asserted.has(entry)) {
    consumed += 1;
    continue;
  }

  // Read but never asserted — the defect this rung exists for. The key reached a
  // runner and the runner did nothing with the value.
  if (read.has(entry)) {
    fail([
      `ERROR: assertion key '${key}' in ${block} of '${fixture}' was READ BUT NEVER ASSERTED.`,
      "       Something fetched this value and no comparison against it followed, so",
      "       editing the fixture here changes no outcome. Route it through",
      "       assertKey/assertKeyWith in test/support/assert-key.js, or declare the",
      "       exception with excuseKey(block, key, reason).",
    ]);
    unasserted += 1;
    problems += 1;
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

// An excuse naming a key the corpus no longer carries is the other half of the
// staleness rule: the manifest has no presence record for it at all.
for (const [entry, reason] of [...excusedInRunner].sort()) {
  if (present.has(entry)) continue;
  const [fixture, block, key] = entry.split("\t");
  fail([
    `ERROR: excuseKey names '${key}' in ${block} of '${fixture}', which the corpus`,
    "       no longer carries as a tracked assertion key.",
    `       Reason on file: ${reason}`,
    "       Delete the call — the fixture moved and the excuse outlived it.",
  ]);
  stale += 1;
  problems += 1;
}

// The same staleness rule for a discharge: the corpus stopped declaring the key
// prose, or stopped carrying it at all, and the claim outlived it.
for (const [entry, names] of [...dischargedInRunner].sort()) {
  if (present.has(entry)) continue;
  const [fixture, block, key] = entry.split("\t");
  fail([
    `ERROR: proseKey names '${key}' in ${block} of '${fixture}', which the corpus no longer`,
    "       carries as a tracked assertion key.",
    `       Discharged by: ${names}`,
    "       Delete the call — the fixture moved and the discharge outlived it.",
  ]);
  stale += 1;
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
      `ERROR: DECLARED_UNCONSUMED lists '${entry.fixture}'` +
        (entry.key === "*" ? "" : ` key '${entry.key}'`) +
        ", but nothing there is unconsumed.",
      `       Reason on file: ${entry.reason}`,
      "       The excuse is stale — the suite either consumes it now or no longer",
      "       carries it. Delete the entry; an excuse left behind understates",
      "       coverage and hides the fact that the gap it named is already closed.",
    ]);
    problems += 1;
  }
}

if (problems > 0) {
  console.error(
    `assertion-key consumption FAILED: ${problems} problem(s), ${unread} unread key(s),` +
      ` ${unasserted} read-but-unasserted key(s), ${stale} stale excuse(s)`,
  );
  process.exit(1);
}

// ---- Positive-evidence floor (#lzvacuousrun) ----
// Every check above walks the keys the recorder actually saw. An empty manifest
// population satisfies all of it at once: zero present keys means zero unread
// keys, zero read-but-unasserted keys, and zero stale excuses, and the loop
// reports "OK: 0/0" having compared nothing. The missing-corpus and
// missing-manifest branches above only catch the two coarsest shapes of that —
// no sibling checkout, and a manifest file that is absent or byte-empty. A
// manifest that is present and NON-empty but short (the recorder detached
// partway, a test file stopped being collected, `TRACKED` stopped matching the
// block names the corpus uses) walks a small-but-nonzero population and still
// prints OK. That is the same hole MIN_FIXTURES and MIN_SCENARIOS close one and
// two rungs up; this is the assertion-key rung of the same ladder.
//
// 546 = calibrated below the observed run, which asserts 573 of 612 present keys.
// Deliberately set under the real number so ordinary corpus churn does not trip
// it, and far enough above zero that a detached recorder cannot slip through.
// (Was 520 against an observed 547/575; codec/blob_backend_discriminator.json
// added 15 asserted keys, #lzblobbackendstrict, so the floor moved by 15 and
// kept the same margin. Was 535 against an observed 562/596; that fixture's v2
// hardening replaced `expect.epoch` with `frame_epoch` + `blob_epoch` and added
// `rejection_kind`, `rejection_is_decode_error`, `backend_forms` and
// `rejection_kinds`, so the observed run goes to 567 and the floor moves by the
// same five. Was 540 against an observed 567/605; #lzprosekeyconvention added
// `assertions.prose` to five codec fixtures — each one asserted by the
// `verifyProse` comparison — unhid `note` in the two frame_roundtrip fixtures,
// and turned `nodeid_exact_range.json`'s `outcomes` from an excuse into a
// key-set assertion, so the observed run goes to 573/612 and the floor moves by
// the same six.) NEVER lower this to make the gate green: a drop means keys
// stopped being reached or stopped being asserted, and that is the finding, not
// the floor.
const MIN_ASSERTED_KEYS = Number(process.env.MIN_ASSERTED_KEYS ?? "546");
if (present.size === 0) {
  fail([
    "ERROR: the manifest recorded ZERO tracked assertion keys.",
    "       Every check above is vacuously green over an empty population — no key",
    "       can go unconsumed when none was observed (#lzvacuousrun). The recorder",
    "       ran without seeing a fixture parse, or no tracked block name",
    `       (${[...TRACKED].join(", ")}) matched what the corpus carries. Neither is coverage.`,
  ]);
  process.exit(1);
}
if (consumed < MIN_ASSERTED_KEYS) {
  fail([
    `ERROR: only ${consumed} assertion keys were ASSERTED, expected >= ${MIN_ASSERTED_KEYS}.`,
    "       A runner stopped comparing values, a test file stopped being collected,",
    "       or the recorder detached mid-run. Do not lower MIN_ASSERTED_KEYS to fix",
    "       this — the drop is the finding.",
  ]);
  process.exit(1);
}

console.error(
  `assertion-key consumption OK: ${consumed}/${present.size} fixture assertion keys ASSERTED against` +
    ` their own fixture value by the suite (${declaredHere} excused in-runner,` +
    ` ${dischargedHere} prose keys discharged across ${verifiedFixtures.size} verified fixture(s),` +
    ` ${excused.size} declared unconsumed; floor ${MIN_ASSERTED_KEYS};` +
    ` runtime manifest — these values were really compared)`,
);
