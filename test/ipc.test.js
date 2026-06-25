import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  Delta,
  DeltaApplyStatusKind,
  DeltaOp,
  DeltaOpCellSet,
  DeltaOpEdgeAdd,
  DeltaOpEdgeRemove,
  DeltaOpInvalidate,
  DeltaOpNodeAdd,
  DeltaOpNodeRemove,
  DeltaOpSlotValue,
  EdgeSnapshot,
  IpcMessage,
  IpcValue,
  IpcValueSharedBlob,
  NodeSnapshot,
  NodeState,
  NodeStateOpaque,
  NodeStatePayload,
  NodeStateSharedBlob,
  OpKind,
  PeerPermissions,
  RemoteOp,
  ShmBlobRef,
  Snapshot,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const localFixtures = join(here, "conformance");
const specFixtures = join(here, "..", "..", "lazily-spec", "conformance");

function loadFixture(name) {
  const specPath = join(specFixtures, name);
  const path = existsSync(specPath) ? specPath : join(localFixtures, name);
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(fixture.protocol_version, 1);
  return fixture;
}

function assertRoundTripJson(message, fixture) {
  assert.deepEqual(message.toWire(), fixture.wire);
  assert.deepEqual(IpcMessage.decodeJson(message.encodeJson()), message);
}

function nodeStateKind(state) {
  if (state instanceof NodeStatePayload) return "Payload";
  if (state instanceof NodeStateSharedBlob) return "SharedBlob";
  if (state instanceof NodeStateOpaque) return "Opaque";
  throw new Error(`unknown NodeState class: ${state?.constructor?.name}`);
}

function deltaOpKind(op) {
  return Object.keys(op.toWire())[0];
}

function firstSharedBlob(snapshot) {
  const state = snapshot.nodes[0]?.state;
  return state instanceof NodeStateSharedBlob ? state.blob : null;
}

const ALL_OP_KINDS = Object.freeze([
  "CellSet",
  "SlotValue",
  "Invalidate",
  "NodeAdd",
  "NodeRemove",
  "EdgeAdd",
  "EdgeRemove",
]);

/**
 * Generic conformance-assertion validator (parity with lazily-kt #lzktconf):
 * cross-check every `assertions` metadata field on the fixture against the
 * parsed message so silent drift between `wire` and `assertions` is caught.
 * An unknown assertion key throws so new metadata can never be ignored.
 */
function assertFixtureAssertions(message, fixture) {
  const a = fixture.assertions;
  assert.ok(a, `fixture ${fixture.description ?? ""} missing "assertions" metadata`);

  if (message.isSnapshot) {
    const snap = message.snapshot;
    for (const [key, expected] of Object.entries(a)) {
      let actual;
      switch (key) {
        case "epoch": actual = snap.epoch; break;
        case "node_count": actual = snap.nodes.length; break;
        case "edge_count": actual = snap.edges.length; break;
        case "root_count": actual = snap.roots.length; break;
        case "first_node_type_tag": actual = snap.nodes[0].typeTag; break;
        case "first_node_state_kind": actual = nodeStateKind(snap.nodes[0].state); break;
        case "has_opaque_node":
          actual = snap.nodes.some((n) => n.state instanceof NodeStateOpaque);
          break;
        case "opaque_node_id":
          actual = snap.nodes.find((n) => n.state instanceof NodeStateOpaque)?.node;
          break;
        case "blob_offset": actual = firstSharedBlob(snap)?.offset; break;
        case "blob_len": actual = firstSharedBlob(snap)?.len; break;
        case "blob_epoch": actual = firstSharedBlob(snap)?.epoch; break;
        default: throw new Error(`unknown snapshot assertion key: ${key}`);
      }
      assert.equal(actual, expected, `snapshot assertion "${key}"`);
    }
  } else if (message.isDelta) {
    const delta = message.delta;
    for (const [key, expected] of Object.entries(a)) {
      let actual;
      switch (key) {
        case "base_epoch": actual = delta.baseEpoch; break;
        case "epoch": actual = delta.epoch; break;
        case "is_sequential": actual = delta.isNextAfter(delta.baseEpoch); break;
        case "op_count": actual = delta.ops.length; break;
        case "has_all_op_variants": {
          const kinds = new Set(delta.ops.map((op) => deltaOpKind(op)));
          actual = ALL_OP_KINDS.every((k) => kinds.has(k));
          break;
        }
        case "resync_after_epoch_10":
          actual = delta.applyStatus(10).isResyncRequired;
          break;
        case "first_op_kind": actual = deltaOpKind(delta.ops[0]); break;
        case "first_op_payload_kind":
          actual = Object.keys(delta.ops[0].payload.toWire())[0];
          break;
        default: throw new Error(`unknown delta assertion key: ${key}`);
      }
      assert.equal(actual, expected, `delta assertion "${key}"`);
    }
  } else {
    assert.fail(`unknown message kind for fixture ${fixture.description ?? ""}`);
  }
}

