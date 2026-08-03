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

import { assertKey, excuseKey, proseKey, verifyProse } from "./support/assert-key.js";
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
  // The ternary's false arm assumed `node_add` (#lzscenariobodyskip): an
  // unrecognised `field` read the DELTA branch, so the re-encode half of the
  // contract would have been asserted about a frame the scenario never named.
  if (scenario.field === "snapshot") return wire.Snapshot.nodes[0];
  if (scenario.field === "node_add") return wire.Delta.ops[0].NodeAdd;
  throw new Error(`unknown scenario field in fixture: ${scenario.field}`);
}

/**
 * The raw `key` slot of the scenario's node, parsed WITHOUT the library.
 *
 * The three key forms are `omitted`, `null` and `present`, and the first two are
 * indistinguishable once decoded — `object.key ?? null` collapses them, which is
 * the correct reading and also the reason no assertion over the decoded value can
 * tell the two scenario families apart. Without this, the four `null` scenarios
 * are the four `omitted` ones wearing a different id, and `wire_encoding`'s
 * obligation — that the exact wire form survives into the runner — is discharged
 * by nothing.
 */
function wireKey(scenario) {
  let wire;
  // Fail closed on both dispatches (#lzscenariobodyskip), as every other arm in
  // this file does: a fallback arm inspects a frame the scenario never named.
  if (scenario.codec === "json") wire = JSON.parse(scenario.wire_json);
  else if (scenario.codec === "msgpack")
    wire = decodeMsgpackValue(hexToBytes(scenario.wire_msgpack_hex));
  else throw new Error(`unknown codec: ${scenario.codec}`);
  let node;
  if (scenario.field === "snapshot") node = wire.Snapshot.nodes[0];
  else if (scenario.field === "node_add") node = wire.Delta.ops[0].NodeAdd;
  else throw new Error(`unknown scenario field in fixture: ${scenario.field}`);
  // `in`, not `?.` or `??`: absent and null are two of the three forms under
  // test and the whole point is that they stay distinguishable.
  return "key" in node ? { present: true, value: node.key } : { present: false };
}

function decodedKey(scenario, message) {
  if (scenario.field === "snapshot") return message.snapshot.nodes[0].key;
  // Same fail-open on the decode half (#lzscenariobodyskip).
  if (scenario.field !== "node_add") {
    throw new Error(`unknown scenario field in fixture: ${scenario.field}`);
  }
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
  // The four PARAGRAPHS the corpus declares in `assertions.prose`
  // (#lzprosekeyconvention), each discharged by naming the executable keys that
  // carry it; `verifyProse` below checks this run really asserted them.
  proseKey(block, "clause", [
    // Both wire forms decode as absent (refusing neither, constructing a key
    // from neither), and omit-when-absent still binds the encoder.
    "decoded_key",
    "reencoded_key_field_present",
  ]);
  proseKey(block, "wire_encoding", [
    // A PROXY discharge, declared as one (#lzprosekeyconvention). The paragraph
    // is a claim about how the CORPUS carries its bytes, which no assertion a
    // run makes can observe. What a run can prove is that the distinction
    // SURVIVED into the runner: the codec and key-form vocabularies say both
    // codecs and all three forms were replayed, and `decoded_key` is the
    // assertion that carriage exists for. The `wireKey` control below is what
    // makes even the proxy honest — without it the `null` scenarios are the
    // `omitted` ones under a different id and `decoded_key` cannot tell them
    // apart.
    "codecs",
    "key_forms",
    "decoded_key",
  ]);
  proseKey(block, "reencode_obligation", [
    // Named in the paragraph itself.
    "reencoded_key_field_present",
  ]);
  proseKey(block, "anti_vacuity", [
    // The `present` scenarios force a real key through, which only a real decode
    // produces; `keysDecoded` below pins the count.
    "decoded_key",
  ]);
  excuseKey(
    block,
    "generator",
    "names the corpus-side script that mints this fixture (lazily-spec " +
      "`scripts/gen_nodekey_null_leniency_fixture.py`); nothing in this binding observes it",
  );

  // Anti-vacuity in both directions. A runner that never decodes reports
  // "absent" for everything and satisfies all eight omitted/null scenarios; the
  // `present` count is what only a real decode can produce.
  let replayed = 0;
  let keysDecoded = 0;

  for (const scenario of scenarios(fixture)) {
    const expect = scenario.expect;
    const where = `${FIXTURE} ${scenario.id}`;
    replayed += 1;

    // The distinction the DECODED value cannot carry. `object.key ?? null`
    // erases it the moment the value is in hand, so without this the four
    // `null` scenarios prove nothing the four `omitted` ones did not — and
    // `wire_encoding`'s obligation, that the exact wire form survives into the
    // runner, is discharged by an assertion that cannot see it.
    const onWire = wireKey(scenario);
    if (scenario.key_form === "omitted") {
      assert.equal(
        onWire.present,
        false,
        `${where}: the omitted form must carry NO \`key\` entry on the wire — otherwise it is ` +
          "the null scenario under a different id",
      );
    } else if (scenario.key_form === "null") {
      assert.ok(
        onWire.present,
        `${where}: the null form must carry an EXPLICIT \`key\` entry on the wire — if the ` +
          "key is absent this scenario is a duplicate of the omitted one",
      );
      assert.equal(
        onWire.value,
        null,
        `${where}: the null form must carry a JSON null / msgpack nil, not ${onWire.value}`,
      );
    } else if (scenario.key_form === "present") {
      assert.ok(onWire.present, `${where}: the present form must carry a \`key\` entry`);
      assert.notEqual(onWire.value, null, `${where}: the present form must carry a real key`);
    } else {
      // Fail closed rather than letting an unrecognised form skip the control
      // (#lzscenariobodyskip).
      throw new Error(`unknown key_form in fixture: ${scenario.key_form}`);
    }

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

  verifyProse(fixture);
});
