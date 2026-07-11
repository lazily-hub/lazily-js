/**
 * lazily-js reactive `StateGraphMirror` for the agent-doc FFI state backbone
 * (`#r5at` / `#lazilystatesync4` / `#s5`). Library-owned port of lazily-kt's
 * `StateGraphMirror.kt`; node payloads live in reactive cells and the summary
 * is a memoized derived slot, so consumer reads are reactive.
 */

/** The agent-doc state node `type_tag`s (cross-language vocabulary). */
export const AgentDocNodeType: {
  readonly ROUTE: 'agent_doc.route';
  readonly QUEUE: 'agent_doc.queue';
  readonly QUEUE_HEAD: 'agent_doc.queue.head';
  readonly CLOSEOUT_CYCLE: 'agent_doc.closeout.cycle';
  readonly TRANSPORT_PATCH: 'agent_doc.transport.patch';
  readonly SUPERVISOR_OWNER: 'agent_doc.supervisor.owner';
  readonly DOCUMENT_BASELINE: 'agent_doc.document.baseline';
  readonly DOCUMENT_AUTHORITY: 'agent_doc.document.authority';
  readonly PROOF_MARKER: 'agent_doc.proof.marker';
};

/** One tracked node in the mirror graph. `payload` is `base64(serde_json(struct))`. */
export interface MirrorNode {
  slotId: number;
  typeTag: string;
  payload: string | null;
}

/** Reactive projection summary derived from a {@link StateGraphMirror}'s cells. */
export interface MirrorProjectionSummary {
  routeReadiness?: string;
  routePaneId?: string;
  latestTransportPatchId?: string;
  latestTransportPhase?: string;
  proofMarkers: number;
}

/** Decode a `base64(serde_json(struct))` payload to a JSON object, or null. */
export function decodePayload(payload: string | null | undefined): Record<string, any> | null;

/** Render the compact editor-visible status string (kt `.compact()` parity). */
export function compactMirrorSummary(summary: MirrorProjectionSummary): string;

/** The pure, FFI-free reactive mirror graph a plugin holds per document. */
export class StateGraphMirror {
  constructor();
  get epoch(): number;
  get documentHash(): string | null;
  get isInitialized(): boolean;
  get nodeCount(): number;
  applySnapshot(snapshot: any): boolean;
  applyDelta(delta: any): boolean;
  applyMessage(raw: string): boolean;
  nodesOfType(typeTag: string): MirrorNode[];
  singletonNode(typeTag: string): MirrorNode | null;
  payloadObject(typeTag: string): Record<string, any> | null;
  summary(): MirrorProjectionSummary;
  compactSummary(): string;
}
