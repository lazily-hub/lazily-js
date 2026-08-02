// Library dispatch audit.
//
// A companion sweep audited every CONFORMANCE RUNNER in the family for silent
// dispatch defaults. This file covers the other half — the LIBRARY — where the
// same shape has two opposite readings:
//
//   * on a decode path another process writes, a default can be the wire
//     contract (a peer at a different version, a field added after this
//     descriptor shape shipped, a C ABI that has no exception channel);
//   * on an internal path, where only this package ever mints the value, a
//     default is a bug that reports success for work that did not happen.
//
// Both halves are pinned here, because from outside a deliberate default and a
// forgotten one are indistinguishable. The INTENTIONAL group feeds the unknown
// value and asserts the lenient outcome IS what the contract promises; the
// FAIL-CLOSED group feeds the unknown value and asserts it is now named in a
// thrown error rather than absorbed.

import assert from "node:assert/strict";
import test from "node:test";

import {
  BlobBackendKind,
  CausalReceipt,
  CommandPolicy,
  CommandProjection,
  CommandStatus,
  CommandSubmit,
  DedupePolicy,
  Delta,
  DriverError,
  IpcMessage,
  IpcValue,
  ShmBlobRef,
  Snapshot,
  SyncDriver,
} from "../src/index.js";
import {
  decodeMessage,
  encodeMessage,
  kindOf,
  LazilyFfiMessageKind,
  LazilyFfiStatus,
} from "../src/ffi.js";
import { projectionSummary, compactProjectionSummary } from "../src/state-projection.js";
import { TextCrdt } from "../src/text-crdt.js";
import { ChartDef } from "../src/statechart.js";
import { BackpressurePolicy, Overflow, RelayCell } from "../src/relay.js";
import { Context } from "../src/reactive.js";
import { Sum } from "../src/merge.js";
import {
  IngressCore,
  IngressReceiptChannel,
  defaultIngressPolicy,
  ingressEnvelope,
  receiptChannel,
} from "../src/ingress-core.js";
import { LosslessTreeCrdt } from "../src/lossless-tree-crdt.js";
import { InMemoryDataChannel, WebRtcSink, RtcPeerChannel } from "../src/distributed.js";

/** A minimally-populated, fully-valid CommandSubmit. */
function submitOf(commandId) {
  return new CommandSubmit({
    commandId,
    causationId: commandId,
    source: "vscode-plugin",
    target: "project-controller",
    namespace: "agent-doc",
    name: "editor_route",
    authorityGeneration: 0,
    idempotencyKey: `${commandId}:run`,
    deadlineMs: 1000,
    policy: new CommandPolicy({
      dedupe: DedupePolicy.SameIdempotencyKey,
      supersede: false,
      cancelOnPreempt: true,
    }),
    payloadType: "agent-doc.editor_route.v1",
    payloadHash: "sha256:deadbeef",
    payload: IpcValue.inline([1]),
  });
}

// ---------------------------------------------------------------------------
// (A) INTENTIONAL leniency — the default IS the contract
// ---------------------------------------------------------------------------

test("verdict INTENTIONAL: an absent ShmBlobRef.backend decodes as shm, an unknown one is refused", () => {
  // Forward/backward compat with the pre-pluggable-backend wire form: `toWire`
  // omits `shm`, so "no key" has exactly one meaning and must keep decoding.
  const legacy = ShmBlobRef.fromWire({
    offset: 0,
    len: 16,
    generation: 1,
    epoch: 2,
    checksum: 3,
  });
  assert.equal(legacy.backend, BlobBackendKind.Shm);
  // Round-trip proof that the lenient decode is byte-stable, not a widening:
  // re-encoding the decoded value must NOT introduce a `backend` key.
  assert.equal(Object.hasOwn(legacy.toWire(), "backend"), false);

  // Leniency stops at absence. A backend NAME this build cannot map is refused,
  // because a descriptor names memory and guessing a mapper yields wrong bytes.
  assert.throws(
    () =>
      ShmBlobRef.fromWire({
        offset: 0,
        len: 16,
        generation: 1,
        epoch: 2,
        checksum: 3,
        backend: "quantum_tape",
      }),
    /unknown blob backend: quantum_tape/,
  );
});

