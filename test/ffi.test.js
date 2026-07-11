import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { IpcMessage } from "../src/index.js";
import {
  FfiChannel,
  LazilyFfiMessageKind,
  LazilyFfiStatus,
  decodeMessage,
  encodeMessage,
  hasNativeBinding,
  kindOf,
  validateMessage,
} from "../src/ffi.js";

const here = dirname(fileURLToPath(import.meta.url));
const specConformance = join(here, "..", "..", "lazily-spec", "conformance");

function loadWire(name) {
  const path = join(specConformance, name);
  assert.ok(existsSync(path), `missing spec fixture ${name}`);
  return JSON.parse(readFileSync(path, "utf8")).wire;
}

// --- codec: kind discrimination (schemas/ffi.json § LazilyFfiMessageKind) ---
test("kindOf discriminates Snapshot / Delta / CrdtSync", () => {
  const snap = IpcMessage.fromWire(loadWire("snapshot_minimal.json"));
  const delta = IpcMessage.fromWire(loadWire("delta_sequential.json"));
  assert.equal(kindOf(snap), LazilyFfiMessageKind.Snapshot);
  assert.equal(kindOf(delta), LazilyFfiMessageKind.Delta);
  assert.equal(kindOf(null), LazilyFfiMessageKind.Unknown);
});

// --- codec: encode/decode round-trip over real spec wire --------------------
test("encodeMessage / decodeMessage round-trips canonical wire", () => {
  for (const name of ["snapshot_minimal.json", "snapshot_multi_node.json", "delta_sequential.json"]) {
    const wire = loadWire(name);
    const msg = IpcMessage.fromWire(wire);
    const enc = encodeMessage(msg);
    assert.equal(enc.status, LazilyFfiStatus.Ok, `${name} encode Ok`);
    assert.equal(enc.kind, kindOf(msg), `${name} kind`);
    const dec = decodeMessage(enc.payload);
    assert.equal(dec.status, LazilyFfiStatus.Ok, `${name} decode Ok`);
    assert.deepEqual(dec.message.toWire(), wire, `${name} wire preserved`);
  }
});

test("decodeMessage reports Empty for empty input and InvalidMessage for garbage", () => {
  assert.equal(decodeMessage(new Uint8Array(0)).status, LazilyFfiStatus.Empty);
  assert.equal(decodeMessage("").status, LazilyFfiStatus.Empty);
  assert.equal(decodeMessage("}{not json").status, LazilyFfiStatus.InvalidMessage);
  // Valid JSON but not a tagged IpcMessage envelope → InvalidMessage.
  assert.equal(validateMessage("{}"), LazilyFfiStatus.InvalidMessage);
});

// --- in-process channel (browser shim = default) ---------------------------
test("FfiChannel is a validated JSON-frame FIFO", () => {
  const snap = IpcMessage.fromWire(loadWire("snapshot_minimal.json"));
  const delta = IpcMessage.fromWire(loadWire("delta_sequential.json"));
  const ch = FfiChannel.create();
  assert.equal(ch.len(), 0);
  assert.equal(ch.isEmpty, true);

  assert.equal(ch.send(snap), LazilyFfiStatus.Ok);
  assert.equal(ch.send(delta), LazilyFfiStatus.Ok);
  assert.equal(ch.len(), 2);

  const first = ch.recv();
  assert.equal(first.status, LazilyFfiStatus.Ok);
  assert.ok(first.message.isSnapshot, "FIFO order: snapshot first");
  const second = ch.recv();
  assert.ok(second.message.isDelta, "FIFO order: delta second");

  assert.equal(ch.recv().status, LazilyFfiStatus.Empty);
  assert.equal(ch.recvJson().status, LazilyFfiStatus.Empty);
});

test("FfiChannel.sendJson rejects invalid frames without enqueueing", () => {
  const ch = FfiChannel.create();
  assert.equal(ch.sendJson("not json"), LazilyFfiStatus.InvalidMessage);
  assert.equal(ch.sendJson(new Uint8Array(0)), LazilyFfiStatus.Empty);
  assert.equal(ch.len(), 0);
});

test("FfiChannel.free fails closed on subsequent ops", () => {
  const ch = FfiChannel.create();
  const snap = IpcMessage.fromWire(loadWire("snapshot_minimal.json"));
  ch.send(snap);
  ch.free();
  assert.equal(ch.send(snap), LazilyFfiStatus.NullPointer);
  assert.equal(ch.recvJson().status, LazilyFfiStatus.NullPointer);
});

test("sendJson copies the frame — later buffer mutation does not corrupt the queue", () => {
  const snap = IpcMessage.fromWire(loadWire("snapshot_minimal.json"));
  const bytes = snap.encodeJson();
  const ch = FfiChannel.create();
  assert.equal(ch.sendJson(bytes), LazilyFfiStatus.Ok);
  bytes.fill(0); // mutate the caller's buffer after send
  const got = ch.recv();
  assert.equal(got.status, LazilyFfiStatus.Ok);
  assert.ok(got.message.isSnapshot);
});

// --- native binding availability (isomorphic core reports false) ------------
test("hasNativeBinding is false for the isomorphic core", () => {
  assert.equal(hasNativeBinding(), false);
});
