import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { assertKey, assertKeyWith } from "./support/assert-key.js";
import { scenarios } from "./support/scenario.js";

import {
  CrdtOp,
  CrdtSync,
  IpcMessage,
  IpcValue,
  NodeSnapshot,
  OpKind,
  PeerPermissions,
  Snapshot,
  wireStampGreater,
} from "../src/index.js";
import {
  CrdtPlaneRuntime,
  InMemoryDataChannel,
  WebRtcSink,
  WebRtcSource,
  WebRtcTransportError,
} from "../src/distributed.js";

import { conformanceRoot } from "./spec-corpus.cjs";

const specFixtures = conformanceRoot;

function loadFixture(name) {
  const path = join(specFixtures, name);
  assert.ok(
    existsSync(path),
    `missing canonical spec fixture ${path} — clone the lazily-spec sibling ` +
      `(git clone https://github.com/lazily-hub/lazily-spec.git ../lazily-spec)`,
  );
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(fixture.protocol_version, 1);
  return fixture;
}

function twoNodeSnapshot() {
  return new Snapshot({
    epoch: 1,
    nodes: [
      NodeSnapshot.payload(1, "t", Uint8Array.of(1, 2, 3)),
      NodeSnapshot.payload(2, "t", Uint8Array.of(4, 5, 6)),
    ],
    edges: [],
    roots: [1, 2],
  });
}

// --- Transport ---

test("InMemoryDataChannel round-trips an IpcMessage via WebRtcSink -> WebRtcSource", () => {
  const [here_, there] = InMemoryDataChannel.pair();
  const sink = new WebRtcSink(here_, new PeerPermissions(), 7);
  const source = new WebRtcSource(there);

  // Peer 7 can read both nodes.
  const permissions = new PeerPermissions();
  permissions.allowMany(7, OpKind.Read, [1, 2]);
  const openSink = new WebRtcSink(here_, permissions, 7);

  openSink.send(IpcMessage.snapshot(twoNodeSnapshot()));
  const received = source.recv();
  assert.equal(received.isSnapshot, true);
  assert.deepEqual(
    received.snapshot.nodes.map((n) => n.node),
    [1, 2],
  );
  // Nothing else pending on an open channel.
  assert.equal(source.recv(), null);
  void sink;
});

test("WebRtcSink drops nodes the peer may not read (outbound permission filter)", () => {
  const [a, b] = InMemoryDataChannel.pair();
  const permissions = new PeerPermissions();
  permissions.allowMany(7, OpKind.Read, [1]); // node 2 is NOT readable
  const sink = new WebRtcSink(a, permissions, 7);
  const source = new WebRtcSource(b);

  sink.send(IpcMessage.snapshot(twoNodeSnapshot()));
  const received = source.recv();
  assert.deepEqual(
    received.snapshot.nodes.map((n) => n.node),
    [1],
    "node 2 filtered out for this peer",
  );
});

test("closed channel reports a Closed WebRtcTransportError on send and recv", () => {
  const [a, b] = InMemoryDataChannel.pair();
  a.close();
  const sink = new WebRtcSink(a, new PeerPermissions(), 1);
  assert.throws(
    () => sink.send(IpcMessage.snapshot(twoNodeSnapshot())),
    (e) => e instanceof WebRtcTransportError && e.kind === "Closed",
  );
  const source = new WebRtcSource(b);
  assert.throws(
    () => source.recv(),
    (e) => e instanceof WebRtcTransportError && e.kind === "Closed",
  );
});

// --- CrdtSync frame conformance ---

// Fill in the declared default for `CrdtSync.frontier` so an omitted frontier
// compares equal to the canonical empty encoding. See lazily-spec
// docs/conformance.md § Round-trip equivalence exemptions (#lzspecfrontiersuppress).
function canonicalizeCrdtSyncWire(wire) {
  const inner = wire?.CrdtSync;
  if (!inner || "frontier" in inner) return wire;
  return { CrdtSync: { frontier: [], ...inner } };
}

