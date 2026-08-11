// Conformance-delivery guard (#lzspecconf, #lzcorpusrootguards).
//
// The rest of the suite replays fixtures from the canonical lazily-spec sibling
// (../lazily-spec/conformance). Absence guards alone are not enough: an absence
// guard proves the directory is *there*, not that the fixtures were *read*, and
// it cannot see a bundled copy shadowing the canonical one. This file adds the
// positive half — mirroring the replay-output assertion lazily-go greps for.
//
// Six claims, each of which has failed somewhere in the family:
//   1. the canonical sibling is present (the js suite reported green for its
//      whole life with no CI at all, so nothing ever checked);
//   2. every conformance area the suite replays is present AND non-empty (an
//      empty dir passes `test -d` and skips every fixture in it);
//   3. every area the CORPUS carries is either replayed or explicitly excused,
//      so an area added upstream cannot go dark in silence;
//   4. no bundled `test/conformance/` copy exists to shadow the canonical one
//      (js carried nine such files; `crdt-tree/algebra.json` had already
//      drifted from spec);
//   5. no runner computes the sibling path for ITSELF (#lzoverrideallrunners).
//      Every runner resolves the corpus through `test/spec-corpus.cjs`, which is
//      what makes `LAZILY_SPEC_CONFORMANCE_DIR` reach the whole suite rather than
//      the three files that happened to have grown their own copy of the
//      override. A runner that spells the sibling path itself silently opts out
//      of every corpus-perturbation probe, so it fails here instead;
//   6. every claim above examined something. A guard that walks an empty file
//      set, or derives an empty area set, is green over nothing.
//
// Claims 2, 3 and 5 used to be hand-maintained lists, and both had rotted into
// the failure they warned about (#lzcorpusrootguards):
//
//   * The area list said "keep in sync with the `specPath(<area>)` call sites —
//     a missing entry here means an area can go dark unnoticed" and then went
//     dark on eight areas: codec, distributed, familysync, ingress, protobuf,
//     receipts, signaling and stdlib were all replayed and none was listed. It
//     is now DERIVED from the corpus-relative paths the runners actually spell,
//     so it cannot lag them, and the corpus is cross-checked against it in the
//     other direction so an unreplayed area has to be excused by name.
//   * The sibling-path matcher looked for the single assembled needle
//     `"lazily-spec"` — the quoted single segment — inside `test/` only. Three
//     natural spellings walked straight past it (a joined path in one literal,
//     the same segments in single quotes, a template literal), and `src/`,
//     `scripts/` and `bench/` were never scanned at all. Both holes were
//     demonstrated against synthetic offenders before this rewrite, not
//     theorised. The matcher below tokenizes the source instead, so it sees a
//     string literal for what it is in every quote style, and it joins adjacent
//     literals so a split constant cannot slip between them.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CLONE_HINT, conformanceRoot, specPath } from "./spec-corpus.cjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const specConformance = conformanceRoot;
const bundled = join(here, "conformance");

// The path segment a hand-rolled resolution has to spell, assembled rather than
// written out so this guard does not match its own source and exempt itself.
// `.join("-")` and not `"lazily" + "-spec"`: the matcher below deliberately
// catches the concatenated form, so the old spelling would now flag this file.
const SIBLING = ["lazily", "spec"].join("-");

// ---------------------------------------------------------------------------
// Source scanning
// ---------------------------------------------------------------------------

// The interpolation placeholder for `${...}` inside a template literal. NOT a
// space: the path test below rejects any value containing whitespace (that is
// what separates a path from an English sentence mentioning one), so a space
// here would let every template-literal path escape.
const INTERP = "\u0000";

