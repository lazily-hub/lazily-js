import assert from "node:assert/strict";
import test from "node:test";

import {
  BINDING_CAPABILITIES,
  Codec,
  FfiCapability,
  LazilyFfiMessageKind,
  LazilyFfiStatus,
  PROTOCOL_ID,
  PROTOCOL_MAJOR_VERSION,
  SessionHandshake,
} from "../src/index.js";

function handshake(overrides = {}) {
  return new SessionHandshake({
    protocol_id: PROTOCOL_ID,
    protocol_major_version: PROTOCOL_MAJOR_VERSION,
    codec: Codec.Json,
    max_frame_size: 1048576,
    fragmentation_supported: false,
    ordered_reliable: true,
    peer_id: 1,
    session_id: "abc-123",
    features: ["shared-blob"],
    ...overrides,
  });
}

test("SessionHandshake round-trips the canonical wire shape", () => {
  const local = handshake({ peer_id: 7, session_id: "s-1", features: ["shared-blob", "signaling-relay"] });
  const wire = local.toWire();
  assert.equal(wire.protocol_id, "lazily-ipc");
  assert.equal(wire.protocol_major_version, 1);
  assert.equal(wire.codec, "json");
  assert.equal(wire.peer_id, 7);
  assert.deepEqual(wire.features, ["shared-blob", "signaling-relay"]);

  const back = SessionHandshake.fromWire(wire);
  assert.deepEqual(back.toWire(), wire);
});

test("SessionHandshake encodeJson / decodeJson round-trip", () => {
  const bytes = handshake().encodeJson();
  const back = SessionHandshake.decodeJson(bytes);
  assert.deepEqual(back.toWire(), handshake().toWire());
});

test("compatible peers with matching constraints report ok", () => {
  const a = handshake({ peer_id: 1 });
  const b = handshake({ peer_id: 2 });
  assert.deepEqual(a.checkCompatible(b), { ok: true });
});

test("disagreeing protocol_major_version fails closed", () => {
  const a = handshake({ protocol_major_version: 1 });
  const b = handshake({ protocol_major_version: 2 });
  const result = a.checkCompatible(b);
  assert.equal(result.ok, false);
  assert.equal(result.field, "protocol_major_version");
});

test("disagreeing codec fails closed", () => {
  const a = handshake({ codec: "json" });
  const b = handshake({ codec: "postcard" });
  const result = a.checkCompatible(b);
  assert.equal(result.ok, false);
  assert.equal(result.field, "codec");
});

test("disagreeing ordered_reliable fails closed", () => {
  const a = handshake({ ordered_reliable: true });
  const b = handshake({ ordered_reliable: false });
  assert.equal(a.checkCompatible(b).ok, false);
});

test("a non-lazily-ipc protocol_id fails closed", () => {
  const a = handshake({});
  const b = handshake({ protocol_id: "something-else" });
  const result = a.checkCompatible(b);
  assert.equal(result.ok, false);
  assert.equal(result.field, "protocol_id");
});

test("a missing required feature fails closed", () => {
  const a = handshake({ features: ["shared-blob"] });
  const b = handshake({ features: [] });
  const result = a.checkCompatible(b, ["shared-blob"]);
  assert.equal(result.ok, false);
  assert.equal(result.field, "features");
});

test("a peer offering the required feature is accepted", () => {
  const a = handshake({ features: ["shared-blob"] });
  const b = handshake({ features: ["shared-blob", "signaling-relay"] });
  assert.deepEqual(a.checkCompatible(b, ["shared-blob"]), { ok: true });
});

test("LazilyFfiMessageKind includes CrdtSync = 3 (required discriminant)", () => {
  assert.equal(LazilyFfiMessageKind.Unknown, 0);
  assert.equal(LazilyFfiMessageKind.Snapshot, 1);
  assert.equal(LazilyFfiMessageKind.Delta, 2);
  assert.equal(LazilyFfiMessageKind.CrdtSync, 3);
});

test("LazilyFfiStatus mirrors schemas/ffi.json", () => {
  assert.deepEqual(
    [LazilyFfiStatus.Ok, LazilyFfiStatus.Empty, LazilyFfiStatus.NullPointer, LazilyFfiStatus.InvalidMessage, LazilyFfiStatus.EncodeFailed, LazilyFfiStatus.Panic],
    [0, 1, 2, 3, 4, 5],
  );
});

test("BINDING_CAPABILITIES advertises the ffi = none carve-out (browser/Worker JS)", () => {
  assert.equal(BINDING_CAPABILITIES.ffi, FfiCapability.None);
  // Must NOT be advertised as embeddable.
  assert.equal(BINDING_CAPABILITIES.ffi, "none");
});

test("BINDING_CAPABILITIES ships the reactive core", () => {
  assert.equal(BINDING_CAPABILITIES.binding, "lazily-js");
  assert.equal(BINDING_CAPABILITIES.reactive_core, true);
});

test("BINDING_CAPABILITIES declares every shipped MUST surface", () => {
  // CRDT and keyed collections have NO carve-out — they MUST be present.
  assert.equal(BINDING_CAPABILITIES.crdt, true);
  assert.equal(BINDING_CAPABILITIES.collections.cellmap, true);
  assert.equal(BINDING_CAPABILITIES.collections.celltree, true);
  assert.equal(BINDING_CAPABILITIES.collections.reconcile, true);
  assert.equal(BINDING_CAPABILITIES.sem_tree, true);
  assert.equal(BINDING_CAPABILITIES.seq_crdt, true);
  assert.equal(BINDING_CAPABILITIES.text_crdt, true);
  assert.equal(BINDING_CAPABILITIES.stable_id, true);
  assert.equal(BINDING_CAPABILITIES.ipc, true);
  assert.equal(BINDING_CAPABILITIES.state_machine, true);
  assert.equal(BINDING_CAPABILITIES.state_charts, true);
  assert.equal(BINDING_CAPABILITIES.permissions, true);
  assert.equal(BINDING_CAPABILITIES.capability_negotiation, true);
});
