import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CrdtOp,
  CrdtSync,
  CausalReceipt,
  CausalReceipts,
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
  IpcValueInline,
  IpcValueSharedBlob,
  NodeSnapshot,
  NodeState,
  NodeStateOpaque,
  NodeStatePayload,
  NodeStateSharedBlob,
  OpKind,
  PeerPermissions,
  ReceiptApplyStatusKind,
  ReceiptMessage,
  ReceiptOutcome,
  ReceiptProjection,
  RemoteOp,
  ShmBlobRef,
  Snapshot,
  WireStamp,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const localFixtures = join(here, "conformance");
const specRoot = join(here, "..", "..", "lazily-spec");
const specFixtures = join(specRoot, "conformance");

function loadFixture(name) {
  const specPath = join(specFixtures, name);
  const path = existsSync(specPath) ? specPath : join(localFixtures, name);
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(fixture.protocol_version, 1);
  return fixture;
}

// agent-doc-state type_tag vocabulary (schemas/agent-doc-state.json § TypeTag).
// Lazy so non-agent-doc test runs never touch the schema file.
let agentDocTypeTags = null;
function loadAgentDocVocabulary() {
  if (agentDocTypeTags !== null) {
    return agentDocTypeTags;
  }
  const path = join(specRoot, "schemas", "agent-doc-state.json");
  const schema = JSON.parse(readFileSync(path, "utf8"));
  agentDocTypeTags = new Set(schema?.$defs?.TypeTag?.enum ?? []);
  return agentDocTypeTags;
}

function decodePayloadJson(bytes) {
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));
}

// Inline JSON carried by a snapshot node state (null for SharedBlob / Opaque).
function nodePayloadJson(node) {
  return node.state instanceof NodeStatePayload
    ? decodePayloadJson(node.state.bytes)
    : null;
}

// Inline JSON carried by a delta CellSet/SlotValue op payload (null for SharedBlob).
function valueOpPayloadJson(op) {
  return op.payload instanceof IpcValueInline
    ? decodePayloadJson(op.payload.bytes)
    : null;
}

// Find the `.phase` of the decoded payload object that carries `markerField`
// (e.g. "cycle_id" -> CloseoutProjection, "backlog_id" -> QueueHeadProjection),
// so phase assertions need no out-of-band node-id mapping. Requires `phase` to
// be present too, so a struct that merely references the marker (e.g. the
// baseline projection carries cycle_id but has no phase) is not a false hit.
function phaseByMarker(objects, markerField) {
  const found = objects.find(
    (obj) =>
      obj && typeof obj === "object" && markerField in obj && "phase" in obj,
  );
  return found?.phase;
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
        case "type_tags":
          actual = snap.nodes.map((n) => n.typeTag);
          break;
        case "cycle_phase": {
          const objs = snap.nodes.map(nodePayloadJson);
          actual = phaseByMarker(objs, "cycle_id");
          break;
        }
        case "queue_head_phase": {
          const objs = snap.nodes.map(nodePayloadJson);
          actual = phaseByMarker(objs, "backlog_id");
          break;
        }
        case "all_type_tags_in_vocabulary": {
          const vocab = loadAgentDocVocabulary();
          actual = snap.nodes.map((n) => n.typeTag).every((t) => vocab.has(t));
          break;
        }
        default: throw new Error(`unknown snapshot assertion key: ${key}`);
      }
      assert.deepEqual(actual, expected, `snapshot assertion "${key}"`);
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
        case "added_type_tags":
          actual = delta.ops
            .filter((op) => op instanceof DeltaOpNodeAdd)
            .map((op) => op.typeTag);
          break;
        case "cycle_phase_after": {
          const objs = delta.ops
            .filter((op) => op instanceof DeltaOpCellSet || op instanceof DeltaOpSlotValue)
            .map(valueOpPayloadJson);
          actual = phaseByMarker(objs, "cycle_id");
          break;
        }
        case "queue_head_phase_after": {
          const objs = delta.ops
            .filter((op) => op instanceof DeltaOpCellSet || op instanceof DeltaOpSlotValue)
            .map(valueOpPayloadJson);
          actual = phaseByMarker(objs, "backlog_id");
          break;
        }
        case "all_type_tags_in_vocabulary": {
          const vocab = loadAgentDocVocabulary();
          actual = delta.ops
            .filter((op) => op instanceof DeltaOpNodeAdd)
            .map((op) => op.typeTag)
            .every((t) => vocab.has(t));
          break;
        }
        default: throw new Error(`unknown delta assertion key: ${key}`);
      }
      assert.deepEqual(actual, expected, `delta assertion "${key}"`);
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

