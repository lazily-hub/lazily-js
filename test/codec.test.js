// Frame-codec round-trip conformance (#lzmsgpackparity).
//
// protocol.md § Frame codecs makes `json` (the reference codec) and `msgpack`
// (the cross-language binary default) MUST-level for every binding, and
// requires every frame to round-trip through both for all three IpcMessage
// variants. That requirement lived only in prose. The four conformance rungs —
// was the fixture OPENED, were its keys CONSUMED, were they ASSERTED, was every
// SCENARIO replayed — all reason about fixture *content*, and content replay
// never exercises a codec, so a binding could carve out a MUST-level codec and
// stay green on every rung.
//
// lazily-js implements BOTH halves as of #lzmsgpackseven: `json` in
// `IpcMessage.encodeJson`/`decodeJson`, `msgpack` in
// `encodeMsgpack`/`decodeMsgpack` over src/msgpack-codec.js. Neither fixture is
// in KNOWN_UNCOVERED any more.
//
// The runner decodes `wire`, RE-ENCODES the decoded message, decodes again, and
// checks every `expect` key against that second decode. Asserting against the
// fixture literal would prove nothing: the literal never passed through an
// encoder.
//
// The msgpack half additionally introspects the ENCODED BYTES schema-lessly.
// The named-field rule is a property of the encoding, so it is invisible to any
// assertion over a decoded `IpcMessage`: a positional encoder round-trips every
// value below correctly and is still unreadable by a conforming peer.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { assertKey, proseKey, verifyProse } from "./support/assert-key.js";
import { scenarios } from "./support/scenario.js";

import {
  DeltaOpCellSet,
  DeltaOpEdgeAdd,
  DeltaOpEdgeRemove,
  DeltaOpInvalidate,
  DeltaOpNodeAdd,
  DeltaOpNodeRemove,
  DeltaOpSlotValue,
  IpcMessage,
  IpcValueInline,
  NodeStateOpaque,
  NodeStatePayload,
  Snapshot,
  decodeMsgpackValue,
} from "../src/index.js";

import { conformanceRoot } from "./spec-corpus.cjs";

const specFixtures = conformanceRoot;

const JSON_FIXTURE = "codec/frame_roundtrip_json.json";
const MSGPACK_FIXTURE = "codec/frame_roundtrip_msgpack.json";

function loadCodecFixture(name) {
  const path = join(specFixtures, name);
  assert.ok(
    existsSync(path),
    `missing canonical spec fixture ${path} — clone the lazily-spec sibling ` +
      `(git clone https://github.com/lazily-hub/lazily-spec.git ../lazily-spec)`,
  );
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(fixture.protocol_version, 1);
  assert.equal(fixture.kind, "FrameCodecRoundTrip");
  return fixture;
}

const DELTA_OP_KINDS = [
  [DeltaOpCellSet, "CellSet"],
  [DeltaOpSlotValue, "SlotValue"],
  [DeltaOpInvalidate, "Invalidate"],
  [DeltaOpNodeAdd, "NodeAdd"],
  [DeltaOpNodeRemove, "NodeRemove"],
  [DeltaOpEdgeAdd, "EdgeAdd"],
  [DeltaOpEdgeRemove, "EdgeRemove"],
];

function deltaOpVariant(op) {
  const found = DELTA_OP_KINDS.find(([cls]) => op instanceof cls);
  if (!found) throw new Error(`unknown DeltaOp: ${op?.constructor?.name}`);
  return found[1];
}

function assertSnapshot(block, snap, where) {
  assertKey(block, "epoch", snap.epoch, where);
  assertKey(block, "node_count", snap.nodes.length, where);
  assertKey(block, "edge_count", snap.edges.length, where);
  assertKey(block, "root_count", snap.roots.length, where);
  assertKey(block, "first_node_type_tag", snap.nodes[0].typeTag, where);
  const state = snap.nodes[0].state;
  assert.ok(state instanceof NodeStatePayload, "first node carries Payload bytes");
  assertKey(block, "first_node_payload", Array.from(state.bytes), where);

  const opaque = snap.nodes.find((n) => n.state instanceof NodeStateOpaque);
  assert.ok(opaque, "fixture pins an Opaque node");
  assertKey(block, "opaque_node_id", opaque.node, where);
  // The externally-tagged UNIT variant is the shape most likely to decay into
  // `{"Opaque": null}` under a re-encode, so name it rather than infer it.
  assertKey(block, "opaque_node_state_tag", opaque.state.toWire(), where);

  assertKey(block, "first_edge", [snap.edges[0].dependent, snap.edges[0].dependency], where);
  assertKey(block, "roots", Array.from(snap.roots), where);
}

