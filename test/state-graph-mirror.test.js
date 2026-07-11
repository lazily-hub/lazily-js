import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  AgentDocNodeType,
  StateGraphMirror,
  compactMirrorSummary,
  decodePayload,
} from "../src/state-graph-mirror.js";

/**
 * `#s5` / `#lazilystatesync5` — cross-editor convergence parity (library half).
 *
 * The shared canonical input is the lazily-spec conformance fixture pair
 * (`conformance/agent-doc/{snapshot,delta}_agent_doc_state.json`). The Rust
 * authoritative graph (`state_wire.rs mod conformance_parity`), the JetBrains
 * mirror (`StateGraphMirrorConformanceTest.kt`), and the VS Code extension all
 * assert the SAME expectation against the SAME fixtures. This library test pins
 * the lazily-js `StateGraphMirror` to that same canonical answer.
 *
 * | field            | snapshot          | after delta |
 * |------------------|-------------------|-------------|
 * | cycle_phase      | preflight_started | committed   |
 * | queue_head_phase | selected          | completed   |
 * | epoch            | 3                 | 6           |
 * | transport phase  | (absent)          | applied     |
 *
 * The fixtures use the lazily-spec *generic graph* wire shape (`node` /
 * `state.Payload` byte arrays / adjacently-tagged `{ CellSet: … }`). The
 * agent-doc mirror applies the flattened agent-doc wire shape; `adaptSnapshot`
 * / `adaptDelta` translate the canonical generic ops into the agent-doc wire.
 */

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "..", "lazily-spec", "conformance", "agent-doc");

const fixturesPresent = existsSync(join(fixtureDir, "snapshot_agent_doc_state.json"));

function loadFixture(name) {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
}

/** lazily-spec byte array → base64 string (the agent-doc payload encoding). */
function bytesToBase64(arr) {
  return Buffer.from(Uint8Array.from(arr)).toString("base64");
}

/** Translate the generic-graph snapshot fixture into the agent-doc mirror wire. */
function adaptSnapshot(fixture) {
  const wire = fixture.wire.Snapshot;
  const nodes = wire.nodes.map((n) => ({
    slot_id: n.node,
    type_tag: n.type_tag,
    state: "resolved",
    payload: bytesToBase64(n.state.Payload),
  }));
  const edges = wire.edges.map((e) => ({ dependent: e.dependent, dependency: e.dependency }));
  return JSON.stringify({
    type: "snapshot",
    epoch: wire.epoch,
    document_hash: "parity-doc",
    nodes,
    edges,
    roots: [],
  });
}

/** Translate the generic-graph delta fixture into the agent-doc mirror wire. */
function adaptDelta(fixture) {
  const wire = fixture.wire.Delta;
  const ops = wire.ops.map((op) => {
    const key = Object.keys(op)[0];
    const body = op[key];
    switch (key) {
      case "CellSet":
        return { op: "cell_set", slot_id: body.node, payload: bytesToBase64(body.payload.Inline) };
      case "SlotValue":
        return { op: "slot_value", slot_id: body.node, payload: bytesToBase64(body.payload.Inline) };
      case "NodeAdd":
        return {
          op: "node_add",
          slot_id: body.node,
          type_tag: body.type_tag,
          payload: bytesToBase64(body.state.Payload),
        };
      case "NodeRemove":
        return { op: "node_remove", slot_id: body.node };
      case "EdgeAdd":
        return { op: "edge_add", dependent: body.dependent, dependency: body.dependency };
      case "EdgeRemove":
        return { op: "edge_remove", dependent: body.dependent, dependency: body.dependency };
      case "Invalidate":
        return { op: "invalidate", slot_id: body.node };
      default:
        throw new Error(`unknown generic-graph op: ${key}`);
    }
  });
  return JSON.stringify({
    type: "delta",
    base_epoch: wire.base_epoch,
    epoch: wire.epoch,
    document_hash: "parity-doc",
    ops,
  });
}

function phaseOf(mirror, typeTag) {
  const payload = mirror.payloadObject(typeTag);
  const phase = payload?.phase;
  return typeof phase === "string" ? phase : undefined;
}

