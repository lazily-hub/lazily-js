// lazily-js reactive `StateGraphMirror` for the agent-doc FFI state backbone
// (`#r5at` / `#lazilystatesync4` / `#s5`).
//
// This is the library-owned port of lazily-kt's `StateGraphMirror.kt`
// (`io.github.lazily.StateGraphMirror` / `MirrorProjectionSummary`,
// `#n529`/`#lazilystatesync3`). The binary (lazily-rs) owns the authoritative
// reactive state graph; this mirror applies the `agent_doc_state_subscribe`
// snapshot/delta messages so editor UI (dispatch-ready / busy / queue
// indicators) derives from tracked reactive cells instead of re-rendering the
// full projection JSON on every observed event.
//
// Unlike the old hand-rolled `Map` fold that lived in the VS Code extension,
// this mirror is a REAL lazily reactive graph: node payloads live in
// per-`slot_id` reactive cells inside a `Context`, structure changes bump a
// membership cell, and the projection summary is a memoized derived slot. A
// `cell_set` on a tracked node reactively invalidates the summary; an unrelated
// `cell_set` does not.
//
// Wire shapes match `agent-doc-orchestration/src/state_wire.rs` and
// `src/lazily-spec/schemas/{snapshot,delta}.json`:
//   - snapshot: { type:"snapshot", epoch, document_hash, nodes[], edges[], roots[] }
//   - delta:    { type:"delta", base_epoch, epoch, document_hash, ops[] }
//
// Because the projection is a pure fold of deduped events, delta application is
// deterministic and idempotent — a no-op delta (re-emit) leaves the mirror
// unchanged (`#qdedupsync` property). Field names + the `compact()` format are
// pinned 1:1 to the kt `MirrorProjectionSummary` for cross-language parity.

import { Context } from "./reactive.js";

/** The agent-doc state node `type_tag`s (cross-language vocabulary). */
export const AgentDocNodeType = Object.freeze({
  ROUTE: "agent_doc.route",
  QUEUE: "agent_doc.queue",
  QUEUE_HEAD: "agent_doc.queue.head",
  CLOSEOUT_CYCLE: "agent_doc.closeout.cycle",
  TRANSPORT_PATCH: "agent_doc.transport.patch",
  SUPERVISOR_OWNER: "agent_doc.supervisor.owner",
  DOCUMENT_BASELINE: "agent_doc.document.baseline",
  DOCUMENT_AUTHORITY: "agent_doc.document.authority",
  PROOF_MARKER: "agent_doc.proof.marker",
});

/**
 * Decode a `base64(serde_json(struct))` payload to a JSON object, or null on
 * failure / unset payload. Pure — exported for tests + consumers.
 *
 * @param {string | null | undefined} payload
 * @returns {Record<string, any> | null}
 */