test("snapshot round trips through JSON bytes", () => {
  const snapshot = new Snapshot({
    epoch: 7,
    nodes: [
      NodeSnapshot.payload(1, "i32", Uint8Array.of(1, 2, 3)),
      NodeSnapshot.opaque(2, "opaque-type"),
      NodeSnapshot.sharedBlob(
        3,
        "text/plain",
        new ShmBlobRef({ offset: 0, len: 16, generation: 1, epoch: 7, checksum: 999 }),
      ),
    ],
    edges: [new EdgeSnapshot(2, 1), new EdgeSnapshot(3, 1)],
    roots: [1, 2],
  });

  const message = IpcMessage.snapshot(snapshot);
  const decoded = IpcMessage.decodeJson(message.encodeJson());

  assert.deepEqual(decoded, message);
  assert.deepEqual(decoded.snapshot, snapshot);
});

test("delta round trips all operation variants", () => {
  const delta = Delta.next(40, [
    DeltaOp.cellSet(1, Uint8Array.of(10)),
    DeltaOp.slotValue(2, Uint8Array.of(20)),
    DeltaOp.invalidate(3),
    DeltaOp.nodeAdd(4, "u64", NodeState.payload(Uint8Array.of(64))),
    DeltaOp.nodeRemove(5),
    DeltaOp.edgeAdd(2, 1),
    DeltaOp.edgeRemove(3, 1),
  ]);

  const message = IpcMessage.delta(delta);
  const decoded = IpcMessage.decodeJson(message.encodeJson());

  assert.deepEqual(decoded, message);
  assert.equal(decoded.delta.epoch, 41);
});

test("payload serializes as byte array rather than base64", () => {
  const op = DeltaOp.cellSet(1, Uint8Array.of(10, 255, 0));

  assert.deepEqual(op.toWire(), {
    CellSet: { node: 1, payload: { Inline: [10, 255, 0] } },
  });
});

test("shared blob can be carried by slot value", () => {
  const blob = new ShmBlobRef({ offset: 40, len: 17, generation: 2, epoch: 9, checksum: 123 });
  const op = DeltaOp.slotValue(7, IpcValue.sharedBlob(blob));

  assert.ok(op instanceof DeltaOpSlotValue);
  assert.ok(op.payload instanceof IpcValueSharedBlob);
  assert.deepEqual(op.payload.blob, blob);
});

test("delta apply status requests resync on epoch gap", () => {
  const delta = new Delta({ baseEpoch: 12, epoch: 13 });

  assert.equal(delta.isNextAfter(12), true);
  assert.equal(delta.isNextAfter(10), false);

  const status = delta.applyStatus(10);
  assert.equal(status.kind, DeltaApplyStatusKind.ResyncRequired);
  assert.equal(status.isResyncRequired, true);
  assert.equal(status.lastEpoch, 10);
  assert.equal(status.baseEpoch, 12);
  assert.equal(status.epoch, 13);
});

