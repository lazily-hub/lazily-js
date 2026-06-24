import { EventEmitter } from "node:events";

/**
 * JS-friendly interface to the lazily / agent-doc state-projection FFI channel.
 *
 * `loadAgentDocFFI` returns an implementation; tests inject a mock.
 */
export interface LazilyFFI {
  /**
   * Read the binary's `DocumentStateProjection` JSON for a document, or `null`
   * when no events have been recorded.
   */
  stateProjection(documentHash: string): string | null;
  /**
   * Feed a `StateEvent` JSON object into the binary's state backbone.
   * @returns `true` if accepted, `false` on parse/ledger failure.
   */
  recordStateEvent(documentHash: string, factJson: string): boolean;
}

/**
 * Lazily load the `agent_doc` native library and wrap its state-projection C
 * ABI into the {@link LazilyFFI} interface. `koffi` is resolved only when
 * called, not at module import.
 */
export function loadAgentDocFFI(libPath?: string): LazilyFFI;

/** `"projection"` event payload: the new projection JSON, or `null`. */
export type ProjectionEvent = [projection: string | null];

/**
 * EventEmitter-based holder for the binary's state projection, plus an event
 * reporter. The JS analogue of lazily-kt's `StateProjectionClient`.
 */
export class StateProjectionClient extends EventEmitter {
  constructor(documentHash: string, ffi?: LazilyFFI);

  readonly documentHash: string;

  /** Current projection JSON, or `null` when no events have been recorded. */
  get projection(): string | null;

  /** `true` once a non-null projection has been observed. */
  get isAvailable(): boolean;

  /**
   * Pull the latest state projection from the binary. Emits a `"projection"`
   * event with the new JSON (or `null`).
   * @returns The freshly-read projection JSON, or `null`.
   */
  refresh(): string | null;

  /**
   * Record a state event in the binary's backbone.
   * @returns `true` if accepted, `false` on parse/ledger failure.
   */
  recordStateEvent(factJson: string): boolean;

  on(event: "projection", listener: (projection: string | null) => void): this;
  once(event: "projection", listener: (projection: string | null) => void): this;
  off(event: "projection", listener: (projection: string | null) => void): this;
  emit(event: "projection", projection: string | null): boolean;
  addListener(
    event: "projection",
    listener: (projection: string | null) => void,
  ): this;
  removeListener(
    event: "projection",
    listener: (projection: string | null) => void,
  ): this;
}
