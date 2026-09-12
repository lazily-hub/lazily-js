// Evidence freshness: one run id per invocation, stamped into every evidence file
// and required by every guard that reads one (#lzstalemanifest).
//
// The four evidence files under build/ are written by the recorder preloaded into
// `npm test` (`test/support/conformance-manifest.cjs`) and read afterwards by
// three SEPARATE processes: scripts/check-conformance-coverage.sh,
// scripts/check-assertion-keys.mjs and scripts/check-scenario-coverage.mjs.
// Nothing in that handoff proved the bytes came from THIS invocation. Every rung
// in the ladder says "these bytes were really read"; none of them could say WHEN.
//
// `node --test` keeps no test cache, so the exposure in this binding is not a
// cached test task (the lazily-kt instance, a Gradle `:test` reported
// UP-TO-DATE) but the LEFTOVER FILE. build/ holds whatever the last writer left,
// and `npm test` is not the only writer: the four manifest env vars can be set by
// hand around a single `node --require ... --test test/one.test.js`, which is
// exactly how #lzsiblingrunnermasking bisected 70 runners one at a time.
//
// Measured before this module existed, with NO node process started at all:
// rung 1 printed "conformance coverage OK: 147/156", rung 0 "638/638 assertion
// blocks", rung 3 "3813/3889 ... ASSERTED" and rung 4 "157/157 scenarios
// REPLAYED", off manifests a previous run had written hours earlier.
//
// Why the magnitude floors do not already close it. They catch the
// UNDER-populated leftover: a one-file manifest fails MIN_FIXTURES (rung 1
// reported 126 uncovered fixtures), MIN_ASSERTED_KEYS (275 of 3813) and
// MIN_SCENARIOS (2 of 157). What they cannot see is a FULLY populated one. A
// ledger record is keyed `fixture\tblock\tkey`, so an obligation any runner
// discharges is discharged for all of them, and a manifest left by a complete
// earlier run satisfies every rung exactly as the current run would -- which is
// the whole problem: it is a true report about a run that is not this one. The
// per-obligation checks stay silent in both cases; on the partial manifest above
// the FIRST complaint was a floor, not a missing obligation.
//
// So the check here is deliberately not "does this file look full enough". It is
// "does this file carry the id of the invocation asking", which is the only
// question whose answer does not depend on how much of the suite ran.
import { existsSync, readFileSync } from "node:fs";

// One line, first line, fixed prefix. The evidence formats are line-based records
// (`fixture`, `fixture\tblock\tkey\tTAG`, `bound\t<digest>`, `fixture\tid`) and
// none of them can begin with `#`, so a comment line is carryable in-band and no
// sibling `.runid` file is needed. In-band is the stronger placement: the id
// travels in the same bytes the guard parses, so there is no second file to be
// fresh while the records are stale.
export const RUN_ID_STAMP_PREFIX = "# lazily-run-id ";

function die(lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

// The id this invocation is entitled to see. ABSENT is a refusal and never a
// skip: a guard that accepts unstamped evidence when the variable is unset is the
// same stale-evidence hole with one more step in front of it.
export function currentRunId() {
  const id = process.env.LAZILY_CONFORMANCE_RUN_ID;
  if (id === undefined || id.trim() === "") {
    die([
      "FAIL: LAZILY_CONFORMANCE_RUN_ID is not set, so no evidence file can be dated",
      "      and none of it can be shown to describe THIS run (#lzstalemanifest).",
      "      Run this guard in the same make invocation as the tests -- `make check`,",
      "      or `make test assertion-keys` for a single gate -- which generates one id",
      "      and stamps it into every evidence file `npm test` writes.",
      "      To re-read a gate against evidence already on disk, adopt that run's id",
      "      in the open:",
      "        LAZILY_CONFORMANCE_RUN_ID=$(sed -n '1s/^# lazily-run-id //p' \\",
      "          build/conformance-fixtures-loaded.txt) node scripts/check-assertion-keys.mjs",
      "      Refusing rather than skipping is the point: there is no flag for accepting",
      "      evidence a guard cannot date.",
    ]);
  }
  return id;
}

/**
 * Read an evidence file and return its RECORD lines, having proved the file
 * carries this invocation's run id.
 *
 * @param {string} path evidence file to read
 * @param {string} describe what it is, for the failure message
 * @returns {string[]} record lines, stamp removed, blank lines dropped
 */
export function evidenceRecords(path, describe) {
  const wanted = currentRunId();
  if (!existsSync(path)) {
    die([
      `FAIL: no ${describe} at ${path}.`,
      "      Run the suite with the recorder preloaded (see the `test` script in",
      "      package.json). An absent evidence file is missing evidence, not evidence",
      "      of absence.",
    ]);
  }
  const lines = readFileSync(path, "utf8").split("\n");
  const stamp = lines[0] ?? "";
  if (!stamp.startsWith(RUN_ID_STAMP_PREFIX)) {
    die([
      `FAIL: ${path} carries no '${RUN_ID_STAMP_PREFIX.trim()} <id>' first line, so it`,
      `      cannot be shown to describe THIS run (#lzstalemanifest). Wanted id`,
      `      '${wanted}'. An evidence file predating the run-id protocol has no stamp,`,
      "      and that is a failure rather than a pass: it is precisely the file left",
      "      behind by an earlier or partial run that this check exists to reject.",
      "      `npm test` writes the stamp as it truncates each evidence file.",
    ]);
  }
  const found = stamp.slice(RUN_ID_STAMP_PREFIX.length).trim();
  if (found !== wanted) {
    die([
      `FAIL: ${path} is evidence from a DIFFERENT run (#lzstalemanifest).`,
      `      stamped in the file:  ${found}`,
      `      this invocation:      ${wanted}`,
      "      The file was left behind by an earlier `npm test`, by a single-file run",
      "      with the manifest env vars set by hand, or by another make invocation.",
      "      Re-run the tests and the guards together (`make check`).",
    ]);
  }
  const records = lines.slice(1).filter((line) => line.trim() !== "");
  if (records.length === 0) {
    die([
      `FAIL: ${path} carries this run's id and NO records (#lzstalemanifest).`,
      "      The stamp is written when the file is truncated, before the suite runs, so",
      "      a stamp-only file means the recorder never appended anything: `npm test`",
      "      ran without the preload, or every test process died before its exit hook.",
      "      That is missing evidence, and the size check the stamp made non-empty",
      "      cannot see it -- this is that check, restated against RECORDS.",
    ]);
  }
  return records;
}
