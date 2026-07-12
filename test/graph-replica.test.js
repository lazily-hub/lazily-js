import assert from "node:assert/strict";
import test from "node:test";
import { GraphReplica } from "../src/graph-replica.js";
import {
  Snapshot,
  NodeSnapshot,
  EdgeSnapshot,
  NodeStatePayload,
  NodeStateOpaque,
  Delta,
  DeltaOpCellSet,
  DeltaOpNodeAdd,
  DeltaOpNodeRemove,
  DeltaOpEdgeRemove,
  IpcValueInline,
} from "../src/index.js";

const bytes = (s) => [...Buffer.from(s, "utf8")];
const str = (b) => Buffer.from(b).toString("utf8");

test("GraphReplica applies native snapshot then delta", () => {
  const replica = new GraphReplica();
  assert.equal(replica.isInitialized, false);

  replica.applySnapshot(
    new Snapshot({
      epoch: 3,
      nodes: [
        new NodeSnapshot(1, "doc.route", new NodeStatePayload(bytes("hello"))),
        new NodeSnapshot(2, "doc.proof", new NodeStateOpaque()),
      ],
      edges: [new EdgeSnapshot(2, 1)],
      roots: [1],
    }),
  );

  assert.equal(replica.isInitialized, true);
  assert.equal(replica.epoch, 3);
  assert.equal(replica.nodeCount, 2);
  assert.equal(str(replica.node(1).payload), "hello");
  assert.equal(replica.node(2).payload, null); // Opaque carries no inline payload

  replica.applyDelta(
    new Delta({
      baseEpoch: 3,
      epoch: 5,
      ops: [
        new DeltaOpCellSet(1, new IpcValueInline(bytes("world"))),
        new DeltaOpNodeAdd(3, "doc.transport", new NodeStatePayload(bytes("x"))),
        new DeltaOpNodeRemove(2),
        new DeltaOpEdgeRemove(2, 1),
      ],
    }),
  );

  assert.equal(replica.epoch, 5);
  assert.equal(str(replica.node(1).payload), "world");
  assert.equal(replica.node(2), null);
  assert.equal(replica.nodeCount, 2);
  assert.equal(replica.nodesOfType("doc.transport").length, 1);
  assert.deepEqual(replica.allEdges(), []);
});

test("GraphReplica re-emitted delta is idempotent", () => {
  const replica = new GraphReplica();
  replica.applySnapshot(new Snapshot({ epoch: 1, nodes: [new NodeSnapshot(1, "t", new NodeStatePayload(bytes("a")))] }));
  const delta = new Delta({ baseEpoch: 1, epoch: 2, ops: [new DeltaOpCellSet(1, new IpcValueInline(bytes("b")))] });
  replica.applyDelta(delta);
  const after = str(replica.node(1).payload);
  replica.applyDelta(delta);
  assert.equal(str(replica.node(1).payload), after);
  assert.equal(replica.epoch, 2);
});