test("state-graph-mirror: applies a snapshot and derives the reactive summary", () => {
  const mirror = new StateGraphMirror();
  assert.equal(mirror.isInitialized, false);

  const snapshot = JSON.stringify({
    type: "snapshot",
    epoch: 3,
    document_hash: "doc-a",
    nodes: [
      {
        slot_id: 1001,
        type_tag: AgentDocNodeType.ROUTE,
        payload: Buffer.from(JSON.stringify({ readiness: "dispatch_authorized", pane_id: "%2" })).toString("base64"),
      },
    ],
    edges: [],
    roots: [1001],
  });
  assert.equal(mirror.applyMessage(snapshot), true);

  assert.equal(mirror.isInitialized, true);
  assert.equal(mirror.documentHash, "doc-a");
  assert.equal(mirror.epoch, 3);
  assert.equal(mirror.nodeCount, 1);

  const summary = mirror.summary();
  assert.equal(summary.routeReadiness, "dispatch_authorized");
  assert.equal(summary.routePaneId, "%2");
  assert.equal(summary.proofMarkers, 0);
  assert.equal(summary.latestTransportPhase, undefined);
  assert.equal(
    mirror.compactSummary(),
    "route=dispatch_authorized pane=%2 transport=-:- proof_markers=0",
  );
});

test("state-graph-mirror: cell_set reactively updates the derived summary", () => {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");
  const mirror = new StateGraphMirror();
  mirror.applyMessage(JSON.stringify({
    type: "snapshot",
    epoch: 1,
    document_hash: "doc-b",
    nodes: [{ slot_id: 1001, type_tag: AgentDocNodeType.ROUTE, payload: b64({ readiness: "dispatch_authorized", pane_id: "%2" }) }],
    edges: [],
    roots: [1001],
  }));
  assert.equal(mirror.summary().latestTransportPhase, undefined);

  assert.equal(mirror.applyMessage(JSON.stringify({
    type: "delta",
    base_epoch: 1,
    epoch: 4,
    document_hash: "doc-b",
    ops: [
      { op: "node_add", slot_id: 2002, type_tag: AgentDocNodeType.TRANSPORT_PATCH, payload: b64({ phase: "queued" }) },
      { op: "node_add", slot_id: 3003, type_tag: AgentDocNodeType.PROOF_MARKER, payload: b64({ phase: "observed" }) },
      { op: "cell_set", slot_id: 1001, payload: b64({ readiness: "dispatch_proven", pane_id: "%2" }) },
      { op: "cell_set", slot_id: 2002, payload: b64({ phase: "applied" }) },
    ],
  })), true);
  assert.equal(mirror.epoch, 4);

  const summary = mirror.summary();
  assert.equal(summary.routeReadiness, "dispatch_proven");
  assert.equal(summary.latestTransportPhase, "applied");
  assert.equal(summary.proofMarkers, 1);
});

test("state-graph-mirror: node_remove + edge ops applied verbatim; epoch monotonic", () => {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64");
  const mirror = new StateGraphMirror();
  mirror.applyMessage(JSON.stringify({ type: "snapshot", epoch: 1, document_hash: "doc-c", nodes: [{ slot_id: 1001, type_tag: AgentDocNodeType.ROUTE, payload: b64({ readiness: "r" }) }], edges: [], roots: [] }));
  mirror.applyMessage(JSON.stringify({
    type: "delta", base_epoch: 1, epoch: 2, document_hash: "doc-c",
    ops: [
      { op: "node_add", slot_id: 2002, type_tag: AgentDocNodeType.TRANSPORT_PATCH, payload: b64({ phase: "queued" }) },
      { op: "edge_add", dependent: 2002, dependency: 1001 },
    ],
  }));
  assert.equal(mirror.nodeCount, 2);

  mirror.applyMessage(JSON.stringify({
    type: "delta", base_epoch: 2, epoch: 3, document_hash: "doc-c",
    ops: [
      { op: "edge_remove", dependent: 2002, dependency: 1001 },
      { op: "node_remove", slot_id: 2002 },
    ],
  }));
  assert.equal(mirror.nodeCount, 1);
  assert.equal(mirror.summary().latestTransportPhase, undefined);

  // Out-of-order delta must not regress the frontier.
  mirror.applyMessage(JSON.stringify({ type: "delta", base_epoch: 3, epoch: 2, document_hash: "doc-c", ops: [] }));
  assert.equal(mirror.epoch, 3);
});

