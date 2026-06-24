import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  buildStateEvent,
  compactProjectionSummary,
  documentHash,
  projectionSummary,
  StateProjectionClient,
  wrapAgentDocStateProjectionFFI,
} from "../src/state-projection.js";

/**
 * Tests for StateProjectionClient using a mock FFI.
 *
 * The real FFI requires the `agent_doc` native library (loaded via koffi);
 * these tests verify the client logic (projection holder updates, null
 * handling, event emission, event reporting) without a native dependency —
 * mirroring lazily-kt's StateProjectionClientTest.
 */
function createMockFFI({
  projectionJson = "null",
  recordResult = 1,
} = {}) {
  const mock = {
    projectionJson,
    recordResult,
    recordedEvent: null,
    stateProjectionCallCount: 0,
    freeCallCount: 0,

    stateProjection(documentHash) {
      mock.stateProjectionCallCount += 1;
      return mock.projectionJson === "null" || mock.projectionJson == null
        ? null
        : mock.projectionJson;
    },
    recordStateEvent(documentHash, factJson) {
      mock.recordedEvent = factJson;
      return mock.recordResult === 1;
    },
  };
  return mock;
}

test("refresh updates the projection holder with projection JSON", () => {
  const mock = createMockFFI({
    projectionJson: '{"document":{"hash":"abc123"}}',
  });
  const client = new StateProjectionClient("abc123", mock);

  assert.equal(client.isAvailable, false);
  assert.equal(client.projection, null);

  const json = client.refresh();

  assert.equal(client.isAvailable, true);
  assert.equal(client.projection, '{"document":{"hash":"abc123"}}');
  assert.equal(json, client.projection);
  assert.equal(mock.stateProjectionCallCount, 1);
});

test("refresh with null projection keeps isAvailable false", () => {
  const mock = createMockFFI({ projectionJson: "null" });
  const client = new StateProjectionClient("noevents", mock);

  const json = client.refresh();

  assert.equal(client.isAvailable, false);
  assert.equal(client.projection, null);
  assert.equal(json, null);
});

test("refresh emits a projection event with the new JSON", () => {
  const mock = createMockFFI({
    projectionJson: '{"route":{"phase":"response"}}',
  });
  const client = new StateProjectionClient("doc1", mock);

  const events = [];
  client.on("projection", (projection) => events.push(projection));

  client.refresh();

  assert.deepEqual(events, ['{"route":{"phase":"response"}}']);
});

test("refresh emits a projection event with null when unavailable", () => {
  const mock = createMockFFI({ projectionJson: "null" });
  const client = new StateProjectionClient("doc1", mock);

  const events = [];
  client.on("projection", (projection) => events.push(projection));

  client.refresh();

  assert.deepEqual(events, [null]);
});

test("refresh reflects later projection changes on repeated calls", () => {
  const mock = createMockFFI({ projectionJson: "null" });
  const client = new StateProjectionClient("doc1", mock);
  const events = [];
  client.on("projection", (projection) => events.push(projection));

  client.refresh();
  mock.projectionJson = '{"document":{"hash":"doc1","phase":"committed"}}';
  client.refresh();

  assert.equal(client.isAvailable, true);
  assert.deepEqual(events, [
    null,
    '{"document":{"hash":"doc1","phase":"committed"}}',
  ]);
});

test("recordStateEvent passes fact JSON through and returns true on success", () => {
  const mock = createMockFFI({ recordResult: 1 });
  const client = new StateProjectionClient("doc1", mock);

  const accepted = client.recordStateEvent('{"type":"BaselineSaved"}');

  assert.equal(accepted, true);
  assert.equal(mock.recordedEvent, '{"type":"BaselineSaved"}');
});

test("recordStateEvent returns false on failure", () => {
  const mock = createMockFFI({ recordResult: 0 });
  const client = new StateProjectionClient("doc1", mock);

  const accepted = client.recordStateEvent('{"type":"Invalid"}');

  assert.equal(accepted, false);
});

test("documentHash is exposed for the bound document", () => {
  const mock = createMockFFI();
  const client = new StateProjectionClient("0xdeadbeef", mock);

  assert.equal(client.documentHash, "0xdeadbeef");
});

test("documentHash uses canonical path sha256", () => {
  const tmp = join(tmpdir(), `agent_doc_state_${Date.now()}.md`);
  writeFileSync(tmp, "state");
  try {
    const expected = createHash("sha256")
      .update(realpathSync(tmp), "utf-8")
      .digest("hex");
    assert.equal(documentHash(tmp), expected);
  } finally {
    unlinkSync(tmp);
  }
});

test("buildStateEvent matches Rust state backbone serde shape", () => {
  assert.deepEqual(
    buildStateEvent(
      "doc-a",
      "editor_patch_queued",
      { patch_id: "patch-1", actor_generation: 7 },
      "editor-patch-queued-patch-1-7",
    ),
    {
      event_id: "doc-a:editor-patch-queued-patch-1-7",
      fact: {
        type: "editor_patch_queued",
        document_hash: "doc-a",
        patch_id: "patch-1",
        actor_generation: 7,
      },
    },
  );
});

test("projectionSummary renders route transport and proof slices", () => {
  const summary = projectionSummary({
    document_hash: "doc-a",
    route: { generation: 3, pane_id: "%2", readiness: "dispatch_proven" },
    transport: { patches: { "patch-1": { phase: "queued" }, "patch-2": { phase: "acked" } } },
    proof: { markers: { dispatch_start: { phase: "observed", sources: ["route"] } } },
  });

  assert.deepEqual(summary, {
    routeReadiness: "dispatch_proven",
    routePaneId: "%2",
    latestTransportPatchId: "patch-2",
    latestTransportPhase: "acked",
    proofMarkers: 1,
  });
  assert.equal(
    compactProjectionSummary(summary),
    "route=dispatch_proven pane=%2 transport=patch-2:acked proof_markers=1",
  );
});

test("wrapAgentDocStateProjectionFFI decodes and frees projection pointers", () => {
  const ptr = { id: "ptr-1" };
  const calls = [];
  const functions = {
    "void *agent_doc_state_projection(const char *document_hash)": (documentHashValue) => {
      calls.push(["projection", documentHashValue]);
      return ptr;
    },
    "int agent_doc_record_state_event(const char *document_hash, const char *fact_json)": (
      documentHashValue,
      factJson,
    ) => {
      calls.push(["record", documentHashValue, factJson]);
      return 1;
    },
    "void agent_doc_free_string(void *ptr)": (freed) => calls.push(["free", freed]),
  };
  const lib = {
    func(signature) {
      return functions[signature];
    },
  };
  const koffi = {
    address(value) {
      return value === ptr ? 42n : 0n;
    },
    decode: {
      string(value) {
        assert.equal(value, ptr);
        return "{\"document_hash\":\"doc-a\"}";
      },
    },
  };

  const ffi = wrapAgentDocStateProjectionFFI(koffi, lib);

  assert.equal(ffi.stateProjection("doc-a"), "{\"document_hash\":\"doc-a\"}");
  assert.equal(ffi.recordStateEvent("doc-a", "{\"fact\":true}"), true);
  assert.deepEqual(calls, [
    ["projection", "doc-a"],
    ["free", ptr],
    ["record", "doc-a", "{\"fact\":true}"],
  ]);
});
