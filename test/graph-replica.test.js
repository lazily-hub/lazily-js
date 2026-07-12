import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "..", "lazily-spec", "conformance", "agent-doc");
const fixturesPresent = existsSync(join(fixtureDir, "snapshot_agent_doc_state.json"));
const loadFixture = (name) => JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
const phaseOf = (replica, id) => JSON.parse(str(replica.node(id).payload)).phase;

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

test("GraphReplica folds the canonical native agent-doc fixtures", { skip: !fixturesPresent }, () => {
  // Pin the js GraphReplica to the SAME lazily-spec native fixtures the kt replica uses
  // (`conformance/agent-doc/{snapshot,delta}_agent_doc_state.json`) — cross-language drift catch.
  const snapshot = Snapshot.fromWire(loadFixture("snapshot_agent_doc_state.json").wire.Snapshot);
  const delta = Delta.fromWire(loadFixture("delta_agent_doc_state.json").wire.Delta);

  const replica = new GraphReplica();
  replica.applySnapshot(snapshot);
  assert.equal(replica.nodeCount, 3);
  assert.equal(replica.epoch, 3);

  replica.applyDelta(delta);
  assert.equal(replica.nodeCount, 4);
  assert.equal(replica.epoch, 6);
  assert.equal(replica.node(102).typeTag, "agent_doc.closeout.cycle");
  assert.equal(phaseOf(replica, 102), "committed");
  assert.equal(replica.node(103).typeTag, "agent_doc.queue.head");
  assert.equal(phaseOf(replica, 103), "completed");
  assert.equal(replica.node(104).typeTag, "agent_doc.transport.patch");
  assert.equal(phaseOf(replica, 104), "applied");
});
