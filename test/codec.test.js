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
// lazily-js implements the `json` half. `msgpack` is an explicit carve-out
// (declared in bin/interop-peer.mjs and now in
// scripts/check-conformance-coverage.sh), so codec/frame_roundtrip_msgpack.json
// is listed as known-uncovered rather than silently ignored.
//
// The runner decodes `wire`, RE-ENCODES the decoded message, decodes again, and
// checks every `expect` key against that second decode. Asserting against the
// fixture literal would prove nothing: the literal never passed through an
// encoder.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertKey, excuseKey } from "./support/assert-key.js";
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
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const specFixtures = join(here, "..", "..", "lazily-spec", "conformance");

const JSON_FIXTURE = "codec/frame_roundtrip_json.json";

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
  assertKey(meta, "self_describing", true, "assertions");
  assertKey(meta, "byte_canonical", true, "assertions");
  assertKey(meta, "required_of_binding", "MUST", "assertions");
  assertKey(meta, "role", "reference", "assertions");
  assertKey(meta, "scenario_count", fixture.scenarios.length, "assertions");
  excuseKey(
    meta,
    "note",
    "prose: documents the reference-vs-byte-canonical distinction, states nothing the replay observes",
  );

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
  assert.equal(replayed, 3, "one scenario per IpcMessage variant");
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
