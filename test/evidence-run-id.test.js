// The evidence stamp is ONE string with FOUR spellings (#lzstampprefixdrift).
//
// The run-id protocol (#lzstalemanifest) dates every evidence file under
// `build/` by stamping `# lazily-run-id <id>` as its first line, and every guard
// that reads one refuses a file whose stamp is absent, is a different id, or has
// no records under it. That closed a real hole. It also created a NEW coupling
// that nothing enforced: the prefix is written in one place and recognised in
// three others, in three different languages.
//
//   1. THE WRITER — the `printf` in the `test` script in package.json, which
//      stamps each of the four evidence files as it truncates them.
//   2. THE `.mjs` READER — `RUN_ID_STAMP_PREFIX` in scripts/evidence-run-id.mjs,
//      through which rungs 2, 3 and 4 read every evidence file.
//   3. THE BASH READER — `RUN_ID_STAMP_PREFIX` in
//      scripts/check-conformance-coverage.sh, rung 1's own copy, because that
//      guard is a shell script and cannot import the module.
//   4. THE CI GATE — the `[ "$stamped" = ... ]` comparison in the
//      recorder-produced-evidence step of .github/workflows/ci.yml, which
//      asserts the coupling between the test step and the rung steps rather
//      than assuming it.
//
// A drift between any two of them FAILS CLOSED — the guard refuses the file —
// so it was never a correctness hole. It was a DIAGNOSTIC hole, and a bad one: a
// one-character typo in any of the four presents as "this is evidence from a
// DIFFERENT run", which sends the reader hunting a stale file that does not
// exist. The failure names the wrong thing, which is the expensive kind.
//
// lazily-kt flagged the shape and lazily-go fixed it first
// (`TestGuardAndRecorderAgreeOnTheStampPrefix`, one of four mutations that
// redden its probe suite). This is the JavaScript equivalent, with the extra
// spelling this binding turned out to carry: go couples two definitions, js has
// four.
//
// The rule this keeps rediscovering: two definitions of one string held together
// by a comment is the shape that drifts. lazily-cpp found it structurally when
// its `assertion_json` clone had silently diverged for every number-carrying
// block; lazily-rs found it in scenario-id resolution that agreed with the shared
// rule only by coincidence of input.
//
// Every definition below is read from its REAL source and, where it lives in a
// shell fragment, evaluated by `sh` rather than unquoted by hand — so what this
// file compares is what each consumer actually sees. The literal itself is
// deliberately never spelled here: restating it would just add a fifth place to
// drift, and the test would then pass while the four real ones disagreed.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { RUN_ID_STAMP_PREFIX } from "../scripts/evidence-run-id.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// A sentinel id, not a plausible one. Real ids are `make-<date +%s%N>-<pid>`;
// this cannot be confused for one in a failure message, and cannot accidentally
// equal whatever id the surrounding run is using.
const PROBE_ID = `stamp-prefix-probe-${process.pid}`;

// One record, so the files this test writes are evidence-shaped rather than
// stamp-only — the stamp-only state is its own refusal (#lzstampsatisfiesnonempty)
// and is not what is under test here.
//
// Deliberately shaped like a corpus-relative fixture path in an area the corpus
// does not carry. This test does not replay it: the guards under test count a
// generic evidence record and never resolve it. A former source-literal area
// derivation nevertheless claimed this string proved replay and reddened the
// suite. Keeping the realistic shape is the regression (#lazilyderivesreplayed).
const PROBE_RECORD = "not-a-corpus-area/stamp-prefix-probe.json";

function source(rel) {
  return readFileSync(join(repoRoot, rel), "utf8");
}

