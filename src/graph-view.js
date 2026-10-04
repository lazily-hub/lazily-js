// Generic, read-only replica of a lazily reactive graph (`#lzsync` 3B clean split).
//
// Domain-agnostic counterpart to lazily-kt's `GraphView`: folds lazily's canonical
// wire (native `Snapshot` / `Delta`, `NodeId`/`IpcValue`) into a flat, queryable node/edge
// map. It knows nothing about any `type_tag` or payload schema — node payloads are the raw
// bytes the producer published (`IpcValueInline` / `NodeStatePayload`); interpreting them is
// the consumer's job. Replaces the agent-doc-bespoke, base64-`WireDelta` StateGraphMirror as
// the generic half; agent-doc layers its own projection on top.

import {
  DeltaOpNodeAdd,
  DeltaOpCellSet,
  DeltaOpSlotValue,
  DeltaOpInvalidate,
  DeltaOpNodeRemove,
  DeltaOpEdgeAdd,
  DeltaOpEdgeRemove,
  DeltaOpQueuePush,
  DeltaOpQueuePop,
  DeltaOpQueueClose,
  NodeStatePayload,
  IpcValueInline,
} from "./index.js";

const edgeKey = (dependent, dependency) => `${dependent}|${dependency}`;

/** Inline payload bytes (`number[]`) → the raw published bytes; opaque/blob carry none. */
function payloadOfState(state) {
  return state instanceof NodeStatePayload ? [...state.bytes] : null;
}
function payloadOfValue(value) {
  return value instanceof IpcValueInline ? [...value.bytes] : null;
}

/**
 * `#lzdeltaqueueops`: QueuePush/QueuePop/QueueClose are op-log ops on a QueueCell,
 * not node-value writes. The graph-state projection cannot apply queue semantics, so
 * it refuses them explicitly rather than silently dropping them or mis-applying a
 * QueuePush as a CellSet. Any other unrecognised op is refused the same way.
 */
function refuseUnprojectable(op) {
  if (
    op instanceof DeltaOpQueuePush ||
    op instanceof DeltaOpQueuePop ||
    op instanceof DeltaOpQueueClose
  ) {
    const tag = Object.keys(op.toWire())[0];
    throw new TypeError(
      `GraphView: ${tag} (node ${op.node}) requires a queue projection adapter; ` +
        "the graph-state projection cannot apply it",
    );
  }
  if (!(
    op instanceof DeltaOpNodeAdd ||
    op instanceof DeltaOpCellSet ||
    op instanceof DeltaOpSlotValue ||
    op instanceof DeltaOpInvalidate ||
    op instanceof DeltaOpNodeRemove ||
    op instanceof DeltaOpEdgeAdd ||
    op instanceof DeltaOpEdgeRemove
  )) {
    throw new TypeError(`GraphView: unsupported DeltaOp ${op?.constructor?.name}`);
  }
}

export class GraphView {
  /** @type {Map<number, {id:number, typeTag:string, payload:number[]|null}>} */
  #nodes = new Map();
  /** @type {Set<string>} */
  #edges = new Set();
  #epoch = 0;
  #initialized = false;

  /** Monotonic frontier — the highest lazily epoch applied so far. */
  get epoch() {
    return this.#epoch;
  }

  /** True until at least one snapshot/delta has been applied. */
  get isInitialized() {
    return this.#initialized;
  }

  get nodeCount() {
    return this.#nodes.size;
  }

  /** Apply a cold-read native {@link Snapshot}, replacing the whole graph image. */
  applySnapshot(snapshot) {
    this.#nodes.clear();
    this.#edges.clear();
    for (const node of snapshot.nodes) {
      this.#nodes.set(node.node, {
        id: node.node,
        typeTag: node.typeTag,
        payload: payloadOfState(node.state),
      });
    }
    for (const edge of snapshot.edges) {
      this.#edges.add(edgeKey(edge.dependent, edge.dependency));
    }
    this.#epoch = snapshot.epoch;
    this.#initialized = true;
  }

  /**
   * Apply a warm native {@link Delta}. Ops apply verbatim in emission order; the frontier
   * advances to `max(epoch, delta.epoch)`. A no-op delta (empty ops) only advances the epoch.
   */
  applyDelta(delta) {
    // Refuse BEFORE mutating anything, so a refused delta leaves the replica
    // exactly as it was (no half-applied prefix).
    for (const op of delta.ops) refuseUnprojectable(op);
    for (const op of delta.ops) {
      if (op instanceof DeltaOpNodeAdd) {
        this.#nodes.set(op.node, {
          id: op.node,
          typeTag: op.typeTag,
          payload: payloadOfState(op.state),
        });
      } else if (op instanceof DeltaOpCellSet || op instanceof DeltaOpSlotValue) {
        const node = this.#nodes.get(op.node);
        if (node) node.payload = payloadOfValue(op.payload);
      } else if (op instanceof DeltaOpInvalidate) {
        // Derived recompute stays at the producer; keep the stale payload until a cell_set.
      } else if (op instanceof DeltaOpNodeRemove) {
        this.#nodes.delete(op.node);
      } else if (op instanceof DeltaOpEdgeAdd) {
        this.#edges.add(edgeKey(op.dependent, op.dependency));
      } else if (op instanceof DeltaOpEdgeRemove) {
        this.#edges.delete(edgeKey(op.dependent, op.dependency));
      }
    }
    this.#epoch = Math.max(this.#epoch, delta.epoch);
    this.#initialized = true;
  }

  /** The node for `id`, or null. */
  node(id) {
    return this.#nodes.get(id) ?? null;
  }

  /** All tracked nodes of `typeTag`, in stable insertion order. */
  nodesOfType(typeTag) {
    return [...this.#nodes.values()].filter((n) => n.typeTag === typeTag);
  }

  /** The single node of `typeTag`, or null (first in insertion order if several). */
  singletonNode(typeTag) {
    return [...this.#nodes.values()].find((n) => n.typeTag === typeTag) ?? null;
  }

  allNodes() {
    return [...this.#nodes.values()];
  }

  allEdges() {
    return [...this.#edges].map((k) => k.split("|").map(Number));
  }
}
