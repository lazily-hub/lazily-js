// Replay-equivalence proof (`#lzreplayjs`). See src/replay.js for the contract,
// the encoding's equality classes, and why `bigint` is the integer here.

/** The checkpoint sequence number for the state before any event was applied. */
export const INITIAL_SEQ: -1;

/** A digest over the canonical bytes. The default is injective (hex of the bytes). */
export type ReplayDigestFn = (bytes: Uint8Array) => string;

/** What the harness needs from the graph it rebuilds. */
export interface ReplayGraph {
  /** Advance the graph by exactly one event. */
  apply(event: ReplayEvent): void;
  /** The cell values the fingerprint covers, keyed by a stable label. */
  observe(): Record<string, unknown> | Map<string, unknown>;
}

/** The one `Outbox` operation `replayLogFromOutbox` needs. */
export interface ReplayOutbox {
  replayFrom(cursor: number): Array<[number, unknown]>;
}

export class ReplayProofError extends Error {
  constructor(message: string);
}

export class ReplayEncodingError extends ReplayProofError {
  constructor(message: string);
}

export class ReplayLogMismatchError extends ReplayProofError {
  readonly expectedDigest: string;
  readonly actualDigest: string;
  constructor(expectedDigest: string, actualDigest: string);
}

export class ReplayStrideMismatchError extends ReplayProofError {
  readonly expectedStride: number;
  readonly actualStride: number;
  constructor(expectedStride: number, actualStride: number);
}

export class ReplayDivergenceError extends ReplayProofError {
  readonly divergences: readonly ReplayDivergence[];
  /** The earliest divergence, which is the one worth reading. */
  readonly first: ReplayDivergence;
  constructor(divergences: readonly ReplayDivergence[]);
}

/** Type-tagged, length-framed, order-stable bytes. Throws on an undefined encoding. */
export function canonicalBytes(value: unknown): Uint8Array;

/** The default digest: the canonical bytes themselves, hex encoded. */
export function identityDigest(bytes: Uint8Array): string;

/** The digest of `canonicalBytes(value)` under `digest` (default injective). */
export function canonicalDigest(value: unknown, digest?: ReplayDigestFn): string;

export class ReplayEvent {
  readonly seq: number;
  readonly name: string;
  readonly payload: unknown;
  constructor(seq: number, name: string, payload?: unknown);
}

export interface ReplayLogOptions {
  digest?: ReplayDigestFn;
}

export class ReplayLog implements Iterable<ReplayEvent> {
  readonly events: readonly ReplayEvent[];
  readonly digest: string;
  readonly length: number;
  constructor(events: Iterable<ReplayEvent>, options?: ReplayLogOptions);
  static of(...events: ReplayEvent[]): ReplayLog;
  static fromRecords(
    records: Iterable<readonly [string, unknown]>,
    options?: ReplayLogOptions,
  ): ReplayLog;
  [Symbol.iterator](): Iterator<ReplayEvent>;
}

export interface ReplayOutboxLogOptions extends ReplayLogOptions {
  cursor?: number;
  name?: string;
}

export function replayLogFromOutbox(
  outbox: ReplayOutbox,
  options?: ReplayOutboxLogOptions,
): ReplayLog;

export class ReplayCheckpoint {
  readonly seq: number;
  readonly cells: ReadonlyArray<readonly [string, string]>;
  constructor(seq: number, cells: Iterable<readonly [string, string]>);
  static of(
    seq: number,
    observed: Record<string, unknown> | Map<string, unknown>,
    digest?: ReplayDigestFn,
  ): ReplayCheckpoint;
  asMap(): Map<string, string>;
  asObject(): Record<string, string>;
}

export interface ReplayFingerprintWire {
  schema_version: number;
  log_digest: string;
  stride: number;
  checkpoints: Array<{ seq: number; cells: Record<string, string> }>;
}

export class ReplayFingerprint {
  readonly logDigest: string;
  readonly stride: number;
  readonly checkpoints: readonly ReplayCheckpoint[];
  readonly digest: string;
  /** The last checkpoint — the end state of the replay. */
  readonly final: ReplayCheckpoint;
  constructor(
    logDigest: string,
    stride: number,
    checkpoints: Iterable<ReplayCheckpoint>,
    options?: ReplayLogOptions,
  );
  toWire(): ReplayFingerprintWire;
  static fromWire(wire: ReplayFingerprintWire, options?: ReplayLogOptions): ReplayFingerprint;
}

/** "value" — both sides observed it and differed; "missing"/"unexpected" — one side did not. */
export type ReplayDivergenceKind = "value" | "missing" | "unexpected";

export class ReplayDivergence {
  readonly seq: number;
  readonly label: string;
  readonly kind: ReplayDivergenceKind;
  readonly expected: string | null;
  readonly actual: string | null;
  readonly preview: string | null;
  constructor(
    seq: number,
    label: string,
    kind: ReplayDivergenceKind,
    expected: string | null,
    actual: string | null,
    observedPreview?: string | null,
  );
  toString(): string;
}

export interface ReplayHarnessOptions {
  /** Checkpoint every `stride`-th event; initial and final are always checkpointed. */
  stride?: number;
  digest?: ReplayDigestFn;
}

export interface ReplayRun {
  fingerprint: ReplayFingerprint;
  observed: Array<Record<string, unknown> | Map<string, unknown>>;
}

export class ReplayHarness {
  readonly stride: number;
  readonly digest: ReplayDigestFn;
  readonly build: () => ReplayGraph;
  constructor(build: () => ReplayGraph, options?: ReplayHarnessOptions);
  record(log: ReplayLog): ReplayFingerprint;
  /** Non-raising for value divergence; still refuses a stale log digest or stride. */
  check(log: ReplayLog, fingerprint: ReplayFingerprint): ReplayDivergence[];
  verify(log: ReplayLog, fingerprint: ReplayFingerprint): ReplayFingerprint;
  prove(log: ReplayLog, options?: { replays?: number }): ReplayFingerprint;
  replayOnce(log: ReplayLog): ReplayRun;
}
