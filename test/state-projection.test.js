import assert from "node:assert/strict";
import test from "node:test";

import { StateProjectionClient } from "../src/state-projection.js";

/**
 * Tests for StateProjectionClient using a mock FFI.
 *
 * The real FFI requires the `agent_doc` native library (loaded via ffi-napi);
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
