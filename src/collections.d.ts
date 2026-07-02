export type CollectionKey = string;

export type InvalidationReport = {
  value: CollectionKey[];
  membership: boolean;
  order: boolean;
};

export type CellMapOp =
  | { type: "set_value"; key: CollectionKey; value: unknown }
  | { type: "insert"; key: CollectionKey; value: unknown; at?: "end" | "start" | number | CollectionKey }
  | { type: "remove"; key: CollectionKey }
  | { type: "move_to"; key: CollectionKey; index: number }
  | { type: "move_before"; key: CollectionKey; before: CollectionKey }
  | { type: "move_after"; key: CollectionKey; after: CollectionKey };

export type CellMapSnapshot = {
  order: CollectionKey[];
  values: Record<string, unknown>;
};

export class CellMap {
  constructor(initial?: { order?: CollectionKey[]; values?: Record<string, unknown> });
  order: CollectionKey[];
  values: Map<CollectionKey, unknown>;
  keys(): CollectionKey[];
  has(key: CollectionKey): boolean;
  get(key: CollectionKey): unknown;
  handle(key: CollectionKey): number | undefined;
  snapshot(): CellMapSnapshot;
  apply(op: CellMapOp): InvalidationReport;
  setValue(key: CollectionKey, value: unknown): InvalidationReport;
  insert(
    key: CollectionKey,
    value: unknown,
    at?: "end" | "start" | number | CollectionKey,
  ): InvalidationReport;
  remove(key: CollectionKey): InvalidationReport;
  moveTo(key: CollectionKey, index: number): InvalidationReport;
  moveBefore(key: CollectionKey, beforeKey: CollectionKey): InvalidationReport;
  moveAfter(key: CollectionKey, afterKey: CollectionKey): InvalidationReport;
  static from(initial: { order?: CollectionKey[]; values?: Record<string, unknown> }): CellMap;
}

export type ReconcileOp =
  | { type: "remove"; key: CollectionKey }
  | { type: "move"; key: CollectionKey; after: CollectionKey | null }
  | { type: "insert"; key: CollectionKey; value: unknown; after: CollectionKey | null };

export type ReconcileResult = {
  ops: ReconcileOp[];
  result_order: CollectionKey[];
  stable_keys_not_invalidated: CollectionKey[];
};

export function reconcileCollections(
  prior: { order: CollectionKey[]; values?: Record<string, unknown> },
  target: { order: CollectionKey[]; values?: Record<string, unknown> },
): ReconcileResult;