export function decodePayload(payload) {
  if (payload == null || payload === "") return null;
  try {
    const json = Buffer.from(payload, "base64").toString("utf-8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Render the compact editor-visible status string (matches the kt
 * `MirrorProjectionSummary.compact()` EXACTLY for cross-language parity).
 *
 * @param {{ routeReadiness?: string, routePaneId?: string, latestTransportPatchId?: string, latestTransportPhase?: string, proofMarkers: number }} summary
 * @returns {string}
 */
export function compactMirrorSummary(summary) {
  return (
    `route=${summary.routeReadiness ?? "unknown"} pane=${summary.routePaneId ?? "-"} ` +
    `transport=${summary.latestTransportPatchId ?? "-"}:${summary.latestTransportPhase ?? "-"} ` +
    `proof_markers=${summary.proofMarkers}`
  );
}

function stringField(obj, key) {
  if (!obj) return undefined;
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * The pure, FFI-free reactive mirror graph a plugin holds per document.
 *
 * Node payloads live in reactive cells keyed by `slot_id`; the projection
 * summary is a memoized derived slot over those cells + a membership cell. The
 * public read surface (`summary`, `nodesOfType`, `singletonNode`,
 * `payloadObject`) reads through the reactive `Context`.
 */
export class StateGraphMirror {
  /** @type {Context} */
  #ctx;
  /** slotId -> { typeTag, cell } — the reactive node cells. */
  #nodes = new Map();
  /** slotId insertion order (stable). */
  #order = [];
  /** "dependent:dependency" edge keys. */
  #edges = new Set();
  /** CellHandle<number> — bumped whenever the node set / types change. */
  #membership;
  #membershipVersion = 0;
  /** SlotHandle — the memoized projection summary derived from tracked cells. */
  #summaryMemo;

  #declaredHash = null;
  #epoch = 0;

  constructor() {
    this.#reset();
  }

  /** Rebuild a fresh reactive graph (cold snapshot / construction). */
  #reset() {
    this.#ctx = new Context();
    this.#nodes = new Map();
    this.#order = [];
    this.#edges = new Set();
    this.#membershipVersion = 0;
    this.#membership = this.#ctx.cell(0);
    this.#summaryMemo = this.#ctx.memo(() => this.#computeSummary());
  }

  #bumpMembership() {
    this.#membershipVersion += 1;
    this.#ctx.setCell(this.#membership, this.#membershipVersion);
  }

  static #edgeKey(dependent, dependency) {
    return `${dependent}:${dependency}`;
  }

  /** Monotonic frontier — the highest lazily-spec epoch applied so far. */
  get epoch() {
    return this.#epoch;
  }

  /** The document hash declared by the last applied snapshot/delta, or null. */
  get documentHash() {
    return this.#declaredHash;
  }

  /** True until at least one snapshot/delta has been applied. */
  get isInitialized() {
    return this.#declaredHash !== null;
  }

  get nodeCount() {
    return this.#nodes.size;
  }

  // -- Node materialization (reactive cells) ----------------------------

  #putNode(slotId, typeTag, payload) {
    const existing = this.#nodes.get(slotId);
    if (existing) {
      const typeChanged = existing.typeTag !== typeTag;
      existing.typeTag = typeTag;
      this.#ctx.setCell(existing.cell, payload ?? null);
      if (typeChanged) this.#bumpMembership();
      return;
    }
    const cell = this.#ctx.cell(payload ?? null);
    this.#nodes.set(slotId, { typeTag, cell });
    this.#order.push(slotId);
    this.#bumpMembership();
  }

  #setNodePayload(slotId, payload) {
    const node = this.#nodes.get(slotId);
    if (node) this.#ctx.setCell(node.cell, payload ?? null);
  }

  #removeNode(slotId) {
    if (!this.#nodes.delete(slotId)) return;
    const idx = this.#order.indexOf(slotId);
    if (idx !== -1) this.#order.splice(idx, 1);
    this.#bumpMembership();
  }

  /** Read a node's live payload through the reactive context (registers dep). */
  #nodePayload(slotId) {
    const node = this.#nodes.get(slotId);
    return node ? this.#ctx.getCell(node.cell) : null;
  }

  #materializedNodes() {
    const out = [];
    for (const slotId of this.#order) {
      const node = this.#nodes.get(slotId);
      if (node) out.push({ slotId, typeTag: node.typeTag, payload: this.#nodePayload(slotId) });
    }
    return out;
  }

  // -- Apply ------------------------------------------------------------

  /**
   * Apply a cold-read snapshot object, replacing the whole reactive graph.
   * @param {any} snapshot parsed `{ type:"snapshot", epoch, document_hash, nodes, edges, roots }`
   * @returns {boolean}
   */
  applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return false;
    this.#reset();
    if (typeof snapshot.document_hash === "string") this.#declaredHash = snapshot.document_hash;
    if (Array.isArray(snapshot.nodes)) {
      for (const node of snapshot.nodes) {
        if (!node || typeof node.slot_id !== "number" || typeof node.type_tag !== "string") continue;
        const payload = typeof node.payload === "string" ? node.payload : null;
        this.#putNode(node.slot_id, node.type_tag, payload);
      }
    }
    if (Array.isArray(snapshot.edges)) {
      for (const edge of snapshot.edges) {
        if (!edge || typeof edge.dependent !== "number" || typeof edge.dependency !== "number") continue;
        this.#edges.add(StateGraphMirror.#edgeKey(edge.dependent, edge.dependency));
      }
    }
    if (typeof snapshot.epoch === "number") this.#epoch = snapshot.epoch;
    return true;
  }

  /**
   * Apply a warm delta object. Ops are applied verbatim in emission order; the
   * frontier advances to `max(epoch, delta.epoch)`. A no-op delta (empty ops)
   * only advances the epoch.
   * @param {any} delta parsed `{ type:"delta", base_epoch, epoch, document_hash, ops }`
   * @returns {boolean}
   */
  applyDelta(delta) {
    if (!delta || typeof delta !== "object") return false;
    if (typeof delta.document_hash === "string") this.#declaredHash = delta.document_hash;
    if (Array.isArray(delta.ops)) {
      for (const op of delta.ops) {
        if (!op || typeof op.op !== "string") continue;
        switch (op.op) {
          case "node_add": {
            if (typeof op.slot_id !== "number" || typeof op.type_tag !== "string") break;
            const payload = typeof op.payload === "string" ? op.payload : null;
            this.#putNode(op.slot_id, op.type_tag, payload);
            break;
          }
          case "cell_set":
          case "slot_value": {
            if (typeof op.slot_id !== "number") break;
            this.#setNodePayload(op.slot_id, typeof op.payload === "string" ? op.payload : null);
            break;
          }
          case "invalidate":
            // Derived recompute is plugin-side; the mirror holds the stale
            // payload until a cell_set arrives.
            break;
          case "node_remove":
            if (typeof op.slot_id === "number") this.#removeNode(op.slot_id);
            break;
          case "edge_add":
            if (typeof op.dependent === "number" && typeof op.dependency === "number") {
              this.#edges.add(StateGraphMirror.#edgeKey(op.dependent, op.dependency));
            }
            break;
          case "edge_remove":
            if (typeof op.dependent === "number" && typeof op.dependency === "number") {
              this.#edges.delete(StateGraphMirror.#edgeKey(op.dependent, op.dependency));
            }
            break;
          default:
            break;
        }
      }
    }
    if (typeof delta.epoch === "number") this.#epoch = Math.max(this.#epoch, delta.epoch);
    return true;
  }

  /**
   * Apply a raw `agent_doc_state_subscribe` message, dispatching on the
   * lazily-spec `"type"` discriminator (`snapshot` or `delta`). Returns false
   * when the message cannot be parsed / has an unknown type.
   * @param {string} raw
   * @returns {boolean}
   */
  applyMessage(raw) {
    let root;
    try {
      root = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!root || typeof root !== "object" || typeof root.type !== "string") return false;
    if (root.type === "snapshot") return this.applySnapshot(root);
    if (root.type === "delta") return this.applyDelta(root);
    return false;
  }

  // -- Read (reactive) --------------------------------------------------

  /** All tracked nodes of `typeTag` (stable insertion order). */
  nodesOfType(typeTag) {
    const out = [];
    for (const slotId of this.#order) {
      const node = this.#nodes.get(slotId);
      if (node && node.typeTag === typeTag) {
        out.push({ slotId, typeTag: node.typeTag, payload: this.#nodePayload(slotId) });
      }
    }
    return out;
  }

  /** The single document-level node for `typeTag`, or null. */
  singletonNode(typeTag) {
    for (const slotId of this.#order) {
      const node = this.#nodes.get(slotId);
      if (node && node.typeTag === typeTag) {
        return { slotId, typeTag: node.typeTag, payload: this.#nodePayload(slotId) };
      }
    }
    return null;
  }

  /** Decode a node payload (`base64(serde_json(struct))`) as a JSON object, or null. */
  payloadObject(typeTag) {
    const node = this.singletonNode(typeTag);
    return node ? decodePayload(node.payload) : null;
  }

  #computeSummary() {
    // Structure dependency: recompute the summary when the node set changes.
    this.#ctx.getCell(this.#membership);

    const routeNode = this.singletonNode(AgentDocNodeType.ROUTE);
    const route = routeNode ? decodePayload(routeNode.payload) : null;
    const routeReadiness = stringField(route, "readiness");
    const routePaneId = stringField(route, "pane_id");

    const patches = this.nodesOfType(AgentDocNodeType.TRANSPORT_PATCH);
    const latest = patches.length > 0
      ? patches.reduce((a, b) => (b.slotId > a.slotId ? b : a))
      : undefined;
    const latestTransportPhase = latest ? stringField(decodePayload(latest.payload), "phase") : undefined;

    const proofMarkers = this.nodesOfType(AgentDocNodeType.PROOF_MARKER).length;

    return {
      routeReadiness,
      routePaneId,
      latestTransportPatchId: undefined,
      latestTransportPhase,
      proofMarkers,
    };
  }

  /**
   * Reactive projection summary derived from this mirror's tracked cells (the
   * memoized analog of the kt `MirrorProjectionSummary.fromMirror`).
   * @returns {{ routeReadiness?: string, routePaneId?: string, latestTransportPatchId?: string, latestTransportPhase?: string, proofMarkers: number }}
   */
  summary() {
    return this.#ctx.get(this.#summaryMemo);
  }

  /** The compact editor-visible status string (kt `.compact()` parity). */
  compactSummary() {
    return compactMirrorSummary(this.summary());
  }
}