function assertDelta(block, delta, where) {
  assertKey(block, "base_epoch", delta.baseEpoch, where);
  assertKey(block, "epoch", delta.epoch, where);
  assertKey(block, "op_count", delta.ops.length, where);
  assertKey(block, "op_variants", delta.ops.map(deltaOpVariant), where);

  const first = delta.ops[0];
  assert.ok(first instanceof DeltaOpCellSet, "first op is a CellSet");
  assert.ok(first.payload instanceof IpcValueInline, "first op payload is Inline");
  assertKey(block, "first_op_payload", Array.from(first.payload.bytes), where);

  const nodeAdd = delta.ops.find((op) => op instanceof DeltaOpNodeAdd);
  assert.ok(nodeAdd, "fixture pins a NodeAdd op");
  assertKey(block, "node_add_type_tag", nodeAdd.typeTag, where);
}

function assertCrdtSync(block, sync, where) {
  assertKey(block, "frontier_len", sync.frontier.length, where);
  assertKey(block, "frontier_first_peer", sync.frontier[0].peer, where);
  assertKey(block, "frontier_first_stamp_wall_time", sync.frontier[0].stamp.wallTime, where);
  assertKey(block, "op_count", sync.ops.length, where);
  assertKey(block, "first_op_node", sync.ops[0].node, where);
  // Decoded-value assertion, not an encoding one: both self-describing codecs
  // WRITE `key` for a CrdtOp (null when unset — an anti-entropy op's addressing
  // is part of its merge identity). What must survive the round trip is that
  // the decoder reads that null back as absent.
  assertKey(block, "first_op_key_absent", sync.ops[0].key === null, where);
  assertKey(block, "second_op_node", sync.ops[1].node, where);
  assertKey(block, "second_op_key", sync.ops[1].key, where);
  assertKey(block, "second_op_stamp_peer", sync.ops[1].stamp.peer, where);
}

function assertValues(block, message, where) {
  if (message.isSnapshot) return assertSnapshot(block, message.snapshot, where);
  if (message.isDelta) return assertDelta(block, message.delta, where);
  if (message.isCrdtSync) return assertCrdtSync(block, message.crdtSync, where);
  throw new Error(`codec fixture pins no runner for ${message.kind}`);
}

test("json frames round-trip through the reference codec", () => {
  const fixture = loadCodecFixture(JSON_FIXTURE);
  assert.equal(fixture.codec, "json");

  // The fixture-level block pins the codec's identity and the two distinct
  // senses of "canonical" protocol.md keeps apart (`role` = the required
  // interop floor, `byte_canonical` = one deterministic byte form per message).
  const meta = fixture.assertions;
  assertKey(meta, "codec", "json", "assertions");
  // CORPUS DECLARATIONS, deliberately compared against a runner-side literal
  // (#lznullformblind). `self_describing`, `byte_canonical`, `role` and
  // `required_of_binding` state what two CONFORMING BINDINGS may do; no single
  // binding's run produces a comparable value, so "assert it against what the
  // run produced" has nothing to reach for. Pinning them by agreement is the
  // point, and this is the boundary of the rule the `scenario_count` fix below
  // is an instance of — not another instance of the vacuity.
  assertKey(meta, "self_describing", true, "assertions");
  assertKey(meta, "byte_canonical", true, "assertions");
  assertKey(meta, "required_of_binding", "MUST", "assertions");
  assertKey(meta, "role", "reference", "assertions");
  // `scenario_count` is asserted AFTER the loop, against what this run really
  // replayed (#lznullformblind).
  // The one PARAGRAPH the corpus declares in `assertions.prose`
  // (#lzprosekeyconvention). It says both senses of "canonical" are pinned here
  // so a runner cannot conflate them, and those two keys are exactly what
  // discharges it.
  proseKey(meta, "note", ["role", "byte_canonical"]);

  let replayed = 0;
  for (const scenario of scenarios(fixture)) {
    const where = scenario.id;
    const source = IpcMessage.fromWire(scenario.wire);
    assert.equal(source.kind, scenario.variant, `${where}: fixture variant vs decoded frame`);

    // Encode the DECODED message and decode the result. The fixture literal is
    // never re-asserted, so a codec that silently drops a field cannot be
    // masked by reading the input back.
    const roundTripped = IpcMessage.decodeJson(source.encodeJson());

    const block = scenario.expect;
    assertKey(block, "round_trip_equals_source", deepEqual(roundTripped, source), where);
    assertValues(block, roundTripped, where);
    replayed += 1;
  }
  // Against what this run REPLAYED, not against `fixture.scenarios.length`
  // (#lznullformblind). Comparing the fixture's declared count to the fixture's
  // own array is an identity: it holds however few scenarios the loop entered,
  // and stays green over a runner that decodes nothing — the exact vacuity the
  // corpus's own anti-vacuity reasoning exists to name.
  assertKey(meta, "scenario_count", replayed, "assertions");

  verifyProse(fixture);
  assert.equal(replayed, 3, "one scenario per IpcMessage variant");
});

