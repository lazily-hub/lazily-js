// `#lzdeltaqueueops`: QueuePush / QueuePop / QueueClose are ordinary DeltaOp
// variants of the Delta IPC frame (protocol.md § QueueCell op-log delta form,
// `#queue-oplog`; schemas/delta.json `DeltaOp` oneOf).
import assert from "node:assert/strict";
import test from "node:test";

import { GraphView } from "../src/graph-view.js";
import {
  Delta,
  DeltaOp,
  DeltaOpQueueClose,
  DeltaOpQueuePop,
  DeltaOpQueuePush,
  IpcMessage,
  IpcValue,
  IpcValueInline,
  IpcValueSharedBlob,
  NodeSnapshot,
  NodeStatePayload,
  OpKind,
  PeerPermissions,
  Snapshot,
} from "../src/index.js";
import { InProcessBackend, resolveValue, spillMessage } from "../src/transport.js";

const queueDelta = () =>
  Delta.next(4, [
    DeltaOp.queuePush(6, Uint8Array.of(97)),
    DeltaOp.queuePop(6),
    DeltaOp.queueClose(6),
  ]);

test("queue ops encode to the spec wire bodies", () => {
  assert.deepEqual(queueDelta().toWire().ops, [
    { QueuePush: { node: 6, payload: { Inline: [97] } } },
    { QueuePop: { node: 6 } },
    { QueueClose: { node: 6 } },
  ]);
});

for (const codec of ["json", "msgpack"]) {
  test(`queue ops round-trip through the ${codec} codec`, () => {
    const message = IpcMessage.delta(queueDelta());
    const decoded =
      codec === "json"
        ? IpcMessage.decodeJson(message.encodeJson())
        : IpcMessage.decodeMsgpack(message.encodeMsgpack());
    assert.deepEqual(decoded, message);
    const [push, pop, close] = decoded.delta.ops;
    assert.ok(push instanceof DeltaOpQueuePush);
    assert.ok(push.payload instanceof IpcValueInline);
    assert.deepEqual([...push.payload.bytes], [97]);
    assert.equal(push.node, 6);
    assert.ok(pop instanceof DeltaOpQueuePop);
    assert.equal(pop.node, 6);
    assert.ok(close instanceof DeltaOpQueueClose);
    assert.equal(close.node, 6);
  });
}

test("queue op decode rejects a body missing `node`", () => {
  for (const wire of [
    { QueuePush: { payload: { Inline: [1] } } },
    { QueuePop: {} },
    { QueueClose: {} },
  ]) {
    assert.throws(() => DeltaOp.fromWire(wire), TypeError, JSON.stringify(wire));
  }
  assert.throws(() => DeltaOp.fromWire({ QueuePush: { node: 6 } }));
});

test("queue ops are filtered by the node-scoped read check", () => {
  const permissions = new PeerPermissions();
  permissions.allowMany(1, OpKind.Read, [6]);
  const delta = Delta.next(0, [
    DeltaOp.queuePush(6, Uint8Array.of(1)),
    DeltaOp.queuePush(7, Uint8Array.of(2)),
    DeltaOp.queuePop(6),
    DeltaOp.queuePop(7),
    DeltaOp.queueClose(7),
    DeltaOp.queueClose(6),
  ]);
  const filtered = delta.filterReadable(permissions, 1);
  assert.deepEqual(
    filtered.ops.map((op) => [op.constructor, op.node]),
    [
      [DeltaOpQueuePush, 6],
      [DeltaOpQueuePop, 6],
      [DeltaOpQueueClose, 6],
    ],
  );
  assert.equal(delta.filterReadable(permissions, 2).ops.length, 0);
});

test("spillMessage spills an oversized QueuePush payload and it resolves back", () => {
  const ip = new InProcessBackend();
  const big = Uint8Array.from({ length: 1000 }, (_, i) => i & 0xff);
  const delta = Delta.next(0, [
    DeltaOp.queuePush(6, IpcValue.inline(big)),
    DeltaOp.queuePush(7, IpcValue.inline(Uint8Array.of(1))),
    DeltaOp.queuePop(6),
    DeltaOp.queueClose(6),
  ]);
  const { message, spilledBytes } = spillMessage(IpcMessage.delta(delta), ip, 512);
  assert.equal(spilledBytes, 1000);
  const [push, small, pop, close] = message.delta.ops;
  assert.ok(push instanceof DeltaOpQueuePush);
  assert.ok(push.payload instanceof IpcValueSharedBlob);
  assert.deepEqual([...resolveValue(push.payload, ip)], [...big]);
  assert.ok(small.payload instanceof IpcValueInline);
  assert.ok(pop instanceof DeltaOpQueuePop);
  assert.ok(close instanceof DeltaOpQueueClose);
  // The spilled descriptor survives the wire.
  const decoded = IpcMessage.decodeJson(message.encodeJson());
  assert.deepEqual([...resolveValue(decoded.delta.ops[0].payload, ip)], [...big]);
});

test("GraphView refuses queue ops explicitly and applies nothing", () => {
  for (const op of [
    DeltaOp.queuePush(1, Uint8Array.of(9)),
    DeltaOp.queuePop(1),
    DeltaOp.queueClose(1),
  ]) {
    const view = new GraphView();
    view.applySnapshot(
      new Snapshot({ epoch: 1, nodes: [new NodeSnapshot(1, "q", new NodeStatePayload([5]))] }),
    );
    const tag = Object.keys(op.toWire())[0];
    assert.throws(
      () => view.applyDelta(Delta.next(1, [DeltaOp.cellSet(1, Uint8Array.of(7)), op])),
      (err) =>
        err instanceof TypeError &&
        err.message.includes(tag) &&
        err.message.includes("requires a queue projection adapter"),
    );
    // Atomic refusal: the preceding CellSet was not applied and the epoch held.
    assert.deepEqual(view.node(1).payload, [5]);
    assert.equal(view.epoch, 1);
  }
});