// Run a shell fragment the way its owner runs it. `$1`, `$2`, ... are the extra
// arguments.
function sh(script, ...args) {
  return execFileSync("sh", ["-c", script, "sh", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

// A definition that appears twice is already the drift this file exists to
// catch, so each read insists on finding exactly one.
function sole(found, what, where) {
  assert.equal(
    found.length,
    1,
    `expected exactly one ${what} in ${where}, found ${found.length}: ` +
      `${JSON.stringify(found)}. Either the stamp has grown another spelling — ` +
      `which is the drift this test exists to prevent — or it moved and this ` +
      `test is now reading the wrong thing. Both need a human.`,
  );
  return found[0];
}

// ---------------------------------------------------------------------------
// The four definitions, each read from its real source
// ---------------------------------------------------------------------------

// 1. THE WRITER. The `test` script's own `printf` format, expanded by `sh` with
// the format as `$1` exactly as the script does — so `%s` and `\n` are resolved
// by printf and not by a second-guess here.
function writerStamp(id) {
  const testScript = JSON.parse(source("package.json")).scripts.test;
  const format = sole(
    [...testScript.matchAll(/\bprintf\s+"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]),
    "`printf` format string",
    "the `test` script in package.json",
  );
  return sh('printf "$1" "$2"', format, id);
}

// 2. THE `.mjs` READER. Imported, so there is nothing to parse: this is the
// constant rungs 2-4 compare against.
function mjsReaderStamp(id) {
  return `${RUN_ID_STAMP_PREFIX}${id}\n`;
}

// 3. THE BASH READER. The assignment line is evaluated by `sh`, so the value is
// whatever the shell makes of it — quoting included — rather than a hand
// unquoting that could agree with the source text while disagreeing with the
// guard.
function bashReaderStamp(id) {
  const assignment = sole(
    source("scripts/check-conformance-coverage.sh")
      .split("\n")
      .filter((line) => /^RUN_ID_STAMP_PREFIX=/.test(line)),
    "`RUN_ID_STAMP_PREFIX=` assignment",
    "scripts/check-conformance-coverage.sh",
  );
  return sh(`${assignment}\nprintf '%s%s\\n' "$RUN_ID_STAMP_PREFIX" "$1"`, id);
}

// 4. THE CI GATE. The workflow compares the file's first line against an
// interpolated literal, so the literal is re-embedded in double quotes and
// expanded by `sh` the same way the step expands it.
function ciGateStamp(id) {
  const compared = sole(
    [
      ...source(".github/workflows/ci.yml").matchAll(
        /\[\s*"\$stamped"\s*=\s*"((?:[^"\\]|\\.)*)"\s*\]/g,
      ),
    ].map((m) => m[1]),
    '`[ "$stamped" = ... ]` comparison operand',
    ".github/workflows/ci.yml",
  );
  // The operand is pasted into a script, so refuse anything that would execute
  // rather than expand. A variable reference is the whole point; a command
  // substitution or a backtick is not.
  assert.ok(
    !compared.includes("`") && !compared.includes("$("),
    `the CI stamp comparison contains a command substitution: ${JSON.stringify(compared)}`,
  );
  return sh(`LAZILY_CONFORMANCE_RUN_ID="$1"\nprintf '%s\\n' "${compared}"`, id);
}

function probeDir() {
  return mkdtempSync(join(tmpdir(), "lazily-js-stamp-"));
}

// ---------------------------------------------------------------------------

test("the stamp `npm test` writes is the stamp every guard parses (#lzstampprefixdrift)", () => {
  const writer = writerStamp(PROBE_ID);

  // The writer itself has to be a one-line stamp carrying the id, or the
  // comparisons below would be comparing two equally broken strings.
  assert.equal(
    writer.split("\n").length,
    2,
    `the writer's stamp is not a single line: ${JSON.stringify(writer)}`,
  );
  assert.ok(
    writer.endsWith(`${PROBE_ID}\n`),
    `the writer's stamp does not end in the id: ${JSON.stringify(writer)}`,
  );
  assert.ok(
    writer.length > `${PROBE_ID}\n`.length,
    "the writer's stamp is the bare id with no prefix at all",
  );

  for (const [where, stamp] of [
    [
      "scripts/evidence-run-id.mjs — RUN_ID_STAMP_PREFIX, read by rungs 2, 3 and 4",
      mjsReaderStamp(PROBE_ID),
    ],
    [
      "scripts/check-conformance-coverage.sh — RUN_ID_STAMP_PREFIX, rung 1's copy",
      bashReaderStamp(PROBE_ID),
    ],
    [".github/workflows/ci.yml — the recorder-produced-evidence gate", ciGateStamp(PROBE_ID)],
  ]) {
    assert.equal(
      stamp,
      writer,
      `${where}\ndoes not spell the stamp the \`test\` script in package.json writes.\n` +
        `  written by npm test: ${JSON.stringify(writer)}\n` +
        `  expected there:      ${JSON.stringify(stamp)}\n` +
        `A drift here fails CLOSED — the guard refuses the evidence — but it ` +
        `reports "evidence from a DIFFERENT run", which sends the reader hunting ` +
        `a stale file that does not exist. Fix the spelling, do not relax this ` +
        `test: the prefix has one definition per consumer and they must agree ` +
        `character for character (#lzstampprefixdrift).`,
    );
  }
});

test("every documented adopt-this-run's-id command recovers the id the writer stamped", () => {
  // The escape hatch for re-reading a gate against evidence already on disk is
  // adopting that run's id IN THE OPEN, on the command line, rather than a flag
  // that tells a guard to accept evidence it cannot date. That makes the
  // documented `sed` a FIFTH consumer of the prefix — and the cheapest one to
  // break silently, because a drifted recipe prints nothing, the variable ends
  // up empty, and the guard then refuses with "is not set" instead of anything
  // about a prefix. So run each recipe for real.
  const file = join(probeDir(), "conformance-fixtures-loaded.txt");
  writeFileSync(file, `${writerStamp(PROBE_ID)}${PROBE_RECORD}\n`);

  const recipes = [];
  for (const rel of ["Makefile", "scripts/evidence-run-id.mjs"]) {
    for (const m of source(rel).matchAll(/LAZILY_CONFORMANCE_RUN_ID=\$+\(sed -n '([^']*)'/g)) {
      recipes.push([rel, m[1]]);
    }
  }
  assert.ok(
    recipes.length >= 2,
    `expected the adopt-this-run's-id recipe to be documented in both the Makefile ` +
      `header and scripts/evidence-run-id.mjs; found ${recipes.length}: ${JSON.stringify(recipes)}`,
  );

  for (const [rel, script] of recipes) {
    const got = execFileSync("sed", ["-n", script, file], { encoding: "utf8" });
    assert.equal(
      got,
      `${PROBE_ID}\n`,
      `the documented recipe in ${rel} does not recover the id from a file the ` +
        `writer stamped.\n  sed -n ${JSON.stringify(script)}\n  printed ${JSON.stringify(got)}\n` +
        `An empty result makes LAZILY_CONFORMANCE_RUN_ID empty, and the guard then ` +
        `refuses with "is not set" — a message about the wrong thing (#lzstampprefixdrift).`,
    );
  }
});

test("both readers refuse a one-character drift in the stamp, by name", () => {
  // POSITIVE CONTROL for the test above. Equality of four strings proves they
  // agree; it does not prove any of them is load-bearing. A constant that no
  // longer reaches the parse would keep this file green while the guards
  // accepted anything. So perturb the stamp by one character and require both
  // readers to reject the file AND to say why.
  const writer = writerStamp(PROBE_ID);
  const drifted = writer.replace("run-id", "run-1d");
  assert.notEqual(drifted, writer, "the one-character perturbation did not change the stamp");

  const file = join(probeDir(), "conformance-fixtures-loaded.txt");
  writeFileSync(file, `${drifted}${PROBE_RECORD}\n`);
  const env = {
    ...process.env,
    LAZILY_CONFORMANCE_RUN_ID: PROBE_ID,
    LAZILY_CONFORMANCE_MANIFEST: file,
  };

  const reader = pathToFileURL(join(repoRoot, "scripts", "evidence-run-id.mjs")).href;
  const mjs = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { evidenceRecords } = await import(${JSON.stringify(reader)});\n` +
        `evidenceRecords(process.argv[1], "probe evidence");`,
      "--",
      file,
    ],
    { cwd: repoRoot, env, encoding: "utf8" },
  );
  assert.equal(mjs.status, 1, `evidenceRecords() accepted a drifted stamp (stdout: ${mjs.stdout})`);
  assert.match(mjs.stderr, /carries no '.* <id>' first line/);
  assert.match(mjs.stderr, /#lzstalemanifest/);

  const bash = spawnSync("./scripts/check-conformance-coverage.sh", [], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
  const bashOut = `${bash.stdout}${bash.stderr}`;
  if (bashOut.includes("SKIP: canonical corpus not found")) {
    // The canonical sibling is absent, and rung 1's corpus check runs BEFORE its
    // stamp check. conformance-guard.test.js fails on that absence on its own,
    // so there is nothing here to prove and nothing to hide.
    return;
  }
  assert.equal(bash.status, 1, `rung 1 accepted a drifted stamp (output: ${bashOut})`);
  assert.match(bashOut, /carries no '.* <id>' first line/);
  assert.ok(
    bashOut.includes(file),
    `rung 1's refusal does not name the file it refused: ${bashOut}`,
  );
});
