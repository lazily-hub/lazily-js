import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  PROTOBUF_GRAPH_BOUNDARY_FEATURE,
  ProtobufGraphBoundaryProjection,
  protobuf,
} from "../src/protobuf-graph-boundary.js";
import { assertKey } from "./support/assert-key.js";
import { scenarios } from "./support/scenario.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = "protobuf/graph_boundary_traces.json";

function loadFixture() {
  const path = join(here, "..", "..", "lazily-spec", "conformance", FIXTURE);
  assert.ok(
    existsSync(path),
    `missing canonical spec fixture ${path} — clone the lazily-spec sibling`,
  );
  return JSON.parse(readFileSync(path, "utf8"));
}

function envelope(step) {
  let body;
  switch (step.kind) {
    case "cell_text_splice":
      body = {
        graphInput: {
          cellTextSplice: {
            documentId: step.document_id,
            cellId: step.cell_id,
            expectedCellRevision: step.expected_revision,
            localOffsetUtf8: step.offset,
            deleteLengthUtf8: step.delete_length,
            insertText: step.insert_text,
          },
        },
      };
      break;
    case "bootstrap_snapshot":
      body = {
        graphInput: {
          bootstrapSnapshot: {
            purpose: protobuf.SnapshotPurpose.SNAPSHOT_PURPOSE_BOOTSTRAP,
            canonicalJson: Buffer.from(JSON.stringify(step.cells)),
          },
        },
      };
      break;
    case "derived_projection":
      body = {
        derivedProjection: {
          projectionVersion: step.sequence,
          cells: Object.entries(step.cells).map(([cellId, text]) => ({
            documentId: "doc",
            cellId,
            revision: 1,
            text,
          })),
        },
      };
      break;
    case "surface_observation":
      body = {
        graphInput: {
          surfaceObservation: {
            surfaceId: "fixture",
            kind: protobuf.SurfaceObservationKind.SURFACE_OBSERVATION_KIND_NATIVE_RELOAD,
            cellId: step.cell_id,
          },
        },
      };
      break;
    default:
      throw new Error(`unknown fixture kind ${step.kind}`);
  }
  return protobuf.ProtocolEnvelope.create({
    protocolVersion: 1,
    schemaVersion: "1.0.0-experimental",
    graphId: "fixture-graph",
    sourceId: "fixture-source",
    sourceGeneration: step.source_generation,
    causalEpoch: step.causal_epoch,
    sequence: step.sequence,
    correlationId: `fixture-${step.sequence}`,
    ...body,
  });
}

test("generated handshake negotiates the optional feature", () => {
  const handshake = protobuf.CapabilityHandshake.create({
    minimumProtocolVersion: 1,
    maximumProtocolVersion: 1,
    codecs: ["protobuf"],
    features: [PROTOBUF_GRAPH_BOUNDARY_FEATURE],
  });
  const bytes = protobuf.CapabilityHandshake.encode(handshake).finish();
  const decoded = protobuf.CapabilityHandshake.decode(bytes);
  assert.deepEqual(decoded.codecs, ["protobuf"]);
  assert.deepEqual(decoded.features, [PROTOBUF_GRAPH_BOUNDARY_FEATURE]);
});

test("generated protobuf round trips canonical logical traces", () => {
  const fixture = loadFixture();
  let replayed = 0;
  for (const scenario of scenarios(fixture)) {
    replayed += 1;
    const projection = new ProtobufGraphBoundaryProjection();
    const decisions = [];
    for (const step of scenario.steps) {
      const message = envelope(step);
      const bytes = protobuf.ProtocolEnvelope.encode(message).finish();
      const decoded = protobuf.ProtocolEnvelope.decode(bytes);
      const decision = projection.admit(decoded);
      if (decision === "bootstrap") {
        projection.installSnapshotCells(step.cells);
      }
      decisions.push(decision);
    }
    assertKey(
      scenario.expect,
      "cells",
      Object.fromEntries([...projection.cells.entries()].map(([id, cell]) => [id, cell.text])),
      scenario.id,
    );
    assertKey(scenario.expect, "decisions", decisions, scenario.id);
    assertKey(scenario.expect, "logical_projection", projection.logicalProjection(), scenario.id);
    assertKey(scenario.expect, "ordinary_snapshot_count", 0, scenario.id);
  }
  assert.equal(replayed, 6);
});
