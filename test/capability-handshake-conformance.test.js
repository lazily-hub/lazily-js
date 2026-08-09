// Canonical capability-handshake negotiation (#lzhandshakedeadfields).

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { SessionHandshake } from "../src/index.js";
import { assertKey } from "./support/assert-key.js";
import { scenarios } from "./support/scenario.js";

import { specPath } from "./spec-corpus.cjs";

const FIXTURE = "codec/capability_handshake.json";

function loadFixture() {
  const path = specPath(FIXTURE);
  assert.ok(
    existsSync(path),
    `missing canonical spec fixture ${path} — clone the lazily-spec sibling`,
  );
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(fixture.protocol_version, 1);
  assert.equal(fixture.kind, "CapabilityHandshake");
  return fixture;
}

test("SessionHandshake replays the canonical negotiated-state contract", () => {
  const fixture = loadFixture();
  let replayed = 0;

  for (const scenario of scenarios(fixture)) {
    replayed += 1;
    const local = SessionHandshake.fromWire(scenario.local);
    const remote = SessionHandshake.fromWire(scenario.remote);
    const result = local.checkCompatible(remote);
    const expected = scenario.expected;

    assertKey(expected, "compatible", result.ok);
    if (result.ok) {
      assertKey(expected, "negotiated_max_frame_size", result.maxFrameSize);
      assertKey(expected, "negotiated_fragmentation_supported", result.fragmentationSupported);
    } else {
      assertKey(expected, "field", result.field);
    }
  }

  assert.equal(replayed, 5, "the settled handshake fixture has five scenarios");
});
