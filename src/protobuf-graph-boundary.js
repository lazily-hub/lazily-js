import { lazily as generated } from "../build/generated/graph-boundary.js";

/** Generated Protobuf message family. */
export const protobuf = generated.graph_boundary.v1;

/** Capability token peers must both advertise before using this encoding. */
export const PROTOBUF_GRAPH_BOUNDARY_FEATURE = "protobuf-graph-boundary-v1";

/** @typedef {{ revision: number, text: string }} ProjectedCell */

/**
 * Native semantic reducer behind the generated Protobuf representation.
 * Generated types own shape; this reducer owns fencing and graph semantics.
 */
export class ProtobufGraphBoundaryProjection {
  constructor() {
    this.sourceGeneration = 0;
    this.causalEpoch = 0;
    this.lastSequence = 0;
    /** @type {Map<string, ProjectedCell>} */
    this.cells = new Map();
  }

  logicalProjection() {
    return [...this.cells.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, cell]) => `${id}@${cell.revision}=${cell.text}`)
      .join("|");
  }

  admit(envelope) {
    const incoming = [Number(envelope.sourceGeneration), Number(envelope.causalEpoch)];
    const current = [this.sourceGeneration, this.causalEpoch];
    const order = comparePair(incoming, current);
    if (order < 0) return "reject_stale";
    if (order > 0) {
      [this.sourceGeneration, this.causalEpoch] = incoming;
      this.lastSequence = 0;
    }
    const sequence = Number(envelope.sequence);
    if (sequence <= this.lastSequence) return "duplicate";
    if (sequence !== this.lastSequence + 1) return "reject_gap";

    let decision;
    if (envelope.graphInput) {
      decision = this.#applyInput(envelope.graphInput);
    } else if (envelope.derivedProjection) {
      this.cells.clear();
      for (const cell of envelope.derivedProjection.cells ?? []) {
        this.cells.set(cell.cellId, {
          revision: Number(cell.revision),
          text: cell.text,
        });
      }
      decision = "project";
    } else {
      throw new Error("unsupported graph-boundary body");
    }
    this.lastSequence = sequence;
    return decision;
  }

  installSnapshotCells(snapshot) {
    this.cells.clear();
    for (const [id, text] of Object.entries(snapshot)) {
      this.cells.set(id, { revision: 1, text });
    }
  }

  #applyInput(input) {
    if (input.cellTextSplice) {
      const splice = input.cellTextSplice;
      const cell = this.cells.get(splice.cellId) ?? { revision: 0, text: "" };
      if (cell.revision !== Number(splice.expectedCellRevision)) {
        throw new Error("cell revision mismatch");
      }
      cell.text = spliceUtf8(
        cell.text,
        splice.localOffsetUtf8,
        splice.deleteLengthUtf8,
        splice.insertText,
      );
      cell.revision += 1;
      this.cells.set(splice.cellId, cell);
      return "apply";
    }
    if (input.bootstrapSnapshot) {
      if (input.bootstrapSnapshot.purpose === 0) {
        throw new Error("snapshot purpose must be explicit");
      }
      return "bootstrap";
    }
    if (input.surfaceObservation) return "observe";
    throw new Error("unsupported graph input");
  }
}

function comparePair(left, right) {
  return left[0] === right[0] ? left[1] - right[1] : left[0] - right[0];
}

function spliceUtf8(text, offset, deleteLength, insertText) {
  const original = Buffer.from(text, "utf8");
  if (offset < 0 || deleteLength < 0 || offset + deleteLength > original.length) {
    throw new Error("splice outside UTF-8 bytes");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat([
      original.subarray(0, offset),
      Buffer.from(insertText, "utf8"),
      original.subarray(offset + deleteLength),
    ]),
  );
}
