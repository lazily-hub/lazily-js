import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  CrdtOp,
  CrdtSync,
  Delta,
  DeltaOp,
  EdgeSnapshot,
  IpcMessage,
  NodeSnapshot,
  NodeState,
  ShmBlobRef,
  Snapshot,
  WireStamp,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, "..", "..", "lazily-spec", "schemas");

function loadSchema(name) {
  return JSON.parse(readFileSync(join(schemaDir, `${name}.json`), "utf8"));
}

// Register every lazily-spec schema by its $id so absolute $refs (e.g. the
// defs.json primitives) resolve without network access.
const ajv = new Ajv2020({ strict: false });
for (const name of [
  "defs",
  "snapshot",
  "delta",
  "distributed",
  "ffi",
  "signaling",
  "statechart",
]) {
  ajv.addSchema(loadSchema(name));
}

function validator(name) {
  const fn = ajv.getSchema(`https://lazily.dev/schemas/${name}.json`);
  assert.ok(fn, `schema ${name} not registered`);
  return fn;
}

function errorsText(fn, data) {
  return (
    fn.errors
      ?.map((e) => `${e.instancePath || "/"}: ${e.message}`)
      .join("\n") ?? ""
  );
}

test("lazily-js Snapshot wire validates against schemas/snapshot.json", () => {
  const message = IpcMessage.snapshot(
    new Snapshot({
      epoch: 7,
      nodes: [
        NodeSnapshot.payload(1, "i32", Uint8Array.of(1, 2, 3), "scores/alice"),
        NodeSnapshot.opaque(2, "opaque-tag"),
        NodeSnapshot.sharedBlob(
          3,
          "blob",
          new ShmBlobRef({
            offset: 0,
            len: 16,
            generation: 1,
            epoch: 7,
            checksum: 9,
          }),
        ),
      ],
      edges: [new EdgeSnapshot(2, 1)],
      roots: [1],
    }),
  );
  const wire = message.toWire();
  const fn = validator("snapshot");
  assert.ok(fn(wire), errorsText(fn, wire));
});

test("lazily-js Delta wire (all 7 ops + NodeAdd key) validates against schemas/delta.json", () => {
  const message = IpcMessage.delta(
    new Delta({
      baseEpoch: 40,
      epoch: 41,
      ops: [
        DeltaOp.cellSet(1, Uint8Array.of(10)),
        DeltaOp.slotValue(2, Uint8Array.of(20)),
        DeltaOp.invalidate(3),
        DeltaOp.nodeAdd(4, "u64", NodeState.payload(Uint8Array.of(64)), "outer/k1/inner/k2"),
        DeltaOp.nodeRemove(5),
        DeltaOp.edgeAdd(2, 1),
        DeltaOp.edgeRemove(3, 1),
      ],
    }),
  );
  const fn = validator("delta");
  assert.ok(fn(message.toWire()), errorsText(fn, message.toWire()));
});

test("lazily-js CrdtSync wire (keyed + keyless ops) validates against schemas/distributed.json", () => {
  const message = IpcMessage.crdtSync(
    new CrdtSync({
      frontier: [
        { peer: 1, stamp: new WireStamp({ wallTime: 200, logical: 0, peer: 1 }) },
      ],
      ops: [
        new CrdtOp(1, new WireStamp({ wallTime: 200, logical: 0, peer: 1 }), Uint8Array.of(10, 20)),
        CrdtOp.keyed(2, "scores/alice", new WireStamp({ wallTime: 180, logical: 3, peer: 2 }), Uint8Array.of(30)),
      ],
    }),
  );
  const fn = validator("distributed");
  assert.ok(fn(message.toWire()), errorsText(fn, message.toWire()));
});

// Drift regressions: the stale (slot_id / base64 / type-discriminant) form the
// schemas were realigned away from MUST still be rejected (parity with the
// spec's own tests/test_schema_conformance.py).

test("schema rejects the stale slot_id snapshot form", () => {
  const stale = {
    Snapshot: {
      epoch: 1,
      nodes: [{ node: 1, type_tag: "i32", state: { Payload: [1] }, slot_id: 1 }],
      edges: [],
      roots: [1],
    },
  };
  assert.ok(validator("snapshot")(stale) === false, "slot_id must be rejected");
});

test("schema rejects the stale base64 payload form", () => {
  const stale = {
    Snapshot: {
      epoch: 1,
      nodes: [{ node: 1, type_tag: "i32", state: "AAAAAQID" }],
      edges: [],
      roots: [1],
    },
  };
  assert.ok(validator("snapshot")(stale) === false, "base64 state must be rejected");
});

test("schema rejects the stale type-discriminant envelope", () => {
  const stale = { type: "snapshot", epoch: 1, nodes: [], edges: [], roots: [] };
  assert.ok(validator("snapshot")(stale) === false, "type-discriminant must be rejected");
});