test("NodeSnapshot omits key when absent and emits it when set", () => {
  assert.deepEqual(
    NodeSnapshot.payload(1, "i32", Uint8Array.of(1)).toWire(),
    { node: 1, type_tag: "i32", state: { Payload: [1] } },
  );

  const keyed = NodeSnapshot.payload(1, "i32", Uint8Array.of(1), "scores/alice");
  assert.equal(keyed.key, "scores/alice");
  assert.deepEqual(keyed.toWire(), {
    node: 1,
    type_tag: "i32",
    state: { Payload: [1] },
    key: "scores/alice",
  });
});

test("NodeSnapshot.fromWire treats a missing key as null and reads a present key", () => {
  assert.equal(
    NodeSnapshot.fromWire({ node: 1, type_tag: "i32", state: { Payload: [1] } }).key,
    null,
  );
  const keyed = NodeSnapshot.fromWire({
    node: 2,
    type_tag: "i32",
    state: { Payload: [2] },
    key: "outer/k1/inner/k2",
  });
  assert.equal(keyed.key, "outer/k1/inner/k2");
});

test("NodeAdd delta op carries an optional key through wire round-trip", () => {
  const op = DeltaOp.nodeAdd(4, "u64", NodeState.payload(Uint8Array.of(64)), "cell/family/x");
  assert.equal(op.key, "cell/family/x");
  assert.deepEqual(op.toWire(), {
    NodeAdd: {
      node: 4,
      type_tag: "u64",
      state: { Payload: [64] },
      key: "cell/family/x",
    },
  });

  const message = IpcMessage.delta(Delta.next(1, [op]));
  const decoded = IpcMessage.decodeJson(message.encodeJson());
  assert.deepEqual(decoded.delta.ops[0], op);
  assert.equal(decoded.delta.ops[0].key, "cell/family/x");

  assert.equal(DeltaOp.fromWire(op.toWire()).key, "cell/family/x");
});

test("NodeKey validation rejects malformed paths", () => {
  const rejection = (matcher, ...args) =>
    assert.throws(() => NodeSnapshot.payload(1, "t", Uint8Array.of(0), ...args), matcher);

  // empty path
  rejection(TypeError, "");
  // empty segments: leading, trailing, and double '/'
  rejection(TypeError, "/leading");
  rejection(TypeError, "trailing/");
  rejection(TypeError, "double//slash");
  // non-string
  rejection(TypeError, 7);
  // > 32 segments
  rejection(TypeError, Array.from({ length: 33 }, (_, i) => `s${i}`).join("/"));
});

test("NodeKey accepts the boundary sizes (31 segments, 1024 bytes)", () => {
  const thirtyOne = Array.from({ length: 31 }, (_, i) => `s${i}`).join("/");
  const snap = NodeSnapshot.payload(1, "t", Uint8Array.of(0), thirtyOne);
  assert.equal(snap.key, thirtyOne);
});

// Canonical CrdtSync JSON captured from lazily-rs's
// `crdt_sync_round_trips_through_serde` (serde_json::to_string). Pinning it keeps
// lazily-js byte-compatible with the Rust serde shape, including the subtlety
// that a keyless CrdtOp serializes `key: null` (CrdtOp uses derived serde with
// no skip_serializing_if, unlike NodeSnapshot/NodeAdd which omit the field).
const CRDT_CANONICAL_JSON =
  '{"CrdtSync":{"frontier":[[1,{"wall_time":200,"logical":0,"peer":1}],' +
  '[2,{"wall_time":180,"logical":3,"peer":2}]],' +
  '"ops":[{"node":1,"key":null,"stamp":{"wall_time":200,"logical":0,"peer":1},"state":{"Inline":[10,20]}},' +
  '{"node":2,"key":"scores/alice","stamp":{"wall_time":180,"logical":3,"peer":2},"state":{"Inline":[30]}}]}}';