// String literals of a JavaScript source, in order, with their offsets.
//
// A tokenizer rather than the regex-and-strip-comments pass this replaces. That
// pass could only recognise ONE quote style, could not see a template literal at
// all, and stripped only whole-line `//` comments. Walking the character stream
// costs about forty lines and gets every quote style, trailing comments, and
// escapes right — and, just as importantly, it does not confuse a `//` inside a
// string for a comment.
function stringLiterals(code) {
  const literals = [];
  let i = 0;
  const n = code.length;
  // The last non-whitespace character outside a comment or literal, used for the
  // standard "is this `/` a regex or a division?" heuristic. Getting this wrong
  // in the division direction is harmless here; getting it wrong in the regex
  // direction could desync the scan, which is why the allowlist below doubles as
  // a live positive control for this function.
  let prev = "";
  const REGEX_PRECEDERS = new Set([
    "(",
    ",",
    "=",
    ":",
    "[",
    "!",
    "&",
    "|",
    "?",
    "{",
    "}",
    ";",
    "+",
    "-",
    "*",
    "%",
    "~",
    "^",
    "<",
    ">",
    "",
  ]);
  while (i < n) {
    const c = code[i];
    if (c === "/" && code[i + 1] === "/") {
      while (i < n && code[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && code[i + 1] === "*") {
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "/" && REGEX_PRECEDERS.has(prev)) {
      i++;
      let inClass = false;
      while (i < n) {
        const d = code[i];
        if (d === "\\") {
          i += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) {
          i++;
          break;
        } else if (d === "\n") break;
        i++;
      }
      while (i < n && /[a-z]/.test(code[i])) i++;
      prev = "/";
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      i++;
      let value = "";
      while (i < n) {
        const d = code[i];
        if (d === "\\") {
          value += code[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (d === c) {
          i++;
          break;
        }
        if (d === "\n") break;
        value += d;
        i++;
      }
      literals.push({ value, start, end: i });
      prev = '"';
      continue;
    }
    if (c === "`") {
      const start = i;
      i++;
      let value = "";
      while (i < n) {
        const d = code[i];
        if (d === "\\") {
          value += code[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (d === "$" && code[i + 1] === "{") {
          let depth = 1;
          i += 2;
          while (i < n && depth > 0) {
            if (code[i] === "{") depth++;
            else if (code[i] === "}") depth--;
            i++;
          }
          value += INTERP;
          continue;
        }
        if (d === "`") {
          i++;
          break;
        }
        value += d;
        i++;
      }
      literals.push({ value, start, end: i });
      prev = "`";
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return literals;
}

// `lazily-spec` as a whole PATH SEGMENT, in a value carrying no whitespace.
//
// Both halves matter. The segment anchoring is what lets a runner keep the
// clone hint that names the sibling repository (`.../lazily-spec.git`) without
// tripping the guard, and the whitespace test is what separates a path from an
// English sentence about one — every runner's missing-fixture message says
// "clone the lazily-spec sibling", and none of those is a second resolution.
const SEGMENT = new RegExp(`(^|[/\\\\])${SIBLING}([/\\\\]|$)`);
const spellsSiblingPath = (value) => !/\s/.test(value) && SEGMENT.test(value);

// The JSON-schema directory as a whole PATH SEGMENT (#lzspecschemasoverride).
//
// Written as a regex literal rather than assembled from string literals on
// purpose: the tokenizer below skips regexes, so this guard does not match its
// own source and exempt itself the way `SIBLING` has to work around.
//
// Two exemptions, both load-bearing. Whitespace, for the same reason as above —
// every schema runner's test NAME says "validates against schemas/snapshot.json"
// and none of those is a resolution. And `://`, because a JSON-Schema `$id`
// (`https://lazily.dev/schemas/delta.json`) IDENTIFIES a schema rather than
// locating a file; ajv resolves those against its own registry, never the disk.
const SCHEMAS_SEGMENT = /(^|[/\\])schemas([/\\]|$)/;
const spellsSchemasPath = (value) =>
  !/\s/.test(value) && !value.includes("://") && SCHEMAS_SEGMENT.test(value);

// Adjacent literals are joined before testing, which is what closes the
// split-constant hole: `join(here, "..", "..", "lazily", "-spec")` and
// `"lazily" + "-spec"` both spell the segment across two literals that neither a
// substring search nor a per-literal test can see. Runs are joined bare (the
// `+` form) and with a separator (the `path.join` argument form), and every
// contiguous sub-run is tried, because the segment may be split anywhere.
const MAX_RUN = 8;

function siblingPathEvidence(code) {
  const literals = stringLiterals(code);
  const evidence = new Set();
  const schemasEvidence = new Set();
  const record = (kind, value) => {
    if (spellsSiblingPath(value)) evidence.add(`${kind} ${JSON.stringify(value)}`);
    if (spellsSchemasPath(value)) schemasEvidence.add(`${kind} ${JSON.stringify(value)}`);
  };
  for (const literal of literals) record("literal", literal.value);
  for (let k = 0; k < literals.length; k++) {
    const run = [literals[k].value];
    let j = k;
    // Only whitespace, `+` and `,` may sit between two literals for them to
    // count as adjacent. Anything else — an identifier, a call, an operator —
    // means the two are not being concatenated into one path.
    while (
      j + 1 < literals.length &&
      run.length < MAX_RUN &&
      /^[\s+,]*$/.test(code.slice(literals[j].end, literals[j + 1].start))
    ) {
      run.push(literals[j + 1].value);
      j++;
      for (const separator of ["", "/"]) record("joined", run.join(separator));
    }
  }
  return {
    literals: literals.length,
    evidence: [...evidence],
    schemasEvidence: [...schemasEvidence],
  };
}

// Shell has no literal-concatenation form worth modelling, so its rule is the
// plain one: strip full-line `#` comments, split on shell word boundaries, and
// test each word with the same path predicate.
function shellPathEvidence(code) {
  const stripped = code
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  const words = stripped.split(/[\s"'`(){}$]+/);
  const label = (list) => [...new Set(list.map((w) => `shell word ${JSON.stringify(w)}`))];
  return {
    literals: 0,
    evidence: label(words.filter((word) => spellsSiblingPath(word))),
    schemasEvidence: label(words.filter((word) => spellsSchemasPath(word))),
  };
}

// Every directory that can hold code resolving the corpus. `test/` alone was the
// old scope, which left `src/`, `scripts/` and `bench/` unscanned — and
// `scripts/` is where three of the four legitimate spellings live, so scoping by
// directory would have been an excuse dressed as a scan. They are allowlisted by
// PATH below instead.
const SCAN_ROOTS = ["bench", "bin", "scripts", "src", "test"];
const SCANNABLE = /\.((c|m)?js|sh)$/;

function scanSources() {
  const files = [];
  const perRoot = new Map();
  for (const root of SCAN_ROOTS) {
    const base = join(repoRoot, root);
    const before = files.length;
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (SCANNABLE.test(entry.name)) files.push(full);
      }
    };
    if (existsSync(base)) walk(base);
    perRoot.set(root, files.length - before);
  }
  const results = new Map();
  for (const full of files) {
    const code = readFileSync(full, "utf8");
    const rel = relative(repoRoot, full).split(sep).join("/");
    results.set(rel, full.endsWith(".sh") ? shellPathEvidence(code) : siblingPathEvidence(code));
  }
  return { perRoot, results };
}

const SCAN = scanSources();

// The files allowed to spell the sibling path, BY PATH.
//
//   * `test/spec-corpus.cjs` is the corpus seam — the one resolution the whole
//     suite routes through, and the reason the override reaches every runner.
//   * The three coverage guards read `LAZILY_SPEC_CONFORMANCE_DIR` and fall back
//     to the canonical sibling when it is unset, which is the same seam
//     expressed in the languages those guards are written in.
//
// This list is also the matcher's POSITIVE CONTROL. Each entry must still be
// detected as spelling the path; if the tokenizer ever desyncs and starts
// returning nothing, these four stop matching and the guard fails loudly rather
// than reporting a clean tree it never really read.
const ALLOWED_TO_SPELL_SIBLING = [
  "scripts/check-assertion-keys.mjs",
  "scripts/check-conformance-coverage.sh",
  "scripts/check-scenario-coverage.mjs",
  "test/spec-corpus.cjs",
];

// The files allowed to compute the JSON-SCHEMA root (#lzspecschemasoverride).
//
// Exactly one: the same seam, which is what makes `LAZILY_SPEC_SCHEMAS_DIR`
// reach `schema-conformance.test.js`, `lossless-tree-crdt.test.js` and
// `ipc.test.js` rather than the zero files that could honour it before the
// override existed. A runner that joins its own schemas path silently opts out
// of every schema-perturbation probe, which is what forced such a probe to
// perturb the shared ../lazily-spec checkout and redden all ten bindings.
//
// Doubles as the schemas matcher's POSITIVE CONTROL, exactly as the list above
// does for the sibling matcher.
const ALLOWED_TO_SPELL_SCHEMAS = ["test/spec-corpus.cjs"];

// PINNED TO REALITY. The scan covered exactly this many files when it was
// written; it is a floor, so adding files is free and REMOVING a subtree is what
// it catches. Re-derive it from the guard's own failure message rather than
// lowering it by a delta — a floor well below reality tolerates whole
// directories detaching, which is the failure it exists to catch.
const MIN_SCANNED_FILES = 136;

// ---------------------------------------------------------------------------
// Areas the suite replays, DERIVED
// ---------------------------------------------------------------------------

// A corpus-relative fixture path, `<area>/<file>.json`. Every runner spells one
// of these, either directly (`loadFixture("signaling/frames.json")`) or as a
// module constant (`const FIXTURE = "protobuf/graph_boundary_traces.json"`), so
// reading them off the source is reading what the suite really asks for.
const AREA_OF_FIXTURE = /^([A-Za-z][A-Za-z0-9._-]*)\/[^/]+\.json$/;
// A bare area name handed to the corpus seam, `specPath("windowing")`. The
// runners that list a directory spell the area this way and never name a file.
const BARE_AREA = /^[A-Za-z][A-Za-z0-9_-]*$/;
const SEAM_CALL = /(?:specPath|fixtureExists|readFixtureText|loadFixture)\(\s*$/;

const GUARD_FILE = "test/conformance-guard.test.js";

function deriveReplayedAreas() {
  const areas = new Map();
  let scanned = 0;
  for (const [rel, _result] of SCAN.results) {
    // Test sources only, and never this file: an area named HERE would satisfy
    // the derivation with the guard's own text, which is the hand-maintained
    // list wearing a different hat.
    if (!rel.startsWith("test/") || rel === GUARD_FILE || rel.endsWith(".sh")) continue;
    scanned++;
    const code = readFileSync(join(repoRoot, rel), "utf8");
    for (const literal of stringLiterals(code)) {
      const fixture = AREA_OF_FIXTURE.exec(literal.value);
      const area = fixture
        ? fixture[1]
        : BARE_AREA.test(literal.value) &&
            SEAM_CALL.test(code.slice(Math.max(0, literal.start - 48), literal.start))
          ? literal.value
          : null;
      if (area === null) continue;
      if (!areas.has(area)) areas.set(area, new Set());
      areas.get(area).add(rel);
    }
  }
  return { areas, scanned };
}

const DERIVED = deriveReplayedAreas();
const AREAS = [...DERIVED.areas.keys()].sort();

// Corpus areas this binding does NOT replay. Same shape and same discipline as
// `KNOWN_UNCOVERED` in scripts/check-conformance-coverage.sh, which excuses the
// individual fixtures: an entry is a claim that somebody looked, and it is
// verified in both directions below so it cannot rot into something that used to
// be true.
const AREAS_NOT_REPLAYED = {
  egress: "reactive egress is Rust-only; JavaScript has no egress replay runner.",
};

// PINNED TO REALITY, read the note on MIN_SCANNED_FILES. Twenty-five replayed
// areas plus the excused `egress` is the whole corpus.
const MIN_AREAS = 25;

const corpusAreas = () =>
  readdirSync(specConformance, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

// ---------------------------------------------------------------------------

test("canonical lazily-spec sibling is present (#lzspecconf)", () => {
  assert.ok(
    existsSync(specConformance),
    `canonical conformance fixtures absent: ${specConformance} — ${CLONE_HINT}`,
  );
});

test("the replayed-area list is DERIVED from real call sites, not hand-kept", () => {
  assert.ok(
    DERIVED.scanned > 0,
    "the area derivation read ZERO test sources. Every area check below is then " +
      "vacuously green over an empty list, which is exactly the state the old " +
      "hand-maintained list rotted into (#lzcorpusrootguards).",
  );
  assert.ok(
    AREAS.length >= MIN_AREAS,
    `only ${AREAS.length} conformance areas were derived from the runners, expected >= ${MIN_AREAS}. ` +
      "A replay was deleted or the derivation stopped seeing its call sites. Do not lower " +
      `MIN_AREAS to fix this. Derived: ${AREAS.join(", ")}`,
  );
});

test("every conformance area the suite replays exists and is non-empty", () => {
  const missing = [];
  const empty = [];
  for (const area of AREAS) {
    const dir = specPath(area);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      missing.push(area);
      continue;
    }
    if (readdirSync(dir).filter((f) => f.endsWith(".json")).length === 0) empty.push(area);
  }
  assert.deepEqual(missing, [], `conformance areas missing from the spec sibling — ${CLONE_HINT}`);
  assert.deepEqual(
    empty,
    [],
    "conformance areas present but empty — every fixture in them would silently skip",
  );
  // The corpus ROOT carries fixtures too (the delta_*/snapshot_* family), and it
  // is not an area, so nothing above would notice it emptying out.
  assert.ok(
    readdirSync(specConformance).filter((f) => f.endsWith(".json")).length > 0,
    `the corpus root ${specConformance} holds no fixtures — ${CLONE_HINT}`,
  );
});

test("every corpus area is replayed or explicitly excused", () => {
  const areas = corpusAreas();
  assert.ok(areas.length > 0, `the corpus at ${specConformance} lists no areas at all`);
  const dark = areas.filter((a) => !AREAS.includes(a) && !(a in AREAS_NOT_REPLAYED));
  assert.deepEqual(
    dark,
    [],
    "these canonical corpus areas are replayed by NO runner in this binding. That is the " +
      "drift the old hand-maintained list promised to catch and did not: an area lands " +
      "upstream, every gate stays green, and nobody learns it is dark. Replay it, or add it " +
      "to AREAS_NOT_REPLAYED with a reason (#lzcorpusrootguards).",
  );
  const stale = Object.keys(AREAS_NOT_REPLAYED).filter(
    (a) => AREAS.includes(a) || !areas.includes(a),
  );
  assert.deepEqual(
    stale,
    [],
    "AREAS_NOT_REPLAYED names areas this binding DOES replay, or that the corpus no longer " +
      "carries. An excuse that outlived its gap understates coverage exactly as a stale " +
      "KNOWN_UNCOVERED entry does.",
  );
});

test("no bundled fixture copy shadows the canonical spec", () => {
  assert.ok(
    !existsSync(bundled),
    `${bundled} exists — a bundled copy shadows the canonical fixture and makes drift invisible. ` +
      `Read ../${SIBLING}/conformance directly instead.`,
  );
});

// The fixtures that used to ship bundled under test/conformance/. They are the
// ones a reintroduced local copy would shadow first, so assert them by name.
const FORMERLY_BUNDLED = [
  "crdt-tree/algebra.json",
  "delta_non_sequential.json",
  "delta_sequential.json",
  "delta_shared_blob.json",
  "delta_zero_copy_arrow.json",
  "reliable-sync/outbox_store_protocol.json",
  "snapshot_minimal.json",
  "snapshot_multi_node.json",
  "snapshot_shared_blob.json",
];

test("formerly-bundled fixtures all resolve under the canonical spec", () => {
  const unresolved = FORMERLY_BUNDLED.filter((rel) => !existsSync(specPath(rel)));
  assert.deepEqual(
    unresolved,
    [],
    `fixtures no longer resolvable after de-bundling — ${CLONE_HINT}`,
  );
});

test("the sibling-path scan examined every source root (#lzcorpusrootguards)", () => {
  const emptyRoots = SCAN_ROOTS.filter((root) => (SCAN.perRoot.get(root) ?? 0) === 0);
  assert.deepEqual(
    emptyRoots,
    [],
    "these source roots contributed ZERO files to the sibling-path scan. A walk that " +
      "examines nothing reports a clean tree it never read — the same vacuous green as a " +
      "guard scoped to test/ while the offender sits in src/.",
  );
  assert.ok(
    SCAN.results.size >= MIN_SCANNED_FILES,
    `the scan examined ${SCAN.results.size} files, expected >= ${MIN_SCANNED_FILES}. ` +
      "A subtree stopped being walked, or an extension stopped being recognised. Do not " +
      "lower MIN_SCANNED_FILES to fix this.",
  );
});

test("the sibling-path matcher still fires on the files that legitimately spell it", () => {
  // The positive control. Without it a broken matcher reports every file clean
  // and the guard below passes on a tree it cannot actually read.
  const silent = ALLOWED_TO_SPELL_SIBLING.filter(
    (rel) => (SCAN.results.get(rel)?.evidence.length ?? 0) === 0,
  );
  assert.deepEqual(
    silent,
    [],
    "these files DO resolve the corpus root and the matcher did not see it. Either the " +
      "file stopped spelling the sibling path — in which case delete the allowlist entry, a " +
      "stale allowlist is its own drift — or the matcher is broken and every 'clean' verdict " +
      "it returns is worthless.",
  );
});

test("no runner computes the sibling corpus path for itself (#lzoverrideallrunners)", () => {
  // Comments are skipped by construction: the scanner tokenizes, so a doc
  // comment naming ../<sibling> is invisible to it and several runners carry
  // one. What must not exist is a second resolution in CODE, which is how the
  // override stopped at three files.
  assert.ok(
    SCAN.results.size > 0,
    "the sibling-path walk examined ZERO files. This assertion is otherwise vacuously " +
      "green: no files means no offenders (#lzvacuousrun).",
  );
  const offenders = [];
  for (const [rel, result] of SCAN.results) {
    if (result.evidence.length === 0) continue;
    if (ALLOWED_TO_SPELL_SIBLING.includes(rel)) continue;
    offenders.push(`${rel} (${result.evidence.join("; ")})`);
  }
  assert.deepEqual(
    offenders,
    [],
    `these files resolve the ${SIBLING} sibling themselves instead of importing ` +
      "test/spec-corpus.cjs. A per-file path is a per-file corpus: " +
      "LAZILY_SPEC_CONFORMANCE_DIR cannot reach it, so a corpus-perturbation probe would " +
      "report a vacuous green for it.",
  );
});

test("the schemas-path matcher still fires on the file that legitimately spells it", () => {
  const silent = ALLOWED_TO_SPELL_SCHEMAS.filter(
    (rel) => (SCAN.results.get(rel)?.schemasEvidence.length ?? 0) === 0,
  );
  assert.deepEqual(
    silent,
    [],
    "the corpus seam DOES compute the JSON-schema root and the matcher did not see it. " +
      "Either the seam stopped computing it — in which case the override reaches nothing — " +
      "or the matcher is broken and every 'clean' verdict below is worthless.",
  );
});

test("no runner computes the JSON-schema root for itself (#lzspecschemasoverride)", () => {
  assert.ok(
    SCAN.results.size > 0,
    "the schemas-path walk examined ZERO files. This assertion is otherwise vacuously " +
      "green: no files means no offenders (#lzvacuousrun).",
  );
  const offenders = [];
  for (const [rel, result] of SCAN.results) {
    if ((result.schemasEvidence?.length ?? 0) === 0) continue;
    if (ALLOWED_TO_SPELL_SCHEMAS.includes(rel)) continue;
    offenders.push(`${rel} (${result.schemasEvidence.join("; ")})`);
  }
  assert.deepEqual(
    offenders,
    [],
    "these files compute the JSON-schema directory themselves instead of importing " +
      "schemasRoot/schemaPath from test/spec-corpus.cjs. A per-file schemas path is a " +
      "per-file schema set: LAZILY_SPEC_SCHEMAS_DIR cannot reach it, so perturbing a schema " +
      `to test it means perturbing the shared ../${SIBLING} checkout — which reddens every ` +
      "binding in the family at once.",
  );
});