test("verdict INTENTIONAL: the FFI codec reports failure as a status, never as a throw", () => {
  // The C ABI has no exception channel, so `lazily_ffi_*_json` returns an int
  // and the isomorphic shim must be substitutable for the real `.so`.
  const stranger = { kind: "FromTheFuture" };
  assert.equal(kindOf(stranger), LazilyFfiMessageKind.Unknown);
  assert.equal(kindOf(null), LazilyFfiMessageKind.Unknown);

  const enc = encodeMessage(stranger);
  assert.equal(enc.status, LazilyFfiStatus.InvalidMessage);
  // The kind is still reported alongside the rejection — mirrors the C entry
  // point, which classifies before it refuses.
  assert.equal(enc.kind, LazilyFfiMessageKind.Unknown);
  assert.equal(enc.payload.length, 0);

  // An unknown WIRE TAG decodes to a status, not an exception — and to no
  // message at all, so a caller that ignores `status` cannot act on a half
  // decode.
  const dec = decodeMessage(new TextEncoder().encode(JSON.stringify({ TeleportFrame: {} })));
  assert.equal(dec.status, LazilyFfiStatus.InvalidMessage);
  assert.equal(dec.message, null);

  // Malformed bytes take the same channel.
  assert.equal(
    decodeMessage(new TextEncoder().encode("{not json")).status,
    LazilyFfiStatus.InvalidMessage,
  );
  // Empty input is its own status, distinct from invalid.
  assert.equal(decodeMessage(new Uint8Array(0)).status, LazilyFfiStatus.Empty);
});

test("verdict INTENTIONAL: projectionSummary degrades field-by-field over another process's JSON", () => {
  // `DocumentStateProjection` is minted by the Rust agent-doc side, whose
  // version is not pinned to this package's. Unknown sections are ignored and
  // missing ones read as absent so an editor status line still renders.
  const fromANewerPeer = {
    route: { readiness: "ready", pane_id: "p1", quantum_field: 7 },
    telepathy: { channels: 3 },
  };
  const summary = projectionSummary(fromANewerPeer);
  assert.equal(summary.routeReadiness, "ready");
  assert.equal(summary.routePaneId, "p1");
  // The sections this build knows about but the peer did not send read absent,
  // never invented.
  assert.equal(summary.latestTransportPatchId, undefined);
  assert.equal(summary.latestTransportPhase, undefined);
  assert.equal(summary.proofMarkers, 0);
  assert.match(compactProjectionSummary(summary), /route=ready pane=p1 transport=-:-/);

  // A field of the WRONG TYPE is treated as absent rather than rendered raw.
  const wrongTypes = projectionSummary({ route: { readiness: 42 }, transport: "nope" });
  assert.equal(wrongTypes.routeReadiness, undefined);

  // The load-bearing case for the section defaults: an OLDER peer, or one
  // observed mid-handshake, has not grown these sections at all. Reading a
  // whole missing section must summarize as absent, not throw.
  const empty = projectionSummary({});
  assert.equal(empty.routeReadiness, undefined);
  assert.equal(empty.routePaneId, undefined);
  assert.equal(empty.latestTransportPatchId, undefined);
  assert.equal(empty.latestTransportPhase, undefined);
  assert.equal(empty.proofMarkers, 0);
  // Only `route` present — the transport/proof sections still default cleanly.
  const partial = projectionSummary({ route: { readiness: "warming" } });
  assert.equal(partial.routeReadiness, "warming");
  assert.equal(partial.proofMarkers, 0);

  // The one thing refused outright: a projection that is not an object at all.
  assert.equal(projectionSummary("ready"), null);
  assert.equal(projectionSummary(null), null);
});

test("verdict INTENTIONAL: a sparse remote version vector means 'seen nothing', not 'malformed'", () => {
  const doc = TextCrdt.fromStr(7, "hi");
  // `deltaSince({})` is the documented spelling of first contact: the peer has
  // named no authors, so every op is new to it.
  assert.equal(doc.deltaSince({}).length, 2);
  // A vector that names OTHER peers but not this document's author is equally
  // valid — a peer omits every author it has never heard from.
  assert.equal(doc.deltaSince({ 99: 5 }).length, 2);
  // And an entry that HAS been seen suppresses its ops, proving the `?? 0` is
  // the vector's identity rather than a blanket "resend everything".
  assert.equal(doc.deltaSince({ 7: 2 }).length, 0);
});

