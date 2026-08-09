// Conformance-delivery guard (#lzspecconf).
//
// The rest of the suite replays fixtures from the canonical lazily-spec sibling
// (../lazily-spec/conformance). Absence guards alone are not enough: an absence
// guard proves the directory is *there*, not that the fixtures were *read*, and
// it cannot see a bundled copy shadowing the canonical one. This file adds the
// positive half — mirroring the replay-output assertion lazily-go greps for.
//
// Three claims, each of which has failed somewhere in the family:
//   1. the canonical sibling is present (the js suite reported green for its
//      whole life with no CI at all, so nothing ever checked);
//   2. every conformance area the suite reads is present AND non-empty (an
//      empty dir passes `test -d` and skips every fixture in it);
//   3. no bundled `test/conformance/` copy exists to shadow the canonical one
//      (js carried nine such files; `crdt-tree/algebra.json` had already
//      drifted from spec);
//   4. no runner computes the sibling path for ITSELF (#lzoverrideallrunners).
//      Every runner resolves the corpus through `test/spec-corpus.cjs`, which is
//      what makes `LAZILY_SPEC_CONFORMANCE_DIR` reach the whole suite rather than
//      the three files that happened to have grown their own copy of the
//      override. A runner that spells the sibling path itself silently opts out
//      of every corpus-perturbation probe, so it fails here instead.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CLONE_HINT, conformanceRoot, specPath } from "./spec-corpus.cjs";

const here = dirname(fileURLToPath(import.meta.url));
const specConformance = conformanceRoot;
const bundled = join(here, "conformance");

// Every `conformance/<area>` directory the suite reads. Keep in sync with the
// `specPath(<area>)` call sites in the test files — a missing entry here means
// an area can go dark unnoticed.
const AREAS = [
  "agent-doc",
  "collections",
  "coordination",
  "crdt-tree",
  "lossless-tree",
  "materialization",
  "membership",
  "message-passing",
  "presence",
  "rateshape",
  // Replayed by test/reactive-graph-conformance.test.js against all three
  // execution models. Family-wide only lazily-rs replayed these, which is how
  // an invalidation-cascade defect shipped in dart and go with a fixture
  // encoding the violated property sitting unrun on disk (#lzspecconf).
  "reactive-graph",
  "reliable-sync",
  "resilience",
  "service",
  "statechart",
  "temporal",
  "windowing",
];

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

test("canonical lazily-spec sibling is present (#lzspecconf)", () => {
  assert.ok(
    existsSync(specConformance),
    `canonical conformance fixtures absent: ${specConformance} — ${CLONE_HINT}`,
  );
});

test("every conformance area the suite reads exists and is non-empty", () => {
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
});

test("no bundled fixture copy shadows the canonical spec", () => {
  assert.ok(
    !existsSync(bundled),
    `${bundled} exists — a bundled copy shadows the canonical fixture and makes drift invisible. ` +
      "Read ../lazily-spec/conformance directly instead.",
  );
});

test("formerly-bundled fixtures all resolve under the canonical spec", () => {
  const unresolved = FORMERLY_BUNDLED.filter((rel) => !existsSync(specPath(rel)));
  assert.deepEqual(
    unresolved,
    [],
    `fixtures no longer resolvable after de-bundling — ${CLONE_HINT}`,
  );
});

// The corpus seam itself, and the recorder that must attribute opens relative to
// the SAME resolved root, are the only files allowed to name the sibling.
const CORPUS_SEAM = ["spec-corpus.cjs"];

// The path segment a hand-rolled resolution has to spell, assembled rather than
// written out so this guard does not match its own source and exempt itself.
const SIBLING_SEGMENT = `"lazily` + `-spec"`;

test("no runner computes the sibling corpus path for itself (#lzoverrideallrunners)", () => {
  // Source text only, comments stripped: a doc comment naming `../lazily-spec`
  // is fine and several runners carry one. What must not exist is a second
  // resolution in CODE, which is how the override stopped at three files.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(c|m)?js$/.test(entry.name)) continue;
      if (CORPUS_SEAM.includes(entry.name)) continue;
      const code = readFileSync(full, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !/^\s*\/\//.test(line))
        .join("\n");
      if (code.includes(SIBLING_SEGMENT)) offenders.push(full);
    }
  };
  walk(here);
  assert.deepEqual(
    offenders,
    [],
    "these files resolve the lazily-spec sibling themselves instead of importing " +
      "test/spec-corpus.cjs. A per-file path is a per-file corpus: LAZILY_SPEC_CONFORMANCE_DIR " +
      "cannot reach it, so a corpus-perturbation probe would report a vacuous green for it.",
  );
});