test("state-graph-mirror: compactMirrorSummary + decodePayload fail safe", () => {
  assert.equal(
    compactMirrorSummary({ routeReadiness: "dispatch_proven", routePaneId: "%2", latestTransportPatchId: "patch-2", latestTransportPhase: "applied", proofMarkers: 1 }),
    "route=dispatch_proven pane=%2 transport=patch-2:applied proof_markers=1",
  );
  assert.equal(compactMirrorSummary({ proofMarkers: 0 }), "route=unknown pane=- transport=-:- proof_markers=0");
  assert.deepEqual(decodePayload(Buffer.from(JSON.stringify({ phase: "queued" })).toString("base64")), { phase: "queued" });
  assert.equal(decodePayload(null), null);
  assert.equal(decodePayload(""), null);
  assert.equal(decodePayload("!!!not-base64-json"), null);
});

test("state-graph-mirror: rejects malformed / unknown-type messages", () => {
  const mirror = new StateGraphMirror();
  assert.equal(mirror.applyMessage("{not json"), false);
  assert.equal(mirror.applyMessage(JSON.stringify({ type: "bogus" })), false);
  assert.equal(mirror.applyMessage(JSON.stringify({ epoch: 1 })), false);
  assert.equal(mirror.isInitialized, false);
});

test("state-graph-mirror conformance: canonical snapshot then delta converges (#s5)", { skip: fixturesPresent ? false : "lazily-spec sibling fixtures absent" }, () => {
  const snapshotFixture = loadFixture("snapshot_agent_doc_state.json");
  const deltaFixture = loadFixture("delta_agent_doc_state.json");

  // Fixtures declare the canonical cross-language expectation.
  assert.equal(snapshotFixture.assertions.epoch, 3);
  assert.equal(snapshotFixture.assertions.cycle_phase, "preflight_started");
  assert.equal(snapshotFixture.assertions.queue_head_phase, "selected");
  assert.equal(deltaFixture.assertions.epoch, 6);
  assert.equal(deltaFixture.assertions.cycle_phase_after, "committed");
  assert.equal(deltaFixture.assertions.queue_head_phase_after, "completed");
  assert.equal(deltaFixture.assertions.added_type_tags[0], "agent_doc.transport.patch");

  const mirror = new StateGraphMirror();
  assert.equal(mirror.applyMessage(adaptSnapshot(snapshotFixture)), true);
  assert.equal(mirror.epoch, 3);
  assert.equal(phaseOf(mirror, AgentDocNodeType.CLOSEOUT_CYCLE), "preflight_started");
  assert.equal(phaseOf(mirror, AgentDocNodeType.QUEUE_HEAD), "selected");

  assert.equal(mirror.applyMessage(adaptDelta(deltaFixture)), true);
  assert.equal(mirror.epoch, 6);
  assert.equal(phaseOf(mirror, AgentDocNodeType.CLOSEOUT_CYCLE), "committed");
  assert.equal(phaseOf(mirror, AgentDocNodeType.QUEUE_HEAD), "completed");

  const summary = mirror.summary();
  assert.equal(summary.latestTransportPhase, "applied");
  assert.equal(mirror.nodesOfType(AgentDocNodeType.TRANSPORT_PATCH).length, 1);
});

test("state-graph-mirror conformance: reapplying the canonical delta is idempotent (#s5)", { skip: fixturesPresent ? false : "lazily-spec sibling fixtures absent" }, () => {
  const mirror = new StateGraphMirror();
  mirror.applyMessage(adaptSnapshot(loadFixture("snapshot_agent_doc_state.json")));
  const delta = adaptDelta(loadFixture("delta_agent_doc_state.json"));
  mirror.applyMessage(delta);
  const epochAfterFirst = mirror.epoch;
  const nodesAfterFirst = mirror.nodeCount;
  const summaryAfterFirst = JSON.stringify(mirror.summary());

  mirror.applyMessage(delta);
  assert.equal(mirror.epoch, epochAfterFirst);
  assert.equal(mirror.nodeCount, nodesAfterFirst);
  assert.equal(JSON.stringify(mirror.summary()), summaryAfterFirst);
  assert.equal(phaseOf(mirror, AgentDocNodeType.CLOSEOUT_CYCLE), "committed");
});
