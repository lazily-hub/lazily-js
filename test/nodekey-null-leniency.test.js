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

import {
  assertKey,
  assertKeyWith,
  fnv1a64Hex,
  proseKey,
  verifyProse,
} from "./support/assert-key.js";
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

/**
 * Decode under the scenario's own codec.
 *
 * `observedCodecs` collects the branch really taken, where it is taken
 * (#lznullformblind). The `codecs` vocabulary is asserted against that set, so a
 * codec the corpus declares and this runner never dispatches on fails rather
 * than matching a runner-side transcription forever.
 */
function decodeScenario(scenario, expect, observedCodecs) {
  if (scenario.codec === "json") {
    observedCodecs.add("json");
    const wireInput = Buffer.from(scenario.wire_json, "utf8");
    assertKey(expect, "wire_input_fnv1a64", fnv1a64Hex(wireInput));
    return IpcMessage.decodeJson(wireInput.toString("utf8"));
  }
  if (scenario.codec === "msgpack") {
    observedCodecs.add("msgpack");
    const wireInput = hexToBytes(scenario.wire_msgpack_hex);
    assertKey(expect, "wire_input_fnv1a64", fnv1a64Hex(wireInput));
    return IpcMessage.decodeMsgpack(wireInput);
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
  const observed = "key" in node ? { present: true, value: node.key } : { present: false };
  // The msgpack half of this control still runs through THIS BINDING's
  // `decodeMsgpackValue`, so a defect there corrupts the control and the thing
  // controlled together: the control would agree with the decode because both
  // came out of the same code. `rawMsgpackKey` is a second witness that never
  // touches the decoder.
  if (scenario.codec === "msgpack") {
    const raw = rawMsgpackKey(scenario.wire_msgpack_hex);
    assert.equal(
      raw.present,
      observed.present,
      `${scenario.id}: the raw bytes and decodeMsgpackValue disagree about whether a \`key\` ` +
        "entry is on the wire — one of the two is wrong and the control cannot arbitrate itself",
    );
    if (raw.present) {
      assert.equal(
        raw.nil,
        observed.value === null,
        `${scenario.id}: the raw bytes and decodeMsgpackValue disagree about whether the ` +
          "`key` entry is msgpack nil",
      );
    }
  }
  return observed;
}

// `a3 6b 65 79` is the msgpack encoding of the map key "key": `0xa3` is the
// fixstr header for a 3-byte string, then `k`, `e`, `y`. The byte immediately
// after it is the value's own type header, and `0xc0` is nil.
const KEY_FIXSTR_HEX = "a36b6579";

/**
 * The `key` slot of a msgpack frame, read off the raw hex WITHOUT this
 * binding's decoder.
 *
 * Deliberately dumb: it does not parse the frame, it locates one two-byte
 * sequence. That is the point — a witness sharing no code with the thing it
 * witnesses is the only kind that can contradict it.
 */
function rawMsgpackKey(hex) {
  const at = hex.indexOf(KEY_FIXSTR_HEX);
  if (at === -1) return { present: false };
  const after = at + KEY_FIXSTR_HEX.length;
  // One `key` entry per frame in this fixture. More than one and this witness
  // would be reading a slot the scenario is not about, which is worse than not
  // witnessing at all.
  assert.equal(
    hex.indexOf(KEY_FIXSTR_HEX, after),
    -1,
    "the frame carries more than one `key` map entry; this witness cannot tell which is " +
      "the node's own",
  );
  const header = hex.slice(after, after + 2);
  assert.equal(header.length, 2, "the `key` entry is the last thing on the wire, with no value");
  return { present: true, nil: header === "c0" };
}

/**
 * The DECODED `key` of the scenario's node.
 *
 * `observedFields` collects the frame position really read, where it is read
 * (#lznullformblind) — the `fields` vocabulary is asserted against that set
 * rather than against a transcription of the corpus's list.
 */
function decodedKey(scenario, message, observedFields) {
  if (scenario.field === "snapshot") {
    observedFields.add("snapshot");
    return message.snapshot.nodes[0].key;
  }
  // Same fail-open on the decode half (#lzscenariobodyskip).
  if (scenario.field !== "node_add") {
    throw new Error(`unknown scenario field in fixture: ${scenario.field}`);
  }
  observedFields.add("node_add");
  const op = message.delta.ops[0];
  assert.ok(op instanceof DeltaOpNodeAdd, "the fixture declares a NodeAdd op");
  return op.key;
}

test("NodeKey null-leniency: both wire forms decode as absent, the encoder still omits", () => {
  const fixture = loadFixture();

  const block = fixture.assertions;
  assertKey(block, "required_of_binding", "MUST", FIXTURE);
  // `codecs`, `fields`, `key_forms` and `scenario_count` are asserted AFTER the
  // loop, against the branches this run really dispatched on and the scenarios
  // it really replayed (#lznullformblind). Transcribing the corpus's own lists
  // here — and comparing `scenario_count` to `fixture.scenarios.length` — is the
  // fixture agreeing with itself: every one of those four stays green over a
  // runner that decodes nothing, which is exactly what `anti_vacuity` forbids.
  const observedCodecs = new Set();
  const observedFields = new Set();
  const observedKeyForms = new Set();
  // The four PARAGRAPHS the corpus declares in `assertions.prose`
  // (#lzprosekeyconvention), each discharged by naming the executable keys that
  // carry it; `verifyProse` below checks this run really asserted them.
  proseKey(block, "clause", [
    // Both wire forms decode as absent (refusing neither, constructing a key
    // from neither), and omit-when-absent still binds the encoder.
    "decoded_key",
    "reencoded_key_field_present",
  ]);
  proseKey(block, "wire_encoding", ["wire_input_fnv1a64"]);
  proseKey(block, "reencode_obligation", [
    // Named in the paragraph itself.
    "reencoded_key_field_present",
  ]);
  proseKey(block, "anti_vacuity", [
    // The `present` scenarios force a real key through, which only a real decode
    // produces; `keysDecoded` below pins the count.
    //
    // `scenario_count` is the second half, and it only became evidence under
    // #lznullformblind: it is `replayed`, so a loop that entered no body cannot
    // reach the declared count. As `fixture.scenarios.length` it was an identity
    // over the fixture — the paragraph most about vacuity discharged by the most
    // vacuous assertion in the file.
    "decoded_key",
    "scenario_count",
  ]);
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
      observedKeyForms.add("omitted");
      assert.equal(
        onWire.present,
        false,
        `${where}: the omitted form must carry NO \`key\` entry on the wire — otherwise it is ` +
          "the null scenario under a different id",
      );
    } else if (scenario.key_form === "null") {
      observedKeyForms.add("null");
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
      observedKeyForms.add("present");
      assert.ok(onWire.present, `${where}: the present form must carry a \`key\` entry`);
      assert.notEqual(onWire.value, null, `${where}: the present form must carry a real key`);
    } else {
      // Fail closed rather than letting an unrecognised form skip the control
      // (#lzscenariobodyskip).
      throw new Error(`unknown key_form in fixture: ${scenario.key_form}`);
    }

    const message = decodeScenario(scenario, expect, observedCodecs);
    const key = decodedKey(scenario, message, observedFields);
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

  // ---- The three vocabularies, against what this run REALLY dispatched on ----
  //
  // Each is a set difference in both directions (#lznullformblind). A corpus
  // that grows a fourth key form, or a runner that quietly stops taking one of
  // the branches, is a failure here — where a transcribed literal would keep
  // agreeing with the fixture forever.
  const vocabulary = [
    ["codecs", observedCodecs, "codecs"],
    ["fields", observedFields, "frame positions"],
    ["key_forms", observedKeyForms, "key forms"],
  ];
  for (const [key, observed, noun] of vocabulary) {
    assertKeyWith(
      block,
      key,
      (declared) => {
        assert.deepStrictEqual(
          [...observed].sort(),
          [...declared].sort(),
          `${FIXTURE}: the ${noun} replayed and the ${noun} declared differ`,
        );
      },
      FIXTURE,
    );
  }
  // Against what this run REPLAYED, not `fixture.scenarios.length` — the
  // identity form holds however few scenarios the loop entered.
  assertKey(block, "scenario_count", replayed, FIXTURE);

  verifyProse(fixture);

  assert.equal(replayed, 12, "two fields x three key forms x two codecs");
  assert.equal(
    keysDecoded,
    4,
    "only the `present` scenarios carry a key; a runner reporting absent for " +
      "everything satisfies the null cases trivially",
  );
});