test("snapshot permission filter omits unreadable nodes", () => {
  const permissions = new PeerPermissions();
  permissions.allowMany(1, OpKind.Read, [1, 2]);

  const snapshot = new Snapshot({
    epoch: 5,
    nodes: [
      NodeSnapshot.payload(1, "i32", Uint8Array.of(1)),
      NodeSnapshot.payload(2, "i32", Uint8Array.of(2)),
      NodeSnapshot.payload(3, "i32", Uint8Array.of(3)),
    ],
    edges: [new EdgeSnapshot(2, 1), new EdgeSnapshot(3, 1)],
    roots: [1, 2, 3],
  });

  const filtered = snapshot.filterReadable(permissions, 1);

  assert.deepEqual(filtered.nodes.map((node) => node.node), [1, 2]);
  assert.deepEqual(filtered.edges, [new EdgeSnapshot(2, 1)]);
  assert.deepEqual(filtered.roots, [1, 2]);
});

test("delta permission filter omits without redaction", () => {
  const permissions = new PeerPermissions();
  permissions.allowMany(1, OpKind.Read, [1, 2, 5]);

  const delta = Delta.next(8, [
    DeltaOp.cellSet(1, Uint8Array.of(1)),
    DeltaOp.slotValue(2, Uint8Array.of(2)),
    DeltaOp.invalidate(3),
    DeltaOp.nodeAdd(4, "u8", NodeState.payload(Uint8Array.of(4))),
    DeltaOp.nodeRemove(5),
    DeltaOp.edgeAdd(2, 1),
    DeltaOp.edgeRemove(3, 1),
  ]);

  const filtered = delta.filterReadable(permissions, 1);

  assert.deepEqual(
    filtered.ops.map((op) => op.constructor),
    [DeltaOpCellSet, DeltaOpSlotValue, DeltaOpNodeRemove, DeltaOpEdgeAdd],
  );
});

test("permissions gate operation kinds independently", () => {
  const permissions = new PeerPermissions();

  assert.equal(permissions.allow(1, RemoteOp.read(10)), true);
  assert.equal(permissions.allow(1, RemoteOp.read(10)), false);
  assert.equal(permissions.isAllowed(1, RemoteOp.read(10)), true);
  assert.equal(permissions.isAllowed(1, RemoteOp.write(10)), false);
});

test("conformance snapshot minimal", () => {
  const fixture = loadFixture("snapshot_minimal.json");
  const message = IpcMessage.fromWire(fixture.wire);
  const snapshot = message.snapshot;

  assert.equal(message.isSnapshot, true);
  assert.equal(snapshot.epoch, 1);
  assert.equal(snapshot.nodes.length, 1);
  assert.equal(snapshot.edges.length, 0);
  assert.equal(snapshot.roots.length, 1);
  assert.equal(snapshot.nodes[0].typeTag, "i32");
  assert.ok(snapshot.nodes[0].state instanceof NodeStatePayload);

  assertRoundTripJson(message, fixture);
});

test("conformance snapshot multi node", () => {
  const fixture = loadFixture("snapshot_multi_node.json");
  const message = IpcMessage.fromWire(fixture.wire);
  const snapshot = message.snapshot;

  assert.equal(snapshot.epoch, 7);
  assert.equal(snapshot.nodes.length, 3);
  assert.equal(snapshot.edges.length, 2);
  assert.equal(snapshot.roots.length, 2);

  const opaque = snapshot.nodes.find((node) => node.node === 3);
  assert.ok(opaque.state instanceof NodeStateOpaque);

  assertRoundTripJson(message, fixture);
});

test("conformance snapshot shared blob", () => {
  const fixture = loadFixture("snapshot_shared_blob.json");
  const message = IpcMessage.fromWire(fixture.wire);
  const snapshot = message.snapshot;
  const state = snapshot.nodes[0].state;

  assert.ok(state instanceof NodeStateSharedBlob);
  assert.equal(state.blob.offset, 0);
  assert.equal(state.blob.len, 16);
  assert.equal(state.blob.epoch, 9);

  assertRoundTripJson(message, fixture);
});

