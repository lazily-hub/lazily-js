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

const SPEC_DIR_OVERRIDDEN = process.env.LAZILY_SPEC_CONFORMANCE_DIR !== undefined;
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
// An EXPLICIT override that cannot be read is never a skip and never a fallback
// (#lzoverrideallrunners). This branch runs before the local-skip branch so the
// skip cannot swallow it.
if (SPEC_DIR_OVERRIDDEN && !existsSync(SPEC_DIR)) {
  fail([
    `ERROR: LAZILY_SPEC_CONFORMANCE_DIR is set to '${SPEC_DIR}' but that is not a`,
    "       readable directory. An explicit corpus override must fail closed: falling",
    "       back to the canonical sibling would audit a corpus nobody asked for, and",
    "       skipping would report OK over zero fixtures (#lzvacuousrun).",
  ]);
  process.exit(1);
}

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
// Rung 3b (#lzsubblockkeyset). `objectValued` is declared off the CORPUS BYTES by
// the recorder at parse time — it is a fact about the fixture, not a claim by a
// runner. `keySetChecked` is the runner side: the key was consumed by a
// comparison that binds its whole key set (a deep equality, a descent, or an
// explicit key-set assertion) rather than by a closure that may have named a few
// sub-fields and stopped.
const objectValued = new Set();
const keySetChecked = new Set();
// Rung 3c (#lzunboundblockguard). `assertKeyWith` hands the fixture value to an
// opaque closure, and the mark used to ride on the CALL. lazily-spec's
// `check-assert-with-consumption.py` already rejects a callback whose parameter
// never occurs in its body; what no source parser can see is a parameter that is
// mentioned and never DEREFERENCED — `(want) => assert.ok(want !== null)` reads
// `want`, satisfies that gate, and compares nothing about the fixture's
// contents. So the helper wraps an object or array value in a recording Proxy
// and records `N` instead of `A` when the check never touched it.
const untouchedByCheck = new Set();
// A key record is `fixture \t block \t key`, and `block` is the block's JSON PATH
// — `frames[3].assertions`, `scenarios[1].expect`, `steps[2].expect[0]`
// (#lzjsblocknamemasking). It used to be the block's BARE NAME, which made every
// sibling block of a fixture share one record: `frames[0].assertions` and
// `frames[3].assertions` were the same id, so a key asserted in ONE marked the
// OTHER asserted, an object-valued key key-set-checked in one discharged the
// obligation for all of them, and an excuse for a key a sibling asserted failed as
// stale even though it hid nothing. That is the same masking `#lzscenariocoverage`
// found between sibling SCENARIOS, one level further down and inside a single
// fixture. Removing it took the examined population from 1047 keys to 3797 and
// exposed 24 findings the collapse had been holding green.
for (const line of readFileSync(KEY_MANIFEST, "utf8").split("\n")) {
  if (line.trim() === "") continue;
  const [fixture, block, key, tag, reason] = line.split("\t");
  const id = `${fixture}\t${block}\t${key}`;
  if (tag === "N") untouchedByCheck.add(id);
  else if (tag === "R") read.add(id);
  else if (tag === "A") asserted.add(id);
  else if (tag === "X") excusedInRunner.set(id, reason ?? "");
  else if (tag === "D") dischargedInRunner.set(id, reason ?? "");
  else if (tag === "V") verifiedFixtures.add(fixture);
  else if (tag === "O") objectValued.add(id);
  else if (tag === "K") keySetChecked.add(id);
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
let objectUnchecked = 0;
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

  // Rung 3c: an `assertKeyWith` check that received the fixture's value and never
  // consumed it (#lzunboundblockguard). Reported BEFORE the object-valued and
  // asserted branches, because both of those describe a different defect and the
  // reader would go looking in the wrong place. It is not softened by the key
  // being asserted somewhere else in the run: a vacuous call site stays vacuous,
  // and letting a good sibling site cover it is exactly the masking rung 3 is
  // about.
  if (untouchedByCheck.has(entry)) {
    fail([
      `ERROR: assertion key '${key}' in ${block} of '${fixture}' was handed to an`,
      "       assertKeyWith CHECK THAT NEVER DEREFERENCED IT. The callback received the",
      "       fixture's own object or array and never read a field, a member, a key set or",
      "       its contents, so the assertion is vacuously true and editing the fixture here",
      "       changes no outcome. Compare what the value CARRIES, use assertKey for a plain",
      "       deep equality, or declare the exception with excuseKey(block, key, reason).",
    ]);
    unasserted += 1;
    problems += 1;
    continue;
  }

  // Rung 3b: an object-valued key consumed WITHOUT a key-set check
  // (#lzsubblockkeyset). The key reports consumed and asserted, and a sub-field
  // added upstream is compared by nothing — the null form one level down, inside
  // an assertion key rather than beside one. Reported before the asserted branch
  // because "asserted" is precisely the state that hides it.
  if (
    objectValued.has(entry) &&
    !keySetChecked.has(entry) &&
    (asserted.has(entry) || read.has(entry))
  ) {
    fail([
      `ERROR: assertion key '${key}' in ${block} of '${fixture}' has a JSON OBJECT value and`,
      "       was CONSUMED WITHOUT A KEY-SET CHECK. Something compared named sub-fields of",
      "       this object; a field added to it upstream would be compared against nothing",
      "       while this key still reports asserted. Consume it with subBlock(block, key)",
      "       and assert the members, or with assertKeySet(block, key, observed) when the",
      "       object is a vocabulary — or excuse/discharge it with a reason.",
    ]);
    objectUnchecked += 1;
    problems += 1;
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
      ` ${unasserted} read-but-unasserted key(s), ${objectUnchecked} object-valued key(s)` +
      ` consumed without a key-set check, ${stale} stale excuse(s)`,
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
// PINNED TO REALITY (#lzscenariofloordrift). This floor equals what CI actually
// asserts, with NO margin: the run that pinned it ASSERTED exactly 3721 keys of
// 3797 present, and 3722 fails. (It was 1012/1047 while sibling assertion blocks
// COLLAPSED onto one key record, #lzjsblocknamemasking: the recorder booked
// `frames[0].assertions` and `frames[3].assertions` under the same bare name, so
// a key asserted in one sibling marked every other sibling asserted too and the
// population was 2750 records short of the corpus. And 1006/1041 before that,
// when the per-step `expect` LISTS of `signaling/anti_spoof_session.json` were
// outside the ladder entirely, #lzunboundblockguard.)
//
// It replaces the convention this comment used to record — "that fixture added
// 15 asserted keys, so the floor moved by 15 and kept the same margin",
// deliberately "calibrated below the observed run ... so ordinary corpus churn
// does not trip it". Raising by the delta and preserving the margin means the
// gap never closes, only widens; here it had reached 66. A floor 66 below
// reality tolerates 66 assertions silently ceasing to fire while this guard
// still prints OK, which is precisely the detachment the floor exists to catch.
//
// The denominator being larger than the floor is not a reason to keep slack.
// Every key that legitimately does not assert is already accounted for BY NAME
// — excused in-runner at its call site, discharged as prose against a verified
// fixture, or covered by a named entry in the static allowlist above — and each
// of those names is itself gated against going stale. A numeric margin stacked
// on top of that named accounting guards nothing; it only hides drift.
//
// When the corpus moves, re-derive from the gate's own output instead of adding
// a delta: run `make check`, read the "assertion-key consumption OK: <n>/..."
// line, set this to that <n>, then prove it exact by setting it to <n>+1 and
// watching this guard fail. A floor you never watched fail is a floor you have
// not verified. NEVER lower it to make the gate green: a drop means keys stopped
// being reached or stopped being asserted, and that is the finding, not the
// floor.
const MIN_ASSERTED_KEYS = Number(process.env.MIN_ASSERTED_KEYS ?? "3721");
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

// The same floor for rung 3b (#lzsubblockkeyset). The object-valued check walks
// only the keys the recorder DECLARED object-valued, so deleting the one line
// that emits the `O` record makes every object-valued key vacuously compliant
// and this guard prints OK having examined none of them — the exact vacuity
// shape MIN_ASSERTED_KEYS and MIN_BLOCKS close on the rungs either side.
//
// PINNED TO REALITY (#lzscenariofloordrift). Read what this floor is ON before
// moving it: its subject is the DECLARED population — `objectValued.size`, the
// DENOMINATOR of the OK line below — not the key-set-checked numerator beside
// it. That is deliberate, because the vacuity described above is a declaration
// that stops being emitted, and it is the denominator that collapses when it
// does. The OK line prints "floor N" next to "<checked>/<declared>", which reads
// as though it bounds the left-hand number; it does not.
//
// So the floor equals what CI actually declares, with NO margin: the run that
// pinned it DECLARED exactly 887 object-valued keys (of which 861 were key-set
// checked), and 888 fails.
//
// It was 209/199 while sibling assertion blocks COLLAPSED onto one key record
// (#lzjsblocknamemasking). That collapse was worse here than one rung up: an
// object-valued key key-set-checked in `frames[0].assertions` discharged the
// obligation for the same key name in EVERY sibling frame at once, so 678
// object-valued keys were never examined and the floor sat on a population a
// quarter the size of the corpus's. Before that it was "130 = calibrated below
// the observed run, which declares 151 object-valued keys" — the same
// delta-and-keep-the-margin convention pinned out of MIN_ASSERTED_KEYS above.
// The 26 declared keys that are not key-set checked are excused or discharged BY
// NAME at their call sites, so a margin was never covering them; it was covering
// nothing.
//
// When the corpus moves, re-derive from the gate's own output instead of adding
// a delta: run `make check`, read the DENOMINATOR of the "object-valued
// assertion key OK: <checked>/<n>" line, set this to that <n>, then prove it
// exact by setting it to <n>+1 and watching this guard fail. A floor you never
// watched fail is a floor you have not verified — and on this one, a floor set
// from the numerator passes at +1 and looks verified while bounding nothing.
// NEVER lower it to make the gate green: a drop means fixtures stopped being
// opened or the recorder stopped declaring the shape, and that is the finding.
const MIN_OBJECT_VALUED_KEYS = Number(process.env.MIN_OBJECT_VALUED_KEYS ?? "887");
if (objectValued.size < MIN_OBJECT_VALUED_KEYS) {
  fail([
    `ERROR: only ${objectValued.size} assertion keys were declared OBJECT-VALUED, expected >= ${MIN_OBJECT_VALUED_KEYS}.`,
    "       That declaration is read off the corpus bytes at parse time, so a drop means",
    "       the recorder stopped emitting it or the fixtures carrying object-valued keys",
    "       stopped being opened. Either way the key-set rung above is now green over a",
    "       population it never examined (#lzvacuousrun).",
  ]);
  process.exit(1);
}

// ---- RUNG 0: the assertion-block BIND ledger (#lznullformblind) ----
//
// Every rung above is scoped to a block the recorder REACHED. The unconsumed-key
// guard fires on a key nothing read; the unasserted-key guard on a key read and
// discarded; the prose ledger on a discharge naming nothing. None of them can
// fire for a block the recorder never instrumented, because there is no presence
// record at all: its keys are not unread — nothing reads them — and the fixture
// reports exactly nothing. lazily-dart found two such blocks carrying eight
// silent keys, one of them the anti-spoof invariant its fixture exists for;
// lazily-cpp found a third.
//
// The `!sawAny` check above is the FIXTURE-granular version of this and stops a
// rung short: it asks whether a fixture produced any presence record, so a
// fixture whose top-level `assertions` block is instrumented passes it while a
// per-frame block of the same file goes unseen. It also cannot see a block whose
// name is outside TRACKED, because it uses TRACKED to decide what to look for.
//
// So the declaring side here reads the corpus off DISK and inventories every
// assertion block, and the binding side is the recorder's own ledger. The two
// are matched by the block's CONTENT digest, never by its name. The recorder now
// books a block under its JSON PATH (#lzjsblocknamemasking) rather than the bare
// name it used to, so the two sides finally SPELL sites the same way — and the
// digest key stays anyway, because a path key would only prove that something at
// those coordinates was instrumented, while the digest proves the bytes on disk
// were. A block that moved inside its fixture is then reported by content rather
// than reported twice, once missing and once unexplained.
//
// TWO THINGS THE DECLARING SIDE MUST NOT DO (#lzunboundblockguard), because it
// used to do both:
//
//   1. Reuse the recorder's TRACKED list. TRACKED is what the recorder BINDS; a
//      declaring side scoped to it can only ever report a block the recorder was
//      already looking for, so a block name the corpus grows (`expect_final`,
//      `expects`, `assert`) is invisible on BOTH sides at once and the guard
//      prints OK. Proven: an `expect_final` block with two live assertion keys,
//      added to an OPENED fixture, left every rung green. So the rule here is
//      NAME-OPEN — anything spelled `assert*` / `expect*` — and a block it
//      inventories that TRACKED does not carry is reported UNBOUND, which is the
//      correct verdict for a block nothing instruments.
//
//   2. Enumerate a fixed handful of container paths. It inventoried exactly
//      `assertions`, plus `assertions` one level inside `frames` / `scenarios` /
//      `rejects` — 32 of the 583 blocks the opened corpus actually carries, a 5%
//      sample standing in for the whole. A per-step `expect`, a block under any
//      other container, or a block nested two levels down was outside it. The
//      walk below is FULL and recursive, so nesting depth and container spelling
//      stop mattering.
//
// An ARRAY-valued block counts, element by element. `steps[].expect` in
// `signaling/anti_spoof_session.json` is a list of expected emissions; the
// object-only inventory walked past all eight, and so did the recorder.
const BLOCK_MANIFEST =
  process.env.LAZILY_CONFORMANCE_BLOCK_MANIFEST ?? "build/conformance-assertion-blocks.txt";

// An assertion block that genuinely cannot be bound belongs HERE, as a
// documented excuse read on every run, not as a runner fabricated to manufacture
// coverage. Format: `fixture|where|reason`, where `where` is the JSON path the
// failure below prints; a reason is required, because an excuse with no reason is
// an unexplained gap wearing a green badge.
//
// Checked in BOTH directions, like DECLARED_UNCONSUMED and excuseKey()
// (#lzunboundblockguard): an entry naming a site no opened fixture carries fails
// as stale, and so does an entry naming a site a runner DOES bind. A one-way
// excuse only ever gets quieter.
const KNOWN_UNBOUND_BLOCKS = [];

// Positive-evidence floor (#lzvacuousrun). Zero inventoried blocks means zero
// unbound blocks, which reports OK having compared nothing. NEVER lower this to
// make the gate green.
//
// PINNED TO REALITY (#lzscenariofloordrift). This equals what CI actually
// inventories, with NO margin: the run that pinned it declared exactly 596
// blocks, and 597 fails.
//
// It was 32 -- not a drifted floor but an accurate count of a declaring side
// that only ever looked at four container paths (#lzunboundblockguard). The
// walk is now full and recursive under a name-open rule, so the inventory is
// the corpus's real assertion-block population rather than a 5% sample of it.
//
// When the corpus moves, re-derive from the gate's own output instead of adding
// a delta: run `make check`, read the "assertion-block bind OK: <n>/<n>" line,
// set this to that <n>, then prove it exact by setting it to <n>+1 and watching
// this guard fail.
const MIN_BLOCKS = Number(process.env.MIN_BLOCKS ?? "596");

function blockDigest(object) {
  let text;
  try {
    text = JSON.stringify(object);
  } catch {
    return null;
  }
  if (typeof text !== "string") return null;
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(text, "utf8")) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

if (!existsSync(BLOCK_MANIFEST) || statSync(BLOCK_MANIFEST).size === 0) {
  fail([
    `FAIL: no assertion-block ledger at ${BLOCK_MANIFEST}.`,
    "      Run the suite with LAZILY_CONFORMANCE_BLOCK_MANIFEST set and the recorder",
    "      preloaded (see the `test` script in package.json). An absent ledger is",
    "      missing evidence, not evidence that every block was bound.",
  ]);
  process.exit(1);
}

const boundBlocks = new Set();
for (const line of readFileSync(BLOCK_MANIFEST, "utf8").split("\n")) {
  const [tag, digest] = line.split("\t");
  if (tag === "bound" && digest) boundBlocks.add(digest);
}

const blockExcuses = new Map();
for (const raw of KNOWN_UNBOUND_BLOCKS) {
  const [fixture, where, reason] = String(raw).split("|");
  if (!fixture || !where || !reason || reason.trim() === "") {
    fail([
      `ERROR: KNOWN_UNBOUND_BLOCKS entry '${raw}' must be 'fixture|where|reason'.`,
      "       An excuse with no reason is an unexplained gap wearing a green badge.",
    ]);
    process.exit(1);
  }
  blockExcuses.set(`${fixture}|${where}`, reason);
}

// The NAME-OPEN rule. Not the recorder's TRACKED list, and deliberately a
// PREFIX rather than an enumeration: a phase-qualified name the corpus grows
// (`expect_final`, `expect_before`, `asserts`) is inventoried the day it appears
// rather than the day someone remembers to extend a list.
const ASSERTION_BLOCK_NAME = /^(assert|expect)/i;

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const declaredBlocks = new Map();
// Every site the walk inventoried, so an excuse can be checked in BOTH
// directions: site -> digest.
const declaredSites = new Map();
if (existsSync(FIXTURE_MANIFEST)) {
  const openedFixtures = readFileSync(FIXTURE_MANIFEST, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const fixture of [...new Set(openedFixtures)].sort()) {
    const file = join(SPEC_DIR, fixture);
    if (!existsSync(file)) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const declare = (where, block) => {
      if (!isPlain(block)) return;
      const digest = blockDigest(block);
      if (digest === null) return;
      const site = `${fixture}|${where}`;
      if (!declaredBlocks.has(digest)) declaredBlocks.set(digest, new Set());
      declaredBlocks.get(digest).add(site);
      declaredSites.set(site, digest);
    };
    // Full recursive descent. `where` is the JSON path, so the failure below
    // names the block a reader has to go and look at.
    const descend = (node, where) => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => descend(item, `${where}[${index}]`));
        return;
      }
      if (!isPlain(node)) return;
      for (const [key, value] of Object.entries(node)) {
        const path = where === "" ? key : `${where}.${key}`;
        if (ASSERTION_BLOCK_NAME.test(key)) {
          if (isPlain(value)) declare(path, value);
          else if (Array.isArray(value)) {
            value.forEach((item, index) => declare(`${path}[${index}]`, item));
          }
        }
        descend(value, path);
      }
    };
    descend(parsed, "");
  }
}

