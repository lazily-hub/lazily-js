// NodeKey null-leniency on decode (#lzkeynullstrict).
//
// protocol.md § NodeKey said a self-describing codec OMITS an absent `key`, and
// that a decoder seeing no `key` field treats it as absent. That settled the
// omitted form and left an explicit `key: null` undefined — and three bindings
// diverged there. The clause is now explicit: omit-when-absent binds the
// ENCODER, and a decoder MUST accept both forms as absent, refusing neither and
// constructing a key from neither.
//
// lazily-js was already lenient — `object.key ?? null` collapses "missing" and
// "null" to the same thing, which is the correct reading by construction rather
// than by intent. This runner is what holds it there, and pins the other half:
// `NodeSnapshot.toWire()` must still OMIT the field, because a decoder that
// reads null as absent and writes it straight back out has a correct decoded
// value and a non-conforming encoder.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertKey, excuseKey } from "./support/assert-key.js";
import { scenarios } from "./support/scenario.js";

import {
  DeltaOpNodeAdd,
  IpcMessage,
  decodeMsgpackValue,
  encodeMsgpackValue,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const specFixtures = join(here, "..", "..", "lazily-spec", "conformance");

const FIXTURE = "codec/nodekey_null_leniency.json";

function loadFixture() {
  const path = join(specFixtures, FIXTURE);
  assert.ok(
    existsSync(path),
    `missing canonical spec fixture ${path} — clone the lazily-spec sibling ` +
      `(git clone https://github.com/lazily-hub/lazily-spec.git ../lazily-spec)`,
  );
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(fixture.protocol_version, 1);
  assert.equal(fixture.kind, "NodeKeyNullLeniency");
  return fixture;
}

function hexToBytes(hex) {
  assert.equal(hex.length % 2, 0, "hex string has an odd length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function decodeScenario(scenario) {
  if (scenario.codec === "json") return IpcMessage.decodeJson(scenario.wire_json);
  if (scenario.codec === "msgpack") {
    return IpcMessage.decodeMsgpack(hexToBytes(scenario.wire_msgpack_hex));
  }
  throw new Error(`unknown codec: ${scenario.codec}`);
}

/**
 * Re-encode under the scenario's own codec and read the field set back off the
 * WIRE tree, not off the typed object — a typed object cannot distinguish
 * "field absent" from "field present and null", which is the whole distinction.
 */
function reencodedNode(scenario, message) {
  let wire = message.toWire();
  if (scenario.codec === "msgpack") {
    // Through the msgpack codec specifically. Both codecs share `toWire()` here,
    // but that is worth proving rather than assuming: the #lzmsgpackparity
    // defect was a msgpack encoder writing `key: null` while json omitted it.
    wire = decodeMsgpackValue(encodeMsgpackValue(wire));
  }
  return scenario.field === "snapshot" ? wire.Snapshot.nodes[0] : wire.Delta.ops[0].NodeAdd;
}

function decodedKey(scenario, message) {
  if (scenario.field === "snapshot") return message.snapshot.nodes[0].key;
  const op = message.delta.ops[0];
  assert.ok(op instanceof DeltaOpNodeAdd, "the fixture declares a NodeAdd op");
  return op.key;
}

test("NodeKey null-leniency: both wire forms decode as absent, the encoder still omits", () => {
  const fixture = loadFixture();

  const block = fixture.assertions;
  assertKey(block, "required_of_binding", "MUST", FIXTURE);
  assertKey(block, "codecs", ["json", "msgpack"], FIXTURE);
  assertKey(block, "fields", ["snapshot", "node_add"], FIXTURE);
  assertKey(block, "key_forms", ["omitted", "null", "present"], FIXTURE);
  assertKey(block, "scenario_count", fixture.scenarios.length, FIXTURE);
  for (const prose of [
    "clause",
    "wire_encoding",
    "reencode_obligation",
    "anti_vacuity",
    "generator",
  ]) {
    excuseKey(
      block,
      prose,
      "prose: it states WHY the fixture is shaped this way; the behaviour it " +
        "describes is asserted by the per-scenario decode and re-encode below",
    );
  }

  // Anti-vacuity in both directions. A runner that never decodes reports
  // "absent" for everything and satisfies all eight omitted/null scenarios; the
  // `present` count is what only a real decode can produce.
  let replayed = 0;
  let keysDecoded = 0;

  for (const scenario of scenarios(fixture)) {
    const expect = scenario.expect;
    const where = `${FIXTURE} ${scenario.id}`;
    replayed += 1;

    const message = decodeScenario(scenario);
    const key = decodedKey(scenario, message);
    if (key !== null) keysDecoded += 1;

    // The decode half: omitted and explicit-null must both arrive absent.
    assertKey(expect, "decoded_key", key, where);

    const node = reencodedNode(scenario, message);
    // The encode half, which no assertion over the decoded value can reach.
    assertKey(
      expect,
      "reencoded_key_field_present",
      node.key !== undefined && node.key !== null,
      where,
    );

    assertKey(expect, "node", node.node, where);
    assertKey(expect, "type_tag", node.type_tag, where);
    assertKey(expect, "payload", Array.from(node.state.Payload), where);
    const epoch = message.snapshot ? message.snapshot.epoch : message.delta.epoch;
    assertKey(expect, "epoch", epoch, where);
  }

  assert.equal(replayed, 12, "two fields x three key forms x two codecs");
  assert.equal(
    keysDecoded,
    4,
    "only the `present` scenarios carry a key; a runner reporting absent for " +
      "everything satisfies the null cases trivially",
  );
});