test("conformance delta sequential", () => {
  const fixture = loadFixture("delta_sequential.json");
  const message = IpcMessage.fromWire(fixture.wire);
  const delta = message.delta;

  assert.equal(message.isDelta, true);
  assert.equal(delta.baseEpoch, 40);
  assert.equal(delta.epoch, 41);
  assert.equal(delta.isNextAfter(40), true);
  assert.equal(delta.isNextAfter(39), false);
  assert.equal(delta.ops.length, 7);
  assert.deepEqual(new Set(delta.ops.map((op) => op.constructor)), new Set([
    DeltaOpCellSet,
    DeltaOpSlotValue,
    DeltaOpInvalidate,
    DeltaOpNodeAdd,
    DeltaOpNodeRemove,
    DeltaOpEdgeAdd,
    DeltaOpEdgeRemove,
  ]));

  assertRoundTripJson(message, fixture);
});

test("conformance delta non sequential", () => {
  const fixture = loadFixture("delta_non_sequential.json");
  const message = IpcMessage.fromWire(fixture.wire);
  const delta = message.delta;

  assert.equal(delta.baseEpoch, 12);
  assert.equal(delta.epoch, 13);
  assert.equal(delta.isNextAfter(12), true);
  assert.equal(delta.isNextAfter(10), false);

  const status = delta.applyStatus(10);
  assert.equal(status.kind, DeltaApplyStatusKind.ResyncRequired);
  assert.equal(status.lastEpoch, 10);
  assert.equal(status.baseEpoch, 12);
  assert.equal(status.epoch, 13);

  assertRoundTripJson(message, fixture);
});

test("conformance delta shared blob", () => {
  const fixture = loadFixture("delta_shared_blob.json");
  const message = IpcMessage.fromWire(fixture.wire);
  const delta = message.delta;

  assert.equal(delta.baseEpoch, 8);
  assert.equal(delta.epoch, 9);
  assert.equal(delta.ops.length, 1);

  const op = delta.ops[0];
  assert.ok(op instanceof DeltaOpSlotValue);
  assert.ok(op.payload instanceof IpcValueSharedBlob);
  assert.equal(op.payload.blob.offset, 40);
  assert.equal(op.payload.blob.len, 17);
  assert.equal(op.payload.blob.epoch, 9);

  assertRoundTripJson(message, fixture);
});

test("all fixtures round trip", () => {
  for (const name of [
    "snapshot_minimal.json",
    "snapshot_multi_node.json",
    "snapshot_shared_blob.json",
    "delta_sequential.json",
    "delta_non_sequential.json",
    "delta_shared_blob.json",
  ]) {
    const fixture = loadFixture(name);
    const message = IpcMessage.fromWire(fixture.wire);
    assertFixtureAssertions(message, fixture);
    assertRoundTripJson(message, fixture);
  }
});

test("assertFixtureAssertions catches wire/assertions drift", () => {
  const fixture = loadFixture("snapshot_minimal.json");
  const message = IpcMessage.fromWire(fixture.wire);

  // Correct assertions pass.
  assertFixtureAssertions(message, fixture);

  // A drifted metadata field must fail loudly instead of passing silently.
  const drifted = structuredClone(fixture);
  drifted.assertions.node_count = fixture.assertions.node_count + 999;
  assert.throws(
    () => assertFixtureAssertions(message, drifted),
    /snapshot assertion "node_count"/,
  );

  // An unknown assertion key must also fail (new metadata can't be ignored).
  const unknown = structuredClone(fixture);
  unknown.assertions.unexpected_field = true;
  assert.throws(
    () => assertFixtureAssertions(message, unknown),
    /unknown snapshot assertion key/,
  );
});