test("distributed/crdt_sync_frames.json round-trips each CrdtSync envelope", () => {
  const fixture = loadFixture("distributed/crdt_sync_frames.json");
  for (const frame of fixture.frames) {
    const message = IpcMessage.fromWire(frame.wire);
    assert.equal(message.isCrdtSync, true, frame.label);
    assert.deepEqual(message.toWire(), canonicalizeCrdtSyncWire(frame.wire), frame.label);
    // Byte round-trip through encode/decode.
    assert.deepEqual(IpcMessage.decodeJson(message.encodeJson()), message, frame.label);

    // Exhaustive, not `in`-guarded: an assertion key this runner does not know
    // must fail rather than fall through, or a frame's metadata can arrive and
    // be skipped while the fixture still reports as replayed.
    for (const key of Object.keys(frame.assertions ?? {})) {
      assertKeyWith(frame.assertions ?? {}, key, (expected) => {
        const where = `${frame.label}: ${key}`;
        switch (key) {
          case "frontier_len":
            assert.equal(message.crdtSync.frontier.length, expected, where);
            break;
          case "frontier_omitted":
            // Frontier-suppression exemption: an omitted frontier decodes as empty.
            assert.equal(
              !("frontier" in frame.wire.CrdtSync) && message.crdtSync.frontier.length === 0,
              expected,
              where,
            );
            break;
          case "op_count":
            assert.equal(message.crdtSync.ops.length, expected, where);
            break;
          case "has_keyed_op":
            assert.equal(
              message.crdtSync.ops.some((op) => op.key !== null),
              expected,
              where,
            );
            break;
          case "has_keyless_op":
            assert.equal(
              message.crdtSync.ops.some((op) => op.key === null),
              expected,
              where,
            );
            break;
          default:
            assert.fail(`${frame.label}: unknown frame assertion key \`${key}\``);
        }
      });
    }
  }
});

// --- Anti-entropy convergence ---

function opsFromFixture(fixtureOps) {
  return fixtureOps.map((op) => CrdtOp.fromWire(op));
}

function ingestOps(runtime, ops, startMicros = 100) {
  return runtime.ingest(new CrdtSync({ ops }), startMicros);
}

test("distributed/anti_entropy_converge.json converges and is idempotent", () => {
  const fixture = loadFixture("distributed/anti_entropy_converge.json");
  for (const scenario of scenarios(fixture)) {
    const ops = opsFromFixture(scenario.ops);

    const runtime = new CrdtPlaneRuntime(9);
    const applied = ingestOps(runtime, ops);
    assertKey(scenario.expect, "applied_count", applied, `${scenario.name} applied_count`);
    assertKey(scenario.expect, "converged", runtime.converged(), `${scenario.name} converged`);

    // Re-ingesting the same frame applies 0 new ops (state-based idempotence).
    const reapplied = ingestOps(runtime, ops, 200);
    if ("redeliver_applied_count" in scenario.expect) {
      assertKey(
        scenario.expect,
        "redeliver_applied_count",
        reapplied,
        `${scenario.name} redeliver`,
      );
    } else {
      assert.equal(reapplied, 0, `${scenario.name} redeliver`);
    }
    assert.deepEqual(
      runtime.converged(),
      scenario.expect.converged,
      `${scenario.name} converged after redeliver`,
    );

    // `resolution` names WHICH op is expected to win, which no other key in the
    // block pins: `converged` says what the winning state is, and a runtime that
    // resolved by arrival order would produce the same bytes on a fixture whose
    // last-delivered op also happens to carry the highest stamp. The rule name
    // selects the check and is compared as a value, so a corpus that grows a
    // second rule fails here instead of being replayed under this one.
    assertKeyWith(scenario.expect, "resolution", (rule) => {
      assert.equal(rule, "max_stamp", `${scenario.name}: unmodelled resolution rule \`${rule}\``);
      for (const entry of scenario.expect.converged) {
        const candidates = ops.filter((op) => op.node === entry.node && op.key === entry.key);
        assert.ok(candidates.length > 0, `${scenario.name}: no op for ${entry.node}/${entry.key}`);
        const winner = candidates.reduce((best, op) =>
          wireStampGreater(op.stamp, best.stamp) ? op : best,
        );
        assert.deepEqual(
          winner.state.toWire(),
          entry.state,
          `${scenario.name}: ${entry.node}/${entry.key} did not converge to the max-stamp op`,
        );
      }
    });

    // Delivery-order independence, asserted in BOTH directions: gating the
    // reverse-order replay on the fixture's own flag and asserting only when it
    // is true is the third read-then-discard shape.
    const reversed = new CrdtPlaneRuntime(9);
    ingestOps(reversed, [...ops].reverse());
    const sameUnderReversal =
      JSON.stringify(reversed.converged()) === JSON.stringify(runtime.converged());
    if ("order_independent" in scenario.expect) {
      assertKey(
        scenario.expect,
        "order_independent",
        sameUnderReversal,
        `${scenario.name} reverse-order converged`,
      );
    } else if (scenario.reverse_order_equivalent) {
      assert.equal(sameUnderReversal, true, `${scenario.name} reverse-order converged`);
    }
  }
});