// Sorted own-key names of a schema-lessly decoded map. Sorted because a
// MessagePack map's key order is encoder-defined (§ Frame codecs,
// `byte_canonical: false`) — comparing insertion order would pin a property no
// conforming peer owes anyone.
function sortedFieldNames(value) {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "expected a named-field map, got " + (Array.isArray(value) ? "an array" : typeof value),
  );
  return Object.keys(value).sort();
}

test("msgpack frames round-trip through the cross-language binary default", () => {
  const fixture = loadCodecFixture(MSGPACK_FIXTURE);
  assert.equal(fixture.codec, "msgpack");

  const meta = fixture.assertions;
  assertKey(meta, "codec", "msgpack", "assertions");
  // Corpus declarations, compared against a literal by design — see the json
  // half above (#lznullformblind).
  assertKey(meta, "self_describing", true, "assertions");
  // The reason this fixture pins decoded values instead of golden bytes.
  assertKey(meta, "byte_canonical", false, "assertions");
  assertKey(meta, "required_of_binding", "MUST", "assertions");
  assertKey(meta, "role", "cross_language_binary_default", "assertions");
  // `scenario_count` is asserted AFTER the loop, against what this run really
  // replayed (#lznullformblind).
  // The paragraph's own subject: `byte_canonical: false` is why this fixture
  // pins decoded values instead of golden bytes, and the named-field rule it
  // states is what `encoded_body_field_names` asserts executably
  // (#lzprosekeyconvention).
  proseKey(meta, "note", ["byte_canonical", "encoded_body_field_names"]);

  let replayed = 0;
  for (const scenario of scenarios(fixture)) {
    const where = scenario.id;
    const source = IpcMessage.fromWire(scenario.wire);
    assert.equal(source.kind, scenario.variant, `${where}: fixture variant vs decoded frame`);

    const bytes = source.encodeMsgpack();
    const roundTripped = IpcMessage.decodeMsgpack(bytes);

    // Schema-less view of the bytes actually produced. This is the only way to
    // see the named-field rule: a positional encoder passes every value
    // assertion below and fails here.
    const generic = decodeMsgpackValue(bytes);
    assert.ok(
      generic !== null && typeof generic === "object" && !Array.isArray(generic),
      `${where}: IpcMessage is externally tagged — a one-entry map`,
    );
    const envelopeKeys = Object.keys(generic);
    assert.equal(envelopeKeys.length, 1, `${where}: external tag is a one-entry map`);
    const tag = envelopeKeys[0];
    const body = generic[tag];

    const block = scenario.expect;
    assertKey(block, "round_trip_equals_source", deepEqual(roundTripped, source), where);
    assertKey(block, "encoded_envelope_key", tag, where);
    assertKey(block, "encoded_body_field_names", sortedFieldNames(body), where);

    if (tag === "Snapshot") {
      // `NodeSnapshot.key` is optional and OMITTED when absent in a
      // self-describing codec — the rule that lets a pre-`key` decoder read a
      // post-`key` frame. It has to hold under msgpack exactly as under json,
      // which is the whole point of encoding named fields.
      assertKey(block, "first_node_encoded_field_names", sortedFieldNames(body.nodes[0]), where);
    } else if (tag === "CrdtSync") {
      // `CrdtOp` differs deliberately: it ALWAYS writes `key` (null when
      // unset), because an anti-entropy op's addressing is part of its merge
      // identity. Both lists therefore carry `key`.
      assertKey(block, "first_op_encoded_field_names", sortedFieldNames(body.ops[0]), where);
      assertKey(block, "second_op_encoded_field_names", sortedFieldNames(body.ops[1]), where);
    } else {
      // The chain had no closing arm (#lzscenariobodyskip): `Delta` legitimately
      // carries no per-element field-name expectation, but an unrecognised tag
      // took the same silent path, so the named-field rule would go unchecked
      // for a variant nobody noticed was missing an arm.
      assert.equal(tag, "Delta", `${where}: unknown IpcMessage envelope tag ${tag}`);
    }

    assertValues(block, roundTripped, where);
    replayed += 1;
  }
  // Against what this run REPLAYED, not against `fixture.scenarios.length`
  // (#lznullformblind) — see the json half above for why the identity is
  // vacuous.
  assertKey(meta, "scenario_count", replayed, "assertions");

  verifyProse(fixture);
  assert.equal(replayed, 3, "one scenario per IpcMessage variant");
});

