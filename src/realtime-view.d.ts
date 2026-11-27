import type { Delta, Snapshot } from "./index.js";

export type ViewScalar = null | boolean | number | string;
export type ViewEventType = "activate" | "change" | "submit";
export interface ViewRevision {
  version: 1;
  view_instance: string;
  revision: number;
  definition: unknown;
  bindings: Record<string, number>;
  actions: Record<string, Partial<Record<ViewEventType, string>>>;
}
interface ViewEventFields {
  version: 1;
  view_instance: string;
  displayed_revision: number;
  node_id: string;
  event_id: string;
}
export type ViewEvent = ViewEventFields &
  ({ event: "activate"; payload: null } | { event: "change" | "submit"; payload: ViewScalar });
export interface RealtimeViewNode {
  readonly id: string;
  readonly role: "text" | "button" | "field" | "list" | "region";
  readonly flow: "row" | "column" | "stack" | null;
  readonly children: readonly string[];
  readonly binding: string | null;
  readonly identity: object;
  readonly text: ViewScalar;
  readonly hidden: boolean;
  readonly disabled: boolean;
}
export type ViewUpdate = "applied" | "ignored" | "snapshot-required";
export type ViewEventResult =
  | { status: "accepted"; action: string }
  | { status: "wrong-instance" | "duplicate" | "conflict" | "stale" | "unavailable" | "denied" };

export declare class RealtimeView {
  constructor(instance: string);
  readonly instance: string;
  get revision(): number | null;
  get epoch(): number | null;
  get nodes(): readonly RealtimeViewNode[];
  get signals(): Readonly<Record<string, ViewScalar>>;
  attach(frame: ViewRevision, snapshot: Snapshot): ViewUpdate;
  replace(frame: ViewRevision): ViewUpdate;
  applyDelta(delta: Delta): ViewUpdate;
  routeEvent(
    frame: ViewEvent,
    authorize: (action: string, event: Readonly<ViewEvent>) => boolean,
  ): ViewEventResult;
}
