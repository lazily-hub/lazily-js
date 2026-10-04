// Type declarations for the generic GraphView (`#lzsync` 3B clean split).

/** A tracked node: id, type_tag, and the producer's raw published payload bytes. */
export interface GraphViewNode {
  id: number;
  typeTag: string;
  payload: number[] | null;
}

/**
 * A generic, read-only replica of a lazily reactive graph. Folds native
 * `Snapshot` / `Delta` into a queryable node/edge map. Domain-agnostic — payloads
 * are the producer's raw bytes; interpreting them is the consumer's job.
 */
export declare class GraphView {
  get epoch(): number;
  get isInitialized(): boolean;
  get nodeCount(): number;
  applySnapshot(snapshot: unknown): void;
  /**
   * Throws (before mutating) on QueuePush/QueuePop/QueueClose: the graph-state
   * projection cannot apply queue op-log semantics (`#lzdeltaqueueops`).
   */
  applyDelta(delta: unknown): void;
  node(id: number): GraphViewNode | null;
  nodesOfType(typeTag: string): GraphViewNode[];
  singletonNode(typeTag: string): GraphViewNode | null;
  allNodes(): GraphViewNode[];
  allEdges(): number[][];
}