const CRDT_CANONICAL_WIRE = {
  CrdtSync: {
    frontier: [
      [1, { wall_time: 200, logical: 0, peer: 1 }],
      [2, { wall_time: 180, logical: 3, peer: 2 }],
    ],
    ops: [
      {
        node: 1,
        key: null,
        stamp: { wall_time: 200, logical: 0, peer: 1 },
        state: { Inline: [10, 20] },
      },
      {
        node: 2,
        key: "scores/alice",
        stamp: { wall_time: 180, logical: 3, peer: 2 },
        state: { Inline: [30] },
      },
    ],
  },
};

function canonicalCrdtSync() {
  return new CrdtSync({
    frontier: [
      { peer: 1, stamp: new WireStamp({ wallTime: 200, logical: 0, peer: 1 }) },
      { peer: 2, stamp: new WireStamp({ wallTime: 180, logical: 3, peer: 2 }) },
    ],
    ops: [
      new CrdtOp(
        1,
        new WireStamp({ wallTime: 200, logical: 0, peer: 1 }),
        Uint8Array.of(10, 20),
      ),
      CrdtOp.keyed(
        2,
        "scores/alice",
        new WireStamp({ wallTime: 180, logical: 3, peer: 2 }),
        Uint8Array.of(30),
      ),
    ],
  });
}

test("CrdtSync round-trips the canonical lazily-rs serde JSON byte-for-byte", () => {
  const message = IpcMessage.crdtSync(canonicalCrdtSync());

  assert.deepEqual(message.toWire(), CRDT_CANONICAL_WIRE);
  assert.deepEqual(
    message.encodeJson(),
    new TextEncoder().encode(CRDT_CANONICAL_JSON),
  );

  const decoded = IpcMessage.decodeJson(message.encodeJson());
  assert.equal(decoded.isCrdtSync, true);
  assert.deepEqual(decoded, message);
});

test("a keyless CrdtOp serializes key: null (derived serde, not omitted)", () => {
  const op = new CrdtOp(
    9,
    new WireStamp({ wallTime: 5, logical: 1, peer: 7 }),
    Uint8Array.of(1),
  );
  assert.equal(op.key, null);
  assert.deepEqual(op.toWire(), {
    node: 9,
    key: null,
    stamp: { wall_time: 5, logical: 1, peer: 7 },
    state: { Inline: [1] },
  });
});

test("CrdtSync.filterReadable omits non-readable ops but keeps the frontier", () => {
  const permissions = new PeerPermissions();
  permissions.allowMany(1, OpKind.Read, [1]);

  const filtered = canonicalCrdtSync().filterReadable(permissions, 1);

  assert.deepEqual(
    filtered.ops.map((op) => op.node),
    [1],
  );
  // frontier is metadata (peers + stamps, no node content), retained in full.
  assert.equal(filtered.frontier.length, 2);
  assert.deepEqual(
    filtered.frontier.map((entry) => entry.peer),
    [1, 2],
  );
});

test("receipt outcomes distinguish progress from terminal authority", () => {
  assert.equal(CausalReceipt.observed("r1", "patch-123", "editor", 7).isTerminal, false);
  assert.equal(CausalReceipt.accepted("r2", "patch-123", "editor", 7).isTerminal, false);
  assert.equal(CausalReceipt.applied("r3", "patch-123", "editor", 7).isTerminal, true);
  assert.equal(CausalReceipt.rejected("r4", "patch-123", "editor", 7).isTerminal, true);
});

test("ReceiptMessage round-trips the externally-tagged CausalReceipts wire shape", () => {
  const message = ReceiptMessage.causalReceipts(
    new CausalReceipts([
      CausalReceipt.observed("receipt-observed", "patch-123", "editor", 7),
      CausalReceipt.applied("receipt-applied", "patch-123", "editor", 7, "sha256:abc"),
    ]),
  );

  assert.deepEqual(message.toWire(), {
    CausalReceipts: {
      receipts: [
        {
          receipt_id: "receipt-observed",
          causation_id: "patch-123",
          observer: "editor",
          generation: 7,
          outcome: "observed",
          reason: null,
          payload_hash: null,
        },
        {
          receipt_id: "receipt-applied",
          causation_id: "patch-123",
          observer: "editor",
          generation: 7,
          outcome: "applied",
          reason: null,
          payload_hash: "sha256:abc",
        },
      ],
    },
  });
  assert.deepEqual(ReceiptMessage.decodeJson(message.encodeJson()), message);
});

