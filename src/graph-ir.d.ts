export class GraphIrError extends Error {
  name: "GraphIrError";
}

export const DRAIN_BUDGET: number;

export const Policy: {
  readonly KeepLatest: "keep-latest";
  readonly Sum: "sum";
  readonly Max: "max";
  readonly Min: "min";
  readonly And: "and";
  readonly Or: "or";
};

export const EdgeKind: {
  readonly Read: "read";
  readonly Write: "write";
};

export type PolicyName = (typeof Policy)[keyof typeof Policy];
export type EdgeKindName = (typeof EdgeKind)[keyof typeof EdgeKind];
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export class Edge {
  from: string;
  kind: EdgeKindName;
  to: string;
  constructor(from: string, kind: EdgeKindName, to: string);
}

export class EffectRun {
  id: string;
  result: JsonValue;
  constructor(id: string, result: JsonValue);
}

export class GraphIr {
  static fromJsonStr(text: string): GraphIr;
  static fromJson(value: JsonValue): GraphIr;
  toJson(): JsonValue;
  id(): string | null;
  nodes(): unknown[];
  node(id: string): unknown;
  staticEdges(): Edge[];
  emitSource(): string;
  check(): void;
  clone(): GraphIr;
}

export class GraphEdit {
  static fromJsonStr(text: string): GraphEdit;
  static fromJson(value: JsonValue): GraphEdit;
  ops(): unknown[];
}

export class GraphRuntime {
  drainBudget: number;
  lastDrainExhaustion: number | null;
  static loadJson(text: string): GraphRuntime;
  static lower(doc: GraphIr, drainBudget?: number): GraphRuntime;
  document(): GraphIr;
  contains(id: string): boolean;
  isEager(id: string): boolean;
  sourcePolicy(id: string): PolicyName;
  staticEdges(): Edge[];
  emitSource(): string;
  observedReads(id: string): Set<string>;
  effectTrace(): EffectRun[];
  get(id: string): JsonValue;
  writeSource(id: string, value: JsonValue): void;
  apply(edit: GraphEdit): void;
}
