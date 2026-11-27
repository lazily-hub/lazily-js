import type { Context } from "./reactive.js";
import type { RealtimeViewNode, ViewEventType, ViewScalar } from "./realtime-view.js";

export type ViewLayoutNode = Pick<RealtimeViewNode, "id" | "role" | "children" | "flow">;
export type ViewEffect =
  | { op: "set"; signal: string; value: ViewScalar }
  | { op: "send"; event: string; payload?: ViewScalar };

/** Host-neutral View compute document interpreter. */
export declare class View {
  constructor(context: Context, definition: unknown);
  static install(definition: unknown): View;
  signalsJson(): Record<string, ViewScalar>;
  expressionsJson(): Record<string, ViewScalar>;
  layoutJson(): ViewLayoutNode[];
  chartJson(): string[] | null;
  dispatch(node: string, event: ViewEventType, value?: ViewScalar): ViewEffect[];
}
