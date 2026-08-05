import type { lazily as Generated } from "../build/generated/graph-boundary.js";

export const protobuf: typeof Generated.graph_boundary.v1;
export const PROTOBUF_GRAPH_BOUNDARY_FEATURE: "protobuf-graph-boundary-v1";

export interface ProjectedCell {
  revision: number;
  text: string;
}

export class ProtobufGraphBoundaryProjection {
  readonly cells: Map<string, ProjectedCell>;
  logicalProjection(): string;
  admit(envelope: Generated.graph_boundary.v1.ProtocolEnvelope): string;
  installSnapshotCells(snapshot: Record<string, string>): void;
}
