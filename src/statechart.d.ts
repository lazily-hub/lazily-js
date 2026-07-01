// Type declarations for the native Harel/SCXML state chart (compute, not protocol).
// Conforms to `lazily-spec/docs/state-charts.md` and the Lean `StateChart` model.

/** Structural kind of a state node. */
export type StateKind = "atomic" | "compound" | "parallel" | "history" | "final";

/** A transition. A bare target string is shorthand for `{ target }`. */
export interface ChartTransition {
  /** Target state id. MAY be compound/parallel (descended on entry) or history. */
  target: string;
  /** Named guard resolved by the caller (fail-closed if absent/unknown). */
  guard?: string;
  /** Ordered actions fired after the exit set and before the enter set. */
  action?: string[];
  /** If true, an internal transition does not exit/re-enter the source. */
  internal?: boolean;
}

/** Declarative form of a single state (per `schemas/statechart.json`). */
export interface ChartState {
  parent?: string;
  kind?: StateKind;
  parallel?: boolean;
  initial?: string;
  history?: "shallow" | "deep";
  default?: string;
  on?: Record<string, string | ChartTransition>;
  entry?: string[];
  exit?: string[];
}

/** The declarative chart object. */
export interface ChartJson {
  initial: string;
  context?: unknown;
  states: Record<string, ChartState>;
}

/** Per-step named-guard outcomes for one `send`. */
export type GuardMap = Record<string, boolean>;

/**
 * A parsed, immutable chart definition. Built via {@link ChartDef.fromChart}.
 *
 * `kind` is inferred when not stated: `history` when `history` is set;
 * `parallel` when `parallel` is true; `compound` when the state has an
 * `initial`; otherwise `atomic`.
 */
export class ChartDef {
  private constructor();
  /** Parse and validate the declarative chart form. Throws on malformed
   *  charts and unsupported features (`run` actions, `{expr: …}` guards). */
  static fromChart(value: ChartJson): ChartDef;
  /** Structural kind of a state node (defaults to `atomic` if unknown). */
  kind(id: string): StateKind;
  /** `true` for active-leaf kinds (atomic / final). */
  isLeaf(id: string): boolean;
  /** Ancestor chain `[id, ..., root]`. */
  ancestorsInclusive(id: string): string[];
  /** Lowest common ancestor (inclusive) of two states; falls back to root. */
  lca(a: string, b: string): string;
  /** `true` iff `desc` is a proper descendant of `anc`. */
  isProperDescendant(desc: string, anc: string): boolean;
  /** Depth of a state (root = 0). */
  depthOf(id: string): number;
}

/**
 * A native full-Harel state chart. lazily-js is a state-projection consumer
 * with no reactive graph, so the active configuration is a plain `Set`.
 *
 * Deterministic by construction (mirroring the Lean `StateChart.send` total
 * function): a given `(chart, history, configuration, event, guards)` yields a
 * unique result.
 */
export class StateChart {
  /** Enter the initial configuration by descending from the root; records
   *  initial entry actions in {@link lastActions}. */
  constructor(def: ChartDef);
  /** Ordered action names fired by initial entry or the most recent `send`
   *  (exit → transition → entry). Empty after a rejected event. */
  lastActions(): string[];
  /** Full active configuration (leaves plus all active ancestors), sorted. */
  configuration(): string[];
  /** Active atomic leaves, sorted (one per parallel region). */
  activeLeaves(): string[];
  /** Hierarchical "state-in" predicate: `true` iff `id` is active. */
  matches(id: string): boolean;
  /** Run-to-completion transition. Returns `true` if any transition was taken,
   *  `false` if rejected (configuration unchanged, no actions fired). */
  send(event: string, guards?: GuardMap): boolean;
}
