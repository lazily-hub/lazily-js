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
//      drifted from spec).
import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const specRoot = join(here, "..", "..", "lazily-spec");
const specConformance = join(specRoot, "conformance");
const bundled = join(here, "conformance");

const CLONE_HINT =
  "clone the canonical sibling: "
  + "git clone --depth 1 https://github.com/lazily-hub/lazily-spec.git ../lazily-spec";

// Every `conformance/<area>` directory the suite reads. Keep in sync with the
// `join(here, "..", "..", "lazily-spec", "conformance", <area>)` constants in
// the test files — a missing entry here means an area can go dark unnoticed.
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
    const dir = join(specConformance, area);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      missing.push(area);
      continue;
    }
    if (readdirSync(dir).filter((f) => f.endsWith(".json")).length === 0) empty.push(area);
  }
  assert.deepEqual(missing, [], `conformance areas missing from the spec sibling — ${CLONE_HINT}`);
  assert.deepEqual(empty, [], "conformance areas present but empty — every fixture in them would silently skip");
});

test("no bundled fixture copy shadows the canonical spec", () => {
  assert.ok(
    !existsSync(bundled),
    `${bundled} exists — a bundled copy shadows the canonical fixture and makes drift invisible. `
      + "Read ../lazily-spec/conformance directly instead.",
  );
});

test("formerly-bundled fixtures all resolve under the canonical spec", () => {
  const unresolved = FORMERLY_BUNDLED.filter((rel) => !existsSync(join(specConformance, rel)));
  assert.deepEqual(unresolved, [], `fixtures no longer resolvable after de-bundling — ${CLONE_HINT}`);
});