// Byte payloads are ARRAYS OF INTEGERS on this wire, never MessagePack `bin`.
// That is what the reference encoder produces (`rmp_serde` serializes `Vec<u8>`
// through serde's default seq impl) and what its decoder accepts, so a codec
// that emits or accepts `bin` in a byte-payload position is outside the wire it
// claims. No fixture can pin this — the corpus is written in the reference JSON
// form, where the distinction does not exist.
test("msgpack byte payloads are arrays of integers, not `bin`", () => {
  const message = IpcMessage.snapshot(
    Snapshot.fromWire({
      epoch: 1,
      nodes: [{ node: 1, type_tag: "i32", state: { Payload: [1, 2, 3] } }],
      edges: [],
      roots: [1],
    }),
  );
  const bytes = message.encodeMsgpack();
  // 0xc4/0xc5/0xc6 are the `bin` family headers. None may appear as a value
  // header; the payload rides as a 3-element array of fixints instead.
  const tree = decodeMsgpackValue(bytes);
  assert.deepEqual(tree.Snapshot.nodes[0].state.Payload, [1, 2, 3]);

  // Hand-built `bin 8` frame in the same position: rejected, not tolerated.
  const withBin = Uint8Array.from([
    0x81,
    ...[0xa8, ...new TextEncoder().encode("Snapshot")],
    0xc4,
    0x03,
    1,
    2,
    3,
  ]);
  assert.throws(() => decodeMsgpackValue(withBin), /not msgpack `bin`/);
});

// protocol.md § NodeId / PeerId: `NodeId`/`PeerId` are `u64` "serialized as bare
// JSON numbers", and "JavaScript/TypeScript peers must keep values at or below
// `Number.MAX_SAFE_INTEGER` (2^53)". That bound was enforced but never pinned,
// and an enforced-but-untested rule is one refactor from silently regressing
// into the worst available failure: `JSON.parse` does not throw on
// `9007199254740993`, it returns `9007199254740992`. A corrupted node id that
// decodes cleanly is undetectable downstream.
//
// The rule is testable without source-text access precisely because the
// rounding lands out of range: every integer literal above 2^53 - 1 parses to a
// double >= 2^53, and `Number.isSafeInteger` is false for all of those. So the
// damage is its own evidence.
//
// Both codecs must answer identically. A binding that refuses a frame under
// `msgpack` and quietly mangles the same frame under `json` would be lying in
// the REFERENCE codec, which is the one every other binding is checked against.
const UNREPRESENTABLE = "9007199254740993"; // 2^53 + 1

