import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertKey, assertKeyWith, subBlock } from "./support/assert-key.js";
import { scenarios } from "./support/scenario.js";

import { CrdtSync } from "../src/index.js";
import { CrdtPlaneRuntime } from "../src/distributed.js";

// Replays the canonical lazily-spec/conformance/familysync fixture against the
// native CrdtPlaneRuntime family layer — the language-agnostic conformance every
// binding MUST validate (lazily-spec/protocol.md § "Reactive family sync", proved
// in lazily-formal FamilySync.lean).
//
// A keyed op for a family entry NOT registered locally MATERIALIZES it on ingest
// instead of being dropped/mis-addressed: membership propagates, values are
// adopted, a later last-writer-wins update converges, re-ingest is idempotent, and
// a derived aggregate (count of `true` entries) converges across replicas.

const here = dirname(fileURLToPath(import.meta.url));
const specFixtures = join(here, "..", "..", "lazily-spec", "conformance");

function loadFixture(name) {
  const path = join(specFixtures, name);
  assert.ok(
    existsSync(path),
    `missing canonical spec fixture ${path} — clone the lazily-spec sibling ` +
      `(git clone https://github.com/lazily-hub/lazily-spec.git ../lazily-spec)`,
  );
  return JSON.parse(readFileSync(path, "utf8"));
}

function suffixOf(key) {
  const parts = String(key).split("/");
  return parts[parts.length - 1];
}

test("family-granularity sync: materialize on ingest (#lzfamilysync)", () => {
  const fixture = loadFixture("familysync/materialize_on_ingest.json");
  const namespace = fixture.namespace;
  assert.equal(fixture.value_type, "bool", "this harness replays the bool value_type");

  for (const scenario of scenarios(fixture)) {
    const name = scenario.name;

    const origin = new CrdtPlaneRuntime(scenario.origin_peer);
    origin.registerFamilyLww(namespace);

    const target = new CrdtPlaneRuntime(scenario.target_peer);
    target.registerFamilyLww(namespace);
    const epochBefore = target.membershipEpoch();

    let now = 100;
    for (const set of scenario.origin_sets) {
      origin.familySetLww(namespace, set.key, set.value, set.now ?? now++);
    }

    const frame = origin.syncFrame();
    const applied = target.ingest(
      new CrdtSync({ frontier: origin.frontierEntries(), ops: frame.ops }),
      1000,
    );
    assert.ok(applied > 0, `[${name}] ingest applied at least one op`);

    if (scenario.reingest) {
      const reapplied = target.ingest(
        new CrdtSync({ frontier: origin.frontierEntries(), ops: frame.ops }),
        1001,
      );
      assertKey(
        scenario.expect,
        "reingest_applied",
        reapplied,
        `[${name}] re-ingest is idempotent`,
      );
    }

    const expect = scenario.expect;

    const gotKeys = target.familyKeys(namespace).map(suffixOf).sort();
    assertKeyWith(expect, "target_keys", (want) => {
      assert.deepEqual(gotKeys, [...want].sort(), `[${name}] materialized key set`);
    });

    assertKey(
      expect,
      "target_present_count",
      target.familyKeys(namespace).length,
      `[${name}] present count`,
    );

    // Descended (#lzsubblockkeyset): the child tracker owns every key the
    // fixture names, so one added upstream is unconsumed rather than skipped.
    const values = subBlock(expect, "target_values");
    for (const key of Object.keys(values)) {
      assertKey(values, key, target.familyValueLww(namespace, key), `[${name}] value for ${key}`);
    }

    const countTrue = target
      .familyKeys(namespace)
      .filter((k) => target.familyValueLww(namespace, suffixOf(k)) === true).length;
    assertKey(expect, "target_count_true", countTrue, `[${name}] derived count of true entries`);

    // Both directions. Gating on the fixture value and asserting only when it is
    // true is the third read-then-discard shape: a fixture saying the epoch must
    // NOT move would have been replayed with nothing checked.
    assertKey(
      expect,
      "target_epoch_bumped",
      target.membershipEpoch() !== epochBefore,
      `[${name}] membership epoch bumped on materialize`,
    );
  }
});