const unboundBlocks = [];
for (const [digest, sites] of [...declaredBlocks.entries()].sort()) {
  if (boundBlocks.has(digest)) continue;
  for (const site of [...sites].sort()) {
    if (blockExcuses.has(site)) continue;
    unboundBlocks.push(site);
  }
}

// An excuse is stale in BOTH directions, exactly as DECLARED_UNCONSUMED and
// excuseKey() are. A site the walk no longer inventories means the corpus moved
// and the claim outlived it; a site whose block IS bound means the gap the
// excuse described is already closed, and leaving it behind understates what
// this binding checks while wearing a green badge.
for (const [site, reason] of [...blockExcuses].sort()) {
  const digest = declaredSites.get(site);
  if (digest === undefined) {
    fail([
      `ERROR: KNOWN_UNBOUND_BLOCKS names '${site}', which no OPENED fixture carries as an`,
      "       assertion block. The corpus moved, or the fixture stopped being opened.",
      `       Reason on file: ${reason}`,
      "       Delete the entry — an excuse for a block that is not there hides nothing and",
      "       cannot go red when the block comes back.",
    ]);
    process.exit(1);
  }
  if (boundBlocks.has(digest)) {
    fail([
      `ERROR: KNOWN_UNBOUND_BLOCKS names '${site}', which a runner DOES bind.`,
      `       Reason on file: ${reason}`,
      "       The excuse is stale — the gap it described is already closed. Delete the",
      "       entry; an excuse that hides nothing understates coverage.",
    ]);
    process.exit(1);
  }
}
if (unboundBlocks.length > 0) {
  fail([
    `ERROR: ${unboundBlocks.length} assertion block(s) were carried by an OPENED fixture`,
    "       and instrumented by no runner. Every check above is scoped to a block the",
    "       recorder reached, so these report nothing at all rather than reporting a",
    "       gap — their keys are not unread, nothing reads them:",
    ...unboundBlocks.map((site) => `         ${site}`),
    "       Parse the fixture with JSON.parse of its bytes so the recorder sees it; add",
    "       the block's NAME to TRACKED in test/support/conformance-manifest.cjs if the",
    "       corpus grew a spelling that list does not carry; or add the site to",
    "       KNOWN_UNBOUND_BLOCKS with a reason so the gap is visible on every run instead",
    "       of invisible.",
  ]);
  process.exit(1);
}
if (declaredBlocks.size < MIN_BLOCKS) {
  fail([
    `ERROR: only ${declaredBlocks.size} distinct assertion blocks were inventoried, expected >= ${MIN_BLOCKS}.`,
    "       The disk-side inventory detached, or fixtures stopped being opened. Zero",
    "       inventoried blocks means zero unbound blocks, which is OK over nothing.",
    "       Do not lower MIN_BLOCKS to fix this.",
  ]);
  process.exit(1);
}

console.error(
  `assertion-block bind OK: ${declaredBlocks.size}/${declaredBlocks.size} assertion blocks carried by` +
    ` opened fixtures were instrumented (${blockExcuses.size} declared unbindable; floor ${MIN_BLOCKS};` +
    ` content-keyed, so a runner's block NAME cannot satisfy it)`,
);

console.error(
  `object-valued assertion key OK: ${keySetChecked.size}/${objectValued.size} keys whose fixture value` +
    ` is a JSON OBJECT were consumed by a KEY-SET check — a deep equality, a descent into a child` +
    ` tracker, or an explicit key-set assertion (floor ${MIN_OBJECT_VALUED_KEYS} on the DECLARED` +
    ` count, the right-hand number; the rest are excused or discharged with a reason)`,
);

console.error(
  `assertion-key consumption OK: ${consumed}/${present.size} fixture assertion keys ASSERTED against` +
    ` their own fixture value by the suite (${declaredHere} excused in-runner,` +
    ` ${dischargedHere} prose keys discharged across ${verifiedFixtures.size} verified fixture(s),` +
    ` ${excused.size} declared unconsumed; floor ${MIN_ASSERTED_KEYS};` +
    ` runtime manifest — these values were really compared)`,
);