const outOfRangeFrames = {
  "Snapshot.epoch": `{"Snapshot":{"epoch":${UNREPRESENTABLE},"nodes":[],"edges":[],"roots":[]}}`,
  "Snapshot.nodes[].node": `{"Snapshot":{"epoch":1,"nodes":[{"node":${UNREPRESENTABLE},"type_tag":"i32","state":"Opaque"}],"edges":[],"roots":[]}}`,
  "Snapshot.edges[].dependent": `{"Snapshot":{"epoch":1,"nodes":[],"edges":[{"dependent":${UNREPRESENTABLE},"dependency":1}],"roots":[]}}`,
  "Snapshot.roots[]": `{"Snapshot":{"epoch":1,"nodes":[],"edges":[],"roots":[${UNREPRESENTABLE}]}}`,
  "NodeState.SharedBlob.offset": `{"Snapshot":{"epoch":1,"nodes":[{"node":1,"type_tag":"b","state":{"SharedBlob":{"offset":${UNREPRESENTABLE},"len":1,"generation":1,"epoch":1,"checksum":1}}}],"edges":[],"roots":[]}}`,
  "Delta.base_epoch": `{"Delta":{"base_epoch":${UNREPRESENTABLE},"epoch":2,"ops":[]}}`,
  "Delta.ops[].node": `{"Delta":{"base_epoch":1,"epoch":2,"ops":[{"Invalidate":{"node":${UNREPRESENTABLE}}}]}}`,
  "CrdtSync.frontier[].peer": `{"CrdtSync":{"frontier":[[${UNREPRESENTABLE},{"wall_time":5,"logical":0,"peer":1}]],"ops":[]}}`,
  "CrdtSync.stamp.wall_time": `{"CrdtSync":{"frontier":[[1,{"wall_time":${UNREPRESENTABLE},"logical":0,"peer":1}]],"ops":[]}}`,
  "CrdtSync.stamp.logical": `{"CrdtSync":{"frontier":[[1,{"wall_time":5,"logical":${UNREPRESENTABLE},"peer":1}]],"ops":[]}}`,
  "CrdtSync.ops[].node": `{"CrdtSync":{"frontier":[],"ops":[{"node":${UNREPRESENTABLE},"key":null,"stamp":{"wall_time":5,"logical":0,"peer":1},"state":{"Inline":[1]}}]}}`,
  "ResyncRequest.from_epoch": `{"ResyncRequest":{"from_epoch":${UNREPRESENTABLE}}}`,
  "OutboxAck.through_epoch": `{"OutboxAck":{"through_epoch":${UNREPRESENTABLE}}}`,
};

test("json decode refuses an id this runtime cannot represent, in every integer position", () => {
  // Pin the premise first: the raw parse really does round silently, so this
  // test is guarding against something rather than restating what JSON.parse
  // already refuses.
  assert.equal(JSON.parse(`{"n":${UNREPRESENTABLE}}`).n, 9007199254740992);

  for (const [position, frame] of Object.entries(outOfRangeFrames)) {
    assert.throws(
      () => IpcMessage.decodeJson(frame),
      /safe[- ]integer/,
      `${position} should refuse an unrepresentable id rather than round it`,
    );
  }
});

test("msgpack decode gives the same answer as json for an unrepresentable id", () => {
  // Same values, encoded as msgpack by hand so the frame never passes through
  // this binding's own encoder (which would refuse to build it in the first
  // place). The two codecs have to agree: refusing under one and rounding
  // under the other is the split this test exists to prevent.
  const packStr = (s) => {
    const bytes = new TextEncoder().encode(s);
    return [0xa0 | bytes.length, ...bytes];
  };
  const packU64 = (hi, lo) => [
    0xcf,
    (hi >>> 24) & 0xff,
    (hi >>> 16) & 0xff,
    (hi >>> 8) & 0xff,
    hi & 0xff,
    (lo >>> 24) & 0xff,
    (lo >>> 16) & 0xff,
    (lo >>> 8) & 0xff,
    lo & 0xff,
  ];
  // 2^53 + 1 == 0x0020000000000001
  const frame = Uint8Array.from([
    0x81,
    ...packStr("ResyncRequest"),
    0x81,
    ...packStr("from_epoch"),
    ...packU64(0x00200000, 0x00000001),
  ]);
  assert.throws(() => IpcMessage.decodeMsgpack(frame), /safe[- ]integer/);
});

test("the largest representable id is accepted by both codecs", () => {
  // The boundary matters in both directions: a guard that refused everything
  // large would also pass the two tests above while breaking real frames.
  const frame = `{"ResyncRequest":{"from_epoch":${Number.MAX_SAFE_INTEGER}}}`;
  const message = IpcMessage.decodeJson(frame);
  assert.equal(message.resyncRequest.fromEpoch, Number.MAX_SAFE_INTEGER);
  assert.equal(
    IpcMessage.decodeMsgpack(message.encodeMsgpack()).resyncRequest.fromEpoch,
    Number.MAX_SAFE_INTEGER,
  );
});

// `assert.deepEqual` throws rather than returning a verdict, and the fixture
// pins a boolean. Wrap it so the fixture's own `true` is what the runner is
// compared against (`#lzconsumednotasserted`) instead of an assertion that
// bypasses the key entirely.
function deepEqual(a, b) {
  try {
    assert.deepEqual(a, b);
    return true;
  } catch {
    return false;
  }
}
