import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  BlobBackendKind,
  CrdtOp,
  CrdtSync,
  Delta,
  DeltaOp,
  IpcMessage,
  IpcValue,
  IpcValueInline,
  IpcValueSharedBlob,
  NodeSnapshot,
  NodeState,
  ShmBlobRef,
  Snapshot,
  WireStamp,
} from "../src/index.js";
import {
  ArrowBackend,
  BlobRouter,
  DEFAULT_SPILL_THRESHOLD,
  InProcessBackend,
  ShmBlobArena,
  ShmUnavailableError,
  blobChecksum,
  createShmBackend,
  resolveValue,
  shmSupported,
  spillMessage,
  spillValue,
  validateBlobRef,
} from "../src/transport.js";

const here = dirname(fileURLToPath(import.meta.url));
const specFixtures = join(here, "..", "..", "lazily-spec", "conformance");
const localFixtures = join(here, "conformance");

function loadFixture(name) {
  const specPath = join(specFixtures, name);
  const path = existsSync(specPath) ? specPath : join(localFixtures, name);
  return JSON.parse(readFileSync(path, "utf8"));
}

const enc = new TextEncoder();
const bytes = (s) => enc.encode(s);

// ---------------------------------------------------------------------------
// ShmBlobRef backend discriminator.
// ---------------------------------------------------------------------------

test("ShmBlobRef defaults backend to shm and omits it on the wire", () => {
  const ref = new ShmBlobRef({
    offset: 0,
    len: 4,
    generation: 1,
    epoch: 9,
    checksum: 123,
  });
  assert.equal(ref.backend, "shm");
  assert.equal("backend" in ref.toWire(), false);
});

test("ShmBlobRef carries a non-default backend on the wire and back", () => {
  const ref = new ShmBlobRef({
    offset: 0,
    len: 4,
    generation: 1,
    epoch: 9,
    checksum: 123,
    backend: BlobBackendKind.Arrow,
  });
  assert.equal(ref.toWire().backend, "arrow");
  assert.equal(ShmBlobRef.fromWire(ref.toWire()).backend, "arrow");
});

test("ShmBlobRef.fromWire defaults an absent backend to shm", () => {
  const ref = ShmBlobRef.fromWire({
    offset: 0,
    len: 4,
    generation: 1,
    epoch: 9,
    checksum: 123,
  });
  assert.equal(ref.backend, "shm");
});

test("withBackend restamps the descriptor kind", () => {
  const ref = new ShmBlobRef({
    offset: 1,
    len: 2,
    generation: 3,
    epoch: 4,
    checksum: 5,
  });
  assert.equal(ref.withBackend(BlobBackendKind.InProcess).backend, "in_process");
});

test("ShmBlobRef rejects an unknown backend", () => {
  assert.throws(
    () =>
      new ShmBlobRef({
        offset: 0,
        len: 0,
        generation: 0,
        epoch: 0,
        checksum: 0,
        backend: "rdma",
      }),
    /unknown blob backend/,
  );
});

// ---------------------------------------------------------------------------
// ShmBlobArena.
// ---------------------------------------------------------------------------

test("arena write/readView round-trips zero-copy (aliases storage)", () => {
  const arena = new ShmBlobArena();
  const payload = bytes("lazily arena payload");
  const ref = arena.write(payload);
  const view = arena.readView(ref);
  assert.deepEqual([...view], [...payload]);
  assert.equal(ref.checksum, blobChecksum(payload));
  // read() returns a defensive copy, readView() aliases.
  assert.notEqual(arena.read(ref), arena.readView(ref));
});

test("arena rejects a corrupt-checksum descriptor", () => {
  const arena = new ShmBlobArena();
  const ref = arena.write(bytes("payload"));
  const corrupt = new ShmBlobRef({ ...refFields(ref), checksum: ref.checksum + 1 });
  assert.equal(arena.readView(corrupt), null);
});

test("arena rejects a stale-generation descriptor (ABA)", () => {
  const arena = new ShmBlobArena();
  const a = arena.write(bytes("first"));
  const stale = new ShmBlobRef({ ...refFields(a), generation: a.generation + 1 });
  assert.equal(arena.readView(stale), null);
});

test("advanceEpoch invalidates prior descriptors", () => {
  const arena = new ShmBlobArena();
  const ref = arena.write(bytes("payload"));
  assert.ok(arena.readView(ref));
  arena.advanceEpoch();
  assert.equal(arena.readView(ref), null);
  assert.equal(arena.epoch, 1);
});