test("two replicas fork and merge to identical converged state", () => {
  const a = new CrdtPlaneRuntime(1);
  const b = new CrdtPlaneRuntime(2);
  a.register(1, "doc/title");
  b.register(1, "doc/title");

  // Concurrent local edits on the same node.
  const opA = a.localUpdate(1, 100, IpcValue.inline(Uint8Array.of(65)));
  const opB = b.localUpdate(1, 100, IpcValue.inline(Uint8Array.of(66)));
  assert.ok(opA && opB);

  // Mutual anti-entropy exchange.
  assert.equal(b.ingest(new CrdtSync({ frontier: a.frontierEntries(), ops: [opA] }), 101), 1);
  assert.equal(a.ingest(new CrdtSync({ frontier: b.frontierEntries(), ops: [opB] }), 101), 1);

  // Both converge to the higher-stamp winner (peer 2 wins the wall-time tie).
  assert.deepEqual(a.converged(), b.converged());
  assert.deepEqual(a.value(1).toWire(), { Inline: [66] });

  // Membership now spans both replicas on each side.
  assert.deepEqual(a.membership(), [1, 2]);
  assert.deepEqual(b.membership(), [1, 2]);

  // A value-preserving local write emits no op.
  const noop = a.localUpdate(1, 102, IpcValue.inline(Uint8Array.of(66)));
  assert.equal(noop, null);
});

test("syncFrameSince and syncReply ship only the ops a peer is missing", () => {
  const a = new CrdtPlaneRuntime(1);
  a.register(1, "doc/title");
  a.register(2, "doc/body");
  const op1 = a.localUpdate(1, 100, IpcValue.inline(Uint8Array.of(1)));
  const op2 = a.localUpdate(2, 101, IpcValue.inline(Uint8Array.of(2)));

  // A full frame ships both ops.
  assert.equal(a.syncFrame().ops.length, 2);

  // A peer that already has everything through A's frontier is missing nothing.
  const upToDate = a.syncFrameSince(a.frontierEntries());
  assert.equal(upToDate.ops.length, 0);

  // A peer that has seen nothing is missing both.
  const fresh = a.syncFrameSince([]);
  assert.equal(fresh.ops.length, 2);

  // syncReply mirrors syncFrameSince over a requester's advertised frontier.
  const b = new CrdtPlaneRuntime(2);
  b.register(1, "doc/title");
  // B has only observed op1 (its frontier advertises exactly that stamp).
  b.ingest(new CrdtSync({ ops: [op1] }), 102);
  const reply = a.syncReply(b.syncFrame());
  assert.equal(reply.ops.length, 1);
  assert.deepEqual(reply.ops[0].node, 2);
  void op2;
});