test("ReceiptProjection records terminal outcome and ignores stale generation", () => {
  const projection = new ReceiptProjection();

  assert.deepEqual(
    projection.observe(7, CausalReceipt.observed("receipt-observed", "patch-123", "editor", 7)),
    { kind: ReceiptApplyStatusKind.Recorded },
  );
  assert.deepEqual(
    projection.observe(7, CausalReceipt.rejected("receipt-stale", "patch-123", "editor", 6, "stale generation")),
    { kind: ReceiptApplyStatusKind.StaleGeneration, expected: 7, actual: 6 },
  );
  assert.deepEqual(
    projection.observe(7, CausalReceipt.applied("receipt-applied", "patch-123", "editor", 7)),
    { kind: ReceiptApplyStatusKind.Recorded },
  );

  assert.equal(projection.terminalFor("patch-123").outcome, ReceiptOutcome.Applied);
  assert.deepEqual(projection.staleReceiptIds(), ["receipt-stale"]);
  assert.equal(projection.containsReceipt("receipt-stale"), true);
});

test("ReceiptProjection treats duplicate and conflicting terminals as no-ops", () => {
  const projection = new ReceiptProjection();
  const applied = CausalReceipt.applied("receipt-applied", "patch-123", "editor", 7);

  assert.deepEqual(projection.observe(7, applied), { kind: ReceiptApplyStatusKind.Recorded });
  assert.deepEqual(projection.observe(7, applied), { kind: ReceiptApplyStatusKind.Duplicate });
  assert.deepEqual(
    projection.observe(7, CausalReceipt.rejected("receipt-rejected", "patch-123", "editor", 7)),
    {
      kind: ReceiptApplyStatusKind.TerminalConflict,
      causationId: "patch-123",
      existing: ReceiptOutcome.Applied,
      incoming: ReceiptOutcome.Rejected,
    },
  );
  assert.equal(projection.containsReceipt("receipt-rejected"), false);
});

test("conformance causal receipts fixture replays", () => {
  const fixture = loadFixture("receipts/causal_receipts.json");
  const message = ReceiptMessage.fromWire(fixture.wire);
  const receipts = message.causalReceipts.receipts;
  const projection = new ReceiptProjection();
  const currentGeneration = fixture.assertions.current_generation;

  for (const receipt of receipts) {
    projection.observe(currentGeneration, receipt);
  }

  assert.equal(receipts.length, fixture.assertions.receipt_count);
  assert.equal(
    projection.terminalFor(fixture.assertions.causation_id).outcome,
    fixture.assertions.terminal_outcome,
  );
  assert.deepEqual(projection.staleReceiptIds(), fixture.assertions.stale_receipt_ids);
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

test("conformance agent-doc snapshot", () => {
  const fixture = loadFixture("agent-doc/snapshot_agent_doc_state.json");
  const message = IpcMessage.fromWire(fixture.wire);
  const snap = message.snapshot;

  assert.equal(snap.epoch, 3);
  assert.equal(snap.nodes.length, 3);
  assert.equal(snap.edges.length, 2);
  assert.equal(snap.roots.length, 1);
  assert.deepEqual(
    snap.nodes.map((n) => n.typeTag),
    [
      "agent_doc.document.baseline",
      "agent_doc.closeout.cycle",
      "agent_doc.queue.head",
    ],
  );
  // every node carries its serde_json(struct) payload inline as bytes
  assert.ok(snap.nodes.every((n) => n.state instanceof NodeStatePayload));

  assertRoundTripJson(message, fixture);
});

test("conformance agent-doc delta", () => {
  const fixture = loadFixture("agent-doc/delta_agent_doc_state.json");
  const message = IpcMessage.fromWire(fixture.wire);
  const delta = message.delta;

  assert.equal(delta.baseEpoch, 3);
  assert.equal(delta.epoch, 6);
  assert.equal(delta.ops.length, 4);
  assert.deepEqual(
    delta.ops
      .filter((op) => op instanceof DeltaOpNodeAdd)
      .map((op) => op.typeTag),
    ["agent_doc.transport.patch"],
  );
  assert.deepEqual(
    delta.ops.map((op) => op.constructor),
    [DeltaOpCellSet, DeltaOpCellSet, DeltaOpNodeAdd, DeltaOpEdgeAdd],
  );

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
    "agent-doc/snapshot_agent_doc_state.json",
    "agent-doc/delta_agent_doc_state.json",
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