test("verdict INTENTIONAL: an unknown receipt reject reason still resolves to Rejected", () => {
  // `CausalReceipt.outcome` is enum-checked; `reason` is deliberately free text
  // because it carries the authority's own words. A reason vocabulary a newer
  // authority invents must still land on the correct TERMINALITY.
  const proj = new CommandProjection();
  proj.submit(submitOf("c1"));
  const res = proj.observeReceipt(
    CausalReceipt.rejected(
      "r1",
      "c1",
      "project-controller",
      0,
      "quota_exhausted_in_a_future_release",
    ),
  );
  assert.equal(res.kind, "recorded");
  assert.equal(proj.entry("c1").status, CommandStatus.Rejected);
  assert.equal(proj.entry("c1").terminal, true);

  // A KNOWN reason still refines to its more specific status, so the default is
  // the general case and not a swallow-everything.
  const proj2 = new CommandProjection();
  proj2.submit(submitOf("c2"));
  proj2.observeReceipt(CausalReceipt.rejected("r2", "c2", "project-controller", 0, "timed_out"));
  assert.equal(proj2.entry("c2").status, CommandStatus.TimedOut);
});

// ---------------------------------------------------------------------------
// (B) FAIL CLOSED — the unknown value is now named in an error
// ---------------------------------------------------------------------------

test("verdict FAIL-CLOSED: a statechart state kind outside the schema enum is rejected", () => {
  assert.throws(
    () =>
      ChartDef.fromChart({
        initial: "a",
        states: { a: { kind: "quantum" } },
      }),
    /state a: unknown kind `quantum`/,
  );
});

test("verdict FAIL-CLOSED: a declared statechart kind that contradicts its structure is rejected", () => {
  // Previously `kind` was compared only against "final", so this parsed as a
  // silent atomic leaf: transitions into it entered nothing.
  assert.throws(
    () =>
      ChartDef.fromChart({
        initial: "a",
        states: { a: { kind: "parallel" } },
      }),
    /state a: declared kind `parallel` contradicts its structure \(inferred `atomic`\)/,
  );
  // Agreement is still accepted, on both the inferred and the `final` path.
  const ok = ChartDef.fromChart({
    initial: "leaf",
    states: {
      root: { kind: "compound", initial: "leaf" },
      leaf: { parent: "root", kind: "atomic" },
      done: { parent: "root", kind: "final" },
    },
  });
  assert.equal(ok.kind("root"), "compound");
  assert.equal(ok.kind("done"), "final");
});

test("verdict FAIL-CLOSED: a statechart reference to an unknown state is rejected", () => {
  // `ChartDef.kind` answers "atomic" for an id it does not hold, so a typo'd
  // target used to be ACCEPTED and moved the configuration to a phantom state.
  assert.throws(
    () =>
      ChartDef.fromChart({
        initial: "a",
        states: { root: { initial: "a" }, a: { parent: "root", on: { GO: "b" } } },
      }),
    /state a: on\.GO target references unknown state `b`/,
  );
  assert.throws(
    () =>
      ChartDef.fromChart({
        initial: "a",
        states: { root: { initial: "nowhere" }, a: { parent: "root" } },
      }),
    /state root: initial references unknown state `nowhere`/,
  );
});

test("verdict FAIL-CLOSED: an unknown RelayCell overflow policy is rejected at the bound", () => {
  const ctx = new Context();
  const policy = new BackpressurePolicy(ctx, "Count", 1, 0, "drop_oldest"); // snake case typo
  const relay = new RelayCell(ctx, policy, Sum);
  relay.ingress(1); // fills the window to high_water
  assert.throws(() => relay.ingress(2), /unknown RelayCell overflow policy: drop_oldest/);
  // The legal spelling still bounds the window rather than throwing.
  ctx.set(policy.overflow, Overflow.DropOldest);
  assert.equal(relay.depth(), 1);
  relay.ingress(2);
  assert.equal(relay.depth(), 1);
});

test("verdict FAIL-CLOSED: an unknown IngressCore overflow policy is rejected at high water", () => {
  const core = new IngressCore(
    defaultIngressPolicy({ overflow: "Drop_Newest", highWater: 1 }),
    Sum,
  );
  core.admit(ingressEnvelope("a", 1, 0, 0, 1));
  assert.throws(
    () => core.admit(ingressEnvelope("a", 1, 1, 0, 2)),
    /unknown IngressCore overflow policy: Drop_Newest/,
  );
});