test("free reclaims a slot and makes its descriptor stale", () => {
  const arena = new ShmBlobArena();
  const ref = arena.write(bytes("payload"));
  assert.equal(arena.length, 1);
  assert.equal(arena.free(ref), true);
  assert.equal(arena.readView(ref), null);
  assert.equal(arena.length, 0);
});

test("retain adds a reference so one free does not reclaim", () => {
  const arena = new ShmBlobArena();
  const ref = arena.write(bytes("payload"));
  assert.equal(arena.retain(ref), true);
  arena.free(ref);
  assert.ok(arena.readView(ref)); // still one reference held
  arena.free(ref);
  assert.equal(arena.readView(ref), null);
});

test("validateBlobRef enforces bounds and maxLen", () => {
  const ref = new ShmBlobArena().write(bytes("payload"));
  assert.equal(validateBlobRef(ref), true);
  assert.equal(validateBlobRef(ref, 3), false);
});

// ---------------------------------------------------------------------------
// Backends + router.
// ---------------------------------------------------------------------------

test("InProcessBackend / ArrowBackend stamp their kind on descriptors", () => {
  const ip = new InProcessBackend();
  const arrow = new ArrowBackend();
  assert.equal(ip.write(bytes("x")).backend, "in_process");
  assert.equal(arrow.write(bytes("x")).backend, "arrow");
});

test("BlobRouter routes each descriptor to its own backend", () => {
  const ip = new InProcessBackend();
  const arrow = new ArrowBackend();
  const router = new BlobRouter().register(ip).register(arrow);

  const ipRef = ip.write(bytes("in-process bytes"));
  const arrowRef = arrow.write(bytes("arrow bytes"));

  assert.deepEqual([...router.readView(ipRef)], [...bytes("in-process bytes")]);
  assert.deepEqual([...router.readView(arrowRef)], [...bytes("arrow bytes")]);
});

test("BlobRouter never resolves a descriptor of the wrong kind", () => {
  const ip = new InProcessBackend();
  const router = new BlobRouter().register(ip);
  const ipRef = ip.write(bytes("payload"));
  // Same bytes, wrong discriminator: no arrow backend registered → null, and
  // even the shm re-tag routes away from the in_process backend.
  const asArrow = ipRef.withBackend(BlobBackendKind.Arrow);
  assert.equal(router.readView(asArrow), null);
  const asShm = ipRef.withBackend(BlobBackendKind.Shm);
  assert.equal(router.readView(asShm), null);
});

test("BlobRouter.resolve handles inline and shared values", () => {
  const ip = new InProcessBackend();
  const router = new BlobRouter().register(ip);
  assert.deepEqual(
    [...router.resolve(IpcValue.inline(bytes("inline")))],
    [...bytes("inline")],
  );
  const ref = ip.write(bytes("shared"));
  assert.deepEqual(
    [...router.resolve(IpcValue.sharedBlob(ref))],
    [...bytes("shared")],
  );
});

// ---------------------------------------------------------------------------
// Spill / resolve policy.
// ---------------------------------------------------------------------------

test("spillValue spills at/above threshold, leaves small values inline", () => {
  const ip = new InProcessBackend();
  const big = spillValue(IpcValue.inline(bytes("x".repeat(600))), ip, 512);
  assert.ok(big.value instanceof IpcValueSharedBlob);
  assert.equal(big.spilled, 600);

  const small = spillValue(IpcValue.inline(bytes("tiny")), ip, 512);
  assert.ok(small.value instanceof IpcValueInline);
  assert.equal(small.spilled, 0);
});

test("resolveValue reads back a spilled value zero-copy", () => {
  const ip = new InProcessBackend();
  const original = bytes("y".repeat(700));
  const { value } = spillValue(IpcValue.inline(original), ip, 512);
  assert.deepEqual([...resolveValue(value, ip)], [...original]);
  assert.deepEqual([...resolveValue(IpcValue.inline(bytes("z")), ip)], [
    ...bytes("z"),
  ]);
});

test("spillMessage rewrites oversized Delta payloads to descriptors", () => {
  const ip = new InProcessBackend();
  const delta = new Delta({
    baseEpoch: 0,
    epoch: 1,
    ops: [
      DeltaOp.slotValue(7, IpcValue.inline(bytes("a".repeat(1000)))),
      DeltaOp.cellSet(8, IpcValue.inline(bytes("small"))),
    ],
  });
  const { message, spilledBytes } = spillMessage(
    IpcMessage.delta(delta),
    ip,
    DEFAULT_SPILL_THRESHOLD,
  );
  assert.equal(spilledBytes, 1000);
  const wire = message.toWire().Delta;
  assert.ok("SharedBlob" in wire.ops[0].SlotValue.payload);
  assert.ok("Inline" in wire.ops[1].CellSet.payload);
  // The spilled descriptor resolves back to the original bytes.
  const ref = ShmBlobRef.fromWire(wire.ops[0].SlotValue.payload.SharedBlob);
  assert.deepEqual([...ip.readView(ref)], [...bytes("a".repeat(1000))]);
});

