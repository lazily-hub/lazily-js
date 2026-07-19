import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

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
    `missing canonical spec fixture ${path} — clone the lazily-spec sibling `
      + `(git clone https://github.com/lazily-hub/lazily-spec.git ../lazily-spec)`,
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

  for (const scenario of fixture.scenarios) {
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
    const applied = target.ingest(new CrdtSync({ frontier: origin.frontierEntries(), ops: frame.ops }), 1000);
    assert.ok(applied > 0, `[${name}] ingest applied at least one op`);

    if (scenario.reingest) {
      const reapplied = target.ingest(new CrdtSync({ frontier: origin.frontierEntries(), ops: frame.ops }), 1001);
      assert.equal(reapplied, scenario.expect.reingest_applied, `[${name}] re-ingest is idempotent`);
    }

    const expect = scenario.expect;

    const gotKeys = target.familyKeys(namespace).map(suffixOf).sort();
    const wantKeys = [...expect.target_keys].sort();
    assert.deepEqual(gotKeys, wantKeys, `[${name}] materialized key set`);

    assert.equal(
      target.familyKeys(namespace).length,
      expect.target_present_count,
      `[${name}] present count`,
    );

    for (const [key, want] of Object.entries(expect.target_values)) {
      assert.equal(target.familyValueLww(namespace, key), want, `[${name}] value for ${key}`);
    }

    const countTrue = target
      .familyKeys(namespace)
      .filter((k) => target.familyValueLww(namespace, suffixOf(k)) === true).length;
    assert.equal(countTrue, expect.target_count_true, `[${name}] derived count of true entries`);

    if (expect.target_epoch_bumped) {
      assert.notEqual(
        target.membershipEpoch(),
        epochBefore,
        `[${name}] membership epoch bumped on materialize`,
      );
    }
  }
});