test("verdict FAIL-CLOSED: an unknown ingress receipt outcome kind is rejected, not routed to Error", () => {
  // Receipts are minted only inside IngressCore, so a shape it does not mint
  // used to be silently counted as a delivery failure that never happened.
  assert.throws(
    () => receiptChannel({ outcome: { kind: "quarantined" } }),
    /unknown ingress receipt outcome kind: quarantined/,
  );
  // The three real outcomes still classify.
  assert.equal(receiptChannel({ outcome: { kind: "accepted" } }), IngressReceiptChannel.Accepted);
  assert.equal(receiptChannel({ outcome: { kind: "dropped" } }), IngressReceiptChannel.Dropped);
  assert.equal(receiptChannel({ outcome: { kind: "error" } }), IngressReceiptChannel.Error);
});

test("verdict FAIL-CLOSED: an unknown lossless-tree op type is rejected instead of parked forever", () => {
  const replica = new LosslessTreeCrdt(1);
  assert.throws(
    () =>
      replica.applyUpdate({
        ops: [{ id: { counter: 1, peer: 2 }, kind: { type: "GraftSubtree", node: null } }],
      }),
    /unknown lossless-tree op type: GraftSubtree/,
  );
});

test("verdict FAIL-CLOSED: an IpcMessage kind that is neither content nor control is not sent unfiltered", () => {
  // This chain is the only place per-peer read permissions are applied to
  // outbound content; the old terminal else forwarded anything it did not
  // recognise verbatim.
  const [chan] = InMemoryDataChannel.pair();
  const sink = new WebRtcSink(chan, { canRead: () => true }, 1);
  assert.throws(
    () => sink.send({ kind: "SecretDump", isSnapshot: false, isDelta: false }),
    /refusing to send unfiltered IpcMessage kind: SecretDump/,
  );
});

test("verdict FAIL-CLOSED: a data-channel frame that is not bytes is rejected, not zero-lengthed", () => {
  // `new Uint8Array(blob)` yields a ZERO-LENGTH array without throwing, so a
  // channel that ignores `binaryType = "arraybuffer"` used to turn every frame
  // into a silent empty read.
  const listeners = new Map();
  const fakeDc = {
    readyState: "open",
    binaryType: "blob",
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    send() {},
  };
  const chan = new RtcPeerChannel(fakeDc);
  assert.equal(fakeDc.binaryType, "arraybuffer"); // the adapter still asks
  const deliver = listeners.get("message");
  assert.throws(
    () => deliver({ data: { size: 12, type: "application/octet-stream" } }),
    /WebRTC data-channel frame is neither ArrayBuffer, string, nor ArrayBufferView/,
  );
  // The three shapes it does understand still arrive as bytes.
  deliver({ data: new Uint8Array([1, 2, 3]).buffer });
  deliver({ data: "hi" });
  deliver({ data: new Uint8Array([9]) });
  assert.deepEqual([...chan.tryRecvFrame()], [1, 2, 3]);
  assert.deepEqual([...chan.tryRecvFrame()], [104, 105]);
  assert.deepEqual([...chan.tryRecvFrame()], [9]);
});

test("verdict FAIL-CLOSED: a SyncDriver source that yields a non-IpcMessage raises DriverError", () => {
  // Every `is*` getter on an un-decoded wire object is `undefined`, so the value
  // fell out of the dispatch chain and the tick reported no inbound progress —
  // an un-decoded stream looked exactly like an idle one.
  const inbound = [{ Delta: { base_epoch: 0, epoch: 1 } }];
  const driver = new SyncDriver({
    sink: { send: () => true },
    source: { recv: () => inbound.shift() ?? null },
    clock: { nowMillis: () => 0 },
    provider: { snapshot: (from) => IpcMessage.snapshot(new Snapshot({ epoch: from })) },
    lastEpoch: 0,
  });
  assert.throws(() => driver.tick(), DriverError);

  // A properly decoded frame of the same bytes still ticks.
  const ok = [IpcMessage.delta(new Delta({ baseEpoch: 0, epoch: 1 }))];
  const good = new SyncDriver({
    sink: { send: () => true },
    source: { recv: () => ok.shift() ?? null },
    clock: { nowMillis: () => 0 },
    provider: { snapshot: (from) => IpcMessage.snapshot(new Snapshot({ epoch: from })) },
    lastEpoch: 0,
  });
  assert.equal(good.tick().applied.length, 1);
});