test("spillMessage rewrites oversized Snapshot node states", () => {
  const ip = new InProcessBackend();
  const snap = new Snapshot({
    epoch: 1,
    nodes: [
      new NodeSnapshot(1, "text/plain", NodeState.payload(bytes("b".repeat(900)))),
      new NodeSnapshot(2, "text/plain", NodeState.payload(bytes("hi"))),
    ],
    roots: [1],
  });
  const { message, spilledBytes } = spillMessage(IpcMessage.snapshot(snap), ip, 512);
  assert.equal(spilledBytes, 900);
  const nodes = message.toWire().Snapshot.nodes;
  assert.ok("SharedBlob" in nodes[0].state);
  assert.ok("Payload" in nodes[1].state);
});

test("spillMessage rewrites oversized CrdtSync op states", () => {
  const ip = new InProcessBackend();
  const stamp = new WireStamp({ wallTime: 1, logical: 0, peer: 3 });
  const sync = new CrdtSync({
    ops: [new CrdtOp(5, stamp, IpcValue.inline(bytes("c".repeat(800))))],
  });
  const { message, spilledBytes } = spillMessage(IpcMessage.crdtSync(sync), ip, 512);
  assert.equal(spilledBytes, 800);
  assert.ok("SharedBlob" in message.toWire().CrdtSync.ops[0].state);
});

test("spillMessage leaves an already-spilled site untouched", () => {
  const ip = new InProcessBackend();
  const ref = ip.write(bytes("d".repeat(900)));
  const delta = new Delta({
    baseEpoch: 0,
    epoch: 1,
    ops: [DeltaOp.slotValue(7, IpcValue.sharedBlob(ref))],
  });
  const { spilledBytes } = spillMessage(IpcMessage.delta(delta), ip, 512);
  assert.equal(spilledBytes, 0);
});

// ---------------------------------------------------------------------------
// Conformance — the Arrow zero-copy fixture (#lzzcpy).
// ---------------------------------------------------------------------------

test("conformance delta_zero_copy_arrow: arrow-backed SharedBlob descriptor", () => {
  const fixture = loadFixture("delta_zero_copy_arrow.json");
  assert.equal(fixture.protocol_version, 1);
  const message = IpcMessage.fromWire(fixture.wire);
  const op = message.delta.ops[0];

  assert.ok(op.payload instanceof IpcValueSharedBlob);
  assert.equal(op.payload.blob.backend, fixture.assertions.first_op_payload_backend);
  assert.equal(op.payload.blob.backend, "arrow");
  assert.equal(op.payload.blob.offset, 40);
  assert.equal(op.payload.blob.len, 17);
  // Exact wire round-trip (the optional `backend` discriminator is preserved).
  assert.deepEqual(message.toWire(), fixture.wire);
});

// ---------------------------------------------------------------------------
// Cross-process `shm` backend (Node/Bun/Deno FFI) — isomorphic gate.
// ---------------------------------------------------------------------------

test("shmSupported reports a boolean and ShmUnavailableError is exported", () => {
  assert.equal(typeof shmSupported(), "boolean");
  assert.ok(ShmUnavailableError.prototype instanceof Error);
});

test(
  "shm backend writes and resolves zero-copy (FFI runtime)",
  { skip: shmSupported() ? false : "no FFI runtime" },
  async () => {
    const shm = await createShmBackend(`lazily-test-${process.pid}`, {
      capacity: 1 << 16,
    });
    try {
      const payload = bytes("shm zero-copy payload ".repeat(20));
      const ref = shm.write(payload);
      assert.equal(ref.backend, "shm");
      assert.deepEqual([...shm.readView(ref)], [...payload]);
      // Backend default omitted on the wire (backward compatible).
      assert.equal("backend" in IpcValue.sharedBlob(ref).toWire().SharedBlob, false);
      // A corrupt descriptor does not resolve.
      const corrupt = new ShmBlobRef({ ...refFields(ref), checksum: ref.checksum + 1 });
      assert.equal(shm.readView(corrupt), null);
    } finally {
      shm.close();
    }
  },
);

function refFields(ref) {
  return {
    offset: ref.offset,
    len: ref.len,
    generation: ref.generation,
    epoch: ref.epoch,
    checksum: ref.checksum,
    backend: ref.backend,
  };
}
