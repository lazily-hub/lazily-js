// Replay-equivalence proof for a reactive graph (`#lzreplayjs`).
//
// The contract is `lazily-spec/docs/replay-equivalence.md`:
//
//     Given the same event log, a REBUILT graph observes the same values at
//     every checkpoint. Any deviation is a defect in the graph, not a
//     tolerance.
//
// Three obligations follow, and each one is a thing this module refuses to do
// rather than a thing it promises:
//
//   1. A fingerprint carries the digest of the log that produced it, and
//      `verify`/`check` revalidate that binding BEFORE comparing any observed
//      value. The discipline is `tsift`'s: a cached excerpt records a body hash
//      and is re-checked against the source bytes, so a stale body
//      deterministically suppresses the cached answer instead of returning a
//      plausible-looking one. Here the event log is the source bytes. Two
//      different logs can settle to the same final values (`[+1,+2,+3]` and
//      `[+3,+2,+1]` both sum to 6), so a value-only comparison would PASS on a
//      stale fingerprint and certify nothing about the log in front of it.
//   2. A divergence is reported at the FIRST checkpoint where the values
//      parted, naming the cell label — not merely at the final state, where the
//      defect is still visible but no longer locatable. `stride` is part of the
//      fingerprint, because equal log digest plus equal stride is what makes two
//      checkpoint sequences comparable at all.
//   3. The observation encoding is canonical, or it fails. A value with no
//      defined encoding raises `ReplayEncodingError` instead of falling back on
//      the host's default rendering — in JavaScript `String(obj)` collapses
//      every object to `[object Object]` and `JSON.stringify` silently drops
//      `undefined`, functions and symbols, so a fallback reports a FALSE
//      divergence (or, worse, a false match) on every run. That is the exact
//      failure a replay proof exists to make impossible.
//
// ## The encoding, and the two traps JavaScript adds
//
// The family agrees on equality CLASSES, never on bytes: fingerprints are pinned
// next to a test in one language and are never exchanged between bindings.
//
//   | Property        | Requirement                                           |
//   |-----------------|-------------------------------------------------------|
//   | Mapping order   | `{a:1,b:2}` and `{b:2,a:1}` are the same value         |
//   | Set order       | `{1,2,3}` and `{3,1,2}` are the same value             |
//   | Sequence order  | `[1,2]` and `[2,1]` are different values               |
//   | Type tagging    | `1`, `"1"`, `1.0`, `true`, bytes `1` are five values   |
//   | Member framing  | `["a","bc"]` and `["ab","c"]` are different values     |
//
// **Trap 1 — there is no integer.** A JavaScript `number` IS an IEEE-754
// double: `1` and `1.0` are the same value at runtime, so no encoding of
// `number` alone can ever put them in different classes. `BigInt` is the exact
// integer, so `bigint` carries the integer tag `i` (exact decimal, no 2^53
// ceiling) and `number` carries the float tag `f` (the exact 8 IEEE-754 bytes,
// which keeps `-0` apart from `0` and never folds NaN payloads together the way
// a shortest-round-trip decimal would). Observe a `bigint` when you mean an
// integer. This is why the canonical corpus carries its integers as decimal
// STRINGS — `9007199254740993` is not representable as a `number`, and a runner
// that parsed it as one would be comparing two ADJACENT integers that had
// already collapsed into the same double.
//
// **Trap 2 — `undefined`.** It is the host's "absent", not a value, and
// encoding it as `null` would merge `{a: undefined}` with `{a: null}` and very
// nearly with `{}`. It has no encoding and raises.
//
// ## The digest
//
// `canonicalBytes` is the contract; the digest over it is free. The default here
// is the DEGENERATE strongest one — the canonical bytes themselves, hex encoded
// — chosen for two reasons. It has no collisions at all rather than merely
// improbable ones, and it costs no dependency: `node:crypto` would pull a Node
// built-in into every browser bundle that imports this module, and this package
// ships to browsers under a byte budget (`.size-limit.json`). At the scale a
// replay proof runs at (a pinned test log) the expansion is irrelevant.
//
// For a long production log, pass your own: `new ReplayHarness(build, {digest})`
// and `new ReplayLog(events, {digest})` both take `(bytes: Uint8Array) =>
// string`, so a Node caller can hand in
// `(b) => createHash("sha256").update(b).digest("hex")` without this module ever
// naming `node:crypto`. Mixing two digest functions cannot silently pass: the
// log digest changes with the function, so a fingerprint recorded under one and
// verified under another is refused as a log mismatch — obligation 1 covering
// this case for free.

/** The checkpoint sequence number for the state before any event was applied. */
export const INITIAL_SEQ = -1;

const WIRE_SCHEMA_VERSION = 1;
const PREVIEW_LIMIT = 120;

// -- errors -------------------------------------------------------------------
//
// Four distinct classes, so a driver routes on the TYPE and never on a message
// string. A message is prose: it gets copy-edited, translated and truncated, and
// a caller matching on it is a test that fails for the wrong reason.

/** A replay-equivalence proof could not be completed as stated. */
export class ReplayProofError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReplayProofError";
  }
}

/**
 * A value has no canonical byte encoding, so it cannot be fingerprinted.
 *
 * Raised instead of degrading to `String(value)` or `JSON.stringify`, either of
 * which would report a false divergence (or a false match) on every run.
 */
export class ReplayEncodingError extends ReplayProofError {
  constructor(message) {
    super(message);
    this.name = "ReplayEncodingError";
  }
}

/**
 * The fingerprint was recorded against a different event log.
 *
 * The tsift rule: revalidate the recorded hash against the source bytes and
 * deterministically suppress the cached answer when they disagree. A stale
 * fingerprint is never compared, so it can neither pass by coincidence nor be
 * misreported as a value divergence.
 */
export class ReplayLogMismatchError extends ReplayProofError {
  constructor(expectedDigest, actualDigest) {
    super(
      "fingerprint was recorded against a different event log (fingerprint " +
        `logDigest=${expectedDigest}, replayed log digest=${actualDigest}); ` +
        "re-record the fingerprint against this log",
    );
    this.name = "ReplayLogMismatchError";
    this.expectedDigest = expectedDigest;
    this.actualDigest = actualDigest;
  }
}

/**
 * The fingerprint was recorded at a different checkpoint stride.
 *
 * A distinct type from `ReplayLogMismatchError` because it is a distinct fault:
 * the log is the right one, but the two checkpoint sequences were never
 * comparable, so there is nothing here to blame the graph for.
 */
export class ReplayStrideMismatchError extends ReplayProofError {
  constructor(expectedStride, actualStride) {
    super(
      `fingerprint was recorded at stride ${expectedStride} but this harness ` +
        `samples at stride ${actualStride}; re-record it`,
    );
    this.name = "ReplayStrideMismatchError";
    this.expectedStride = expectedStride;
    this.actualStride = actualStride;
  }
}

/** A replayed graph observed a different value than the fingerprint. */
export class ReplayDivergenceError extends ReplayProofError {
  constructor(divergences) {
    if (!Array.isArray(divergences) || divergences.length === 0) {
      throw new TypeError("ReplayDivergenceError requires at least one divergence");
    }
    const first = divergences[0];
    const extra = divergences.length - 1;
    super(`replay diverged from the fingerprint: ${first}${extra > 0 ? ` (+${extra} more)` : ""}`);
    this.name = "ReplayDivergenceError";
    this.divergences = Object.freeze([...divergences]);
  }

  /** The earliest divergence, which is the one worth reading. */
  get first() {
    return this.divergences[0];
  }
}

// -- canonical encoding -------------------------------------------------------

const TEXT = new TextEncoder();
// One reusable view: `setFloat64` writes the exact IEEE-754 bits, which is what
// keeps `-0` distinct from `0` and every NaN payload distinct from every other.
const FLOAT = new DataView(new ArrayBuffer(8));

function concatBytes(parts) {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * `<tag><byte length>:<body>`.
 *
 * The length prefix is the member-framing obligation: concatenating member
 * encodings without one makes `["a","bc"]` and `["ab","c"]` identical bytes, and
 * a harness that cannot tell those apart certifies a graph that reshaped its own
 * output.
 */
function frame(tag, body) {
  return concatBytes([TEXT.encode(`${tag}${body.length}:`), body]);
}

/** Lexicographic order over BYTES, not over decoded UTF-16 code units. */
function compareBytes(a, b) {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

// `null` prototype included: `Object.create(null)` is a dictionary, and a
// dictionary is exactly what an `observe()` is expected to return.
function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describe(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  const type = typeof value;
  if (type !== "object" && type !== "function") return type;
  const name = value?.constructor?.name;
  return typeof name === "string" && name !== "" ? name : "[object with no constructor name]";
}

function undefinedEncoding(value, path) {
  return new ReplayEncodingError(
    `${path}: ${describe(value)} has no canonical encoding; observe a plain value, ` +
      "or a mapping/sequence/set of them, instead",
  );
}

function encodeValue(value, path, seen) {
  if (value === null) return frame("n", new Uint8Array(0));

  switch (typeof value) {
    case "boolean":
      return frame("b", TEXT.encode(value ? "1" : "0"));
    // The exact integer. Decimal text inside an `i` frame, so 2^53 is not a
    // ceiling and two adjacent large integers stay two values.
    case "bigint":
      return frame("i", TEXT.encode(value.toString()));
    // The double. A `number` is never tagged `i`, however integral it looks:
    // `1` and `1.0` are one runtime value, and pretending otherwise would make
    // the type-tagging class depend on how the literal was spelled.
    case "number":
      FLOAT.setFloat64(0, value, false);
      return frame("f", new Uint8Array(FLOAT.buffer.slice(0)));
    case "string":
      return frame("s", TEXT.encode(value));
    case "object":
      break;
    default:
      // `undefined`, `function`, `symbol`.
      throw undefinedEncoding(value, path);
  }

  if (seen.has(value)) {
    throw new ReplayEncodingError(
      `${path}: the observed value is cyclic; a cycle has no canonical encoding, and ` +
        "following it would not terminate",
    );
  }
  seen.add(value);
  try {
    if (value instanceof ArrayBuffer) return frame("y", new Uint8Array(value.slice(0)));
    if (ArrayBuffer.isView(value)) {
      const { buffer, byteOffset, byteLength } = value;
      return frame("y", new Uint8Array(buffer.slice(byteOffset, byteOffset + byteLength)));
    }
    if (Array.isArray(value)) {
      // Order PRESERVED: sequence order is part of the value.
      return frame(
        "l",
        concatBytes(value.map((item, index) => encodeValue(item, `${path}[${index}]`, seen))),
      );
    }
    if (value instanceof Set) {
      // Sorted by each member's OWN encoded bytes: iteration order is insertion
      // order in JavaScript, and insertion order is not part of a set's value.
      const members = [...value].map((item, index) => encodeValue(item, `${path}{${index}}`, seen));
      members.sort(compareBytes);
      return frame("t", concatBytes(members));
    }
    if (value instanceof Map || isPlainObject(value)) {
      // A `Map` and a plain object are both mappings here, deliberately: an
      // `observe()` returns whichever the graph finds natural, and the labelled
      // contents are the value either way.
      const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
      const encoded = entries.map(([key, item]) =>
        concatBytes([
          encodeValue(key, `${path}[key]`, seen),
          encodeValue(item, `${path}[${String(key)}]`, seen),
        ]),
      );
      // Sorted by encoded bytes: property/insertion order is not part of the
      // value, and mixed-type keys have no other mutual order.
      encoded.sort(compareBytes);
      return frame("m", concatBytes(encoded));
    }
    throw undefinedEncoding(value, path);
  } finally {
    seen.delete(value);
  }
}

/**
 * Encode `value` to type-tagged, length-framed, order-stable bytes.
 *
 * Mapping and set members are ordered by their own encoded bytes, so property
 * order and insertion order do not change the result. Anything without a defined
 * encoding throws `ReplayEncodingError` rather than degrading to a host default.
 */
export function canonicalBytes(value) {
  return encodeValue(value, "value", new Set());
}

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

/**
 * The default digest: the canonical bytes themselves, hex encoded.
 *
 * Injective, so it has no collisions rather than improbable ones, and it costs
 * no dependency. See the module header for when to pass your own instead.
 */
export function identityDigest(bytes) {
  let out = "";
  for (const byte of bytes) out += HEX[byte];
  return out;
}

/** The digest of `canonicalBytes(value)` under `digest` (default injective). */
export function canonicalDigest(value, digest = identityDigest) {
  return digest(canonicalBytes(value));
}

function checkDigestFn(digest) {
  if (typeof digest !== "function") {
    throw new TypeError(`digest must be a function (Uint8Array) => string, got ${typeof digest}`);
  }
  return digest;
}

function preview(value) {
  let text;
  try {
    text = typeof value === "string" ? JSON.stringify(value) : String(value);
  } catch {
    return `<unrenderable ${describe(value)}>`;
  }
  if (typeof value === "bigint") text += "n";
  return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT - 1)}…` : text;
}

// -- the log ------------------------------------------------------------------

/** One entry of an ordered event log. */
export class ReplayEvent {
  constructor(seq, name, payload = null) {
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new RangeError(`event seq must be a non-negative safe integer, got ${String(seq)}`);
    }
    if (typeof name !== "string" || name === "") {
      throw new TypeError("event name must be a non-empty string");
    }
    this.seq = seq;
    this.name = name;
    this.payload = payload;
    Object.freeze(this);
  }
}

/**
 * An ordered event log with a digest over its canonical bytes.
 *
 * Sequence numbers must strictly increase; they do NOT have to be contiguous,
 * because an ack-truncated durable outbox replays real epochs and renumbering
 * them would hide a truncated prefix that the log digest otherwise catches.
 */
export class ReplayLog {
  constructor(events, { digest = identityDigest } = {}) {
    const list = [...events];
    let previous = null;
    for (const event of list) {
      if (!(event instanceof ReplayEvent)) {
        throw new TypeError("every entry of a ReplayLog must be a ReplayEvent");
      }
      if (previous !== null && event.seq <= previous) {
        throw new RangeError(
          `event log must be strictly increasing in seq, got ${event.seq} after ${previous}`,
        );
      }
      previous = event.seq;
    }
    this.events = Object.freeze(list);
    // Digested as PLAIN data, never as class instances: the encoder's domain is
    // plain values on purpose, so a class can never be fingerprinted by
    // accident. `seq` goes in as a bigint because it is an integer by contract.
    this.digest = canonicalDigest(
      list.map((event) => ({ seq: BigInt(event.seq), name: event.name, payload: event.payload })),
      checkDigestFn(digest),
    );
    Object.freeze(this);
  }

  /** A log from already-numbered events. */
  static of(...events) {
    return new ReplayLog(events);
  }

  /** A log from `[name, payload]` pairs, numbered `0..n-1`. */
  static fromRecords(records, options) {
    return new ReplayLog(
      [...records].map(([name, payload], index) => new ReplayEvent(index, name, payload)),
      options,
    );
  }

  get length() {
    return this.events.length;
  }

  [Symbol.iterator]() {
    return this.events[Symbol.iterator]();
  }
}

/**
 * A `ReplayLog` from a reliable-sync outbox's retained frames.
 *
 * `Outbox.replayFrom` is already the replay source a reconnect drains; this
 * makes it the fingerprinted one too. Outbox epochs become event seqs, so a
 * truncated prefix shows up in the log digest rather than silently shifting
 * every event.
 */
export function replayLogFromOutbox(outbox, { cursor = 0, name = "frame", digest } = {}) {
  if (typeof outbox?.replayFrom !== "function") {
    throw new TypeError("replayLogFromOutbox needs an object with a replayFrom(cursor) method");
  }
  const events = outbox
    .replayFrom(cursor)
    .map(([epoch, message]) => new ReplayEvent(epoch, name, message));
  return digest === undefined ? new ReplayLog(events) : new ReplayLog(events, { digest });
}

// -- the fingerprint ----------------------------------------------------------

function normalizeCells(cells) {
  const list = [...cells].map(([label, digest]) => {
    if (typeof label !== "string") {
      throw new TypeError(`observed cell labels must be strings, got ${describe(label)}`);
    }
    return Object.freeze([label, String(digest)]);
  });
  list.sort((a, b) => (a[0] === b[0] ? 0 : a[0] < b[0] ? -1 : 1));
  return Object.freeze(list);
}

/**
 * Per-cell digests observed after applying events through `seq`.
 *
 * `seq` is `INITIAL_SEQ` for the state before any event was applied.
 */
export class ReplayCheckpoint {
  constructor(seq, cells) {
    this.seq = seq;
    this.cells = normalizeCells(cells);
    Object.freeze(this);
  }

  /** Digest every observed value of a `label -> value` mapping. */
  static of(seq, observed, digest = identityDigest) {
    checkDigestFn(digest);
    const entries = observed instanceof Map ? [...observed.entries()] : Object.entries(observed);
    return new ReplayCheckpoint(
      seq,
      entries.map(([label, value]) => [label, canonicalDigest(value, digest)]),
    );
  }

  /** The `label -> digest` mapping. */
  asMap() {
    return new Map(this.cells);
  }

  /** The `label -> digest` mapping as a plain object. */
  asObject() {
    return Object.fromEntries(this.cells);
  }
}

/** A recorded, log-bound observation of a replayed graph. */
export class ReplayFingerprint {
  constructor(logDigest, stride, checkpoints, { digest = identityDigest } = {}) {
    if (!Number.isSafeInteger(stride) || stride < 1) {
      throw new RangeError(`stride must be an integer >= 1, got ${String(stride)}`);
    }
    const list = [...checkpoints];
    if (list.length === 0) {
      throw new RangeError("a fingerprint needs at least the initial checkpoint");
    }
    this.logDigest = String(logDigest);
    this.stride = stride;
    this.checkpoints = Object.freeze(list);
    this.digest = canonicalDigest(
      [
        this.logDigest,
        BigInt(stride),
        list.map((checkpoint) => ({
          seq: BigInt(checkpoint.seq),
          cells: checkpoint.asObject(),
        })),
      ],
      checkDigestFn(digest),
    );
    Object.freeze(this);
  }

  /** The last checkpoint — the end state of the replay. */
  get final() {
    return this.checkpoints[this.checkpoints.length - 1];
  }

  /** A JSON-safe form, so a fingerprint can be committed next to a test. */
  toWire() {
    return {
      schema_version: WIRE_SCHEMA_VERSION,
      log_digest: this.logDigest,
      stride: this.stride,
      checkpoints: this.checkpoints.map((checkpoint) => ({
        seq: checkpoint.seq,
        cells: checkpoint.asObject(),
      })),
    };
  }

  /** Rebuild from `toWire`, refusing an unknown schema version. */
  static fromWire(wire, options) {
    const version = wire?.schema_version;
    if (version !== WIRE_SCHEMA_VERSION) {
      throw new ReplayProofError(
        `unsupported replay fingerprint schema_version ${JSON.stringify(version)}, ` +
          `expected ${WIRE_SCHEMA_VERSION}`,
      );
    }
    const checkpoints = wire.checkpoints.map(
      (checkpoint) =>
        new ReplayCheckpoint(Number(checkpoint.seq), Object.entries(checkpoint.cells)),
    );
    return new ReplayFingerprint(
      String(wire.log_digest),
      Number(wire.stride),
      checkpoints,
      options,
    );
  }
}

/** One cell that did not replay to its recorded digest. */
export class ReplayDivergence {
  constructor(seq, label, kind, expected, actual, observedPreview = null) {
    this.seq = seq;
    this.label = label;
    // "value" | "missing" | "unexpected" — routed on, never parsed back out of
    // the rendered message.
    this.kind = kind;
    this.expected = expected;
    this.actual = actual;
    this.preview = observedPreview;
    Object.freeze(this);
  }

  toString() {
    const where = this.seq === INITIAL_SEQ ? "initial state" : `event seq=${this.seq}`;
    if (this.kind === "missing") {
      return `${where}: cell '${this.label}' was not observed on replay`;
    }
    if (this.kind === "unexpected") {
      return `${where}: cell '${this.label}' appeared on replay but is not in the fingerprint`;
    }
    const seen = this.preview === null ? "" : `, observed ${this.preview}`;
    return `${where}: cell '${this.label}' expected ${this.expected} but replayed ${this.actual}${seen}`;
  }
}

// -- the harness --------------------------------------------------------------

/**
 * Rebuild a graph from an event log and prove it replays identically.
 *
 * `build` is called once per replay and MUST return a FRESH graph exposing
 * `apply(event)` and `observe()`. A harness that reuses one instance proves
 * nothing: the state it would compare against is the state it already has.
 *
 * `stride` checkpoints every `stride`-th event; the initial state and the final
 * state are always checkpointed. It is recorded in the fingerprint, so a
 * fingerprint can never be compared against a replay that sampled differently.
 */
export class ReplayHarness {
  constructor(build, { stride = 1, digest = identityDigest } = {}) {
    if (typeof build !== "function") {
      throw new TypeError("ReplayHarness needs a build function returning a fresh graph");
    }
    if (!Number.isSafeInteger(stride) || stride < 1) {
      throw new RangeError(`stride must be an integer >= 1, got ${String(stride)}`);
    }
    this.stride = stride;
    this.digest = checkDigestFn(digest);
    this.build = build;
    Object.freeze(this);
  }

  /** Replay `log` once and record what the graph observed. */
  record(log) {
    return this.replayOnce(log).fingerprint;
  }

  /**
   * Replay `log` and RETURN the divergences from `fingerprint`.
   *
   * Non-raising for value divergence, so a caller can report all of them. Still
   * throws `ReplayLogMismatchError` for a fingerprint recorded against a
   * different log and `ReplayStrideMismatchError` for one recorded at a
   * different stride: a stale fingerprint is an unanswerable question, not a
   * report, and comparing it anyway would blame the graph for a test artifact.
   */
  check(log, fingerprint) {
    const { fingerprint: replayed, observed } = this.replayOnce(log);
    revalidate(fingerprint, replayed);
    return compare(fingerprint, replayed, observed);
  }

  /**
   * Replay `log` and throw unless it matches `fingerprint` exactly.
   *
   * Returns the freshly recorded fingerprint, which equals `fingerprint`.
   */
  verify(log, fingerprint) {
    const { fingerprint: replayed, observed } = this.replayOnce(log);
    revalidate(fingerprint, replayed);
    const divergences = compare(fingerprint, replayed, observed);
    if (divergences.length > 0) throw new ReplayDivergenceError(divergences);
    return replayed;
  }

  /**
   * Record `log` and re-replay it, throwing on any divergence.
   *
   * The self-check: no external fingerprint is needed to catch a graph that is
   * not a pure function of its log, because two replays of the same log in the
   * same process already disagree.
   */
  prove(log, { replays = 2 } = {}) {
    if (!Number.isSafeInteger(replays) || replays < 2) {
      throw new RangeError(`prove needs at least 2 replays to compare, got ${String(replays)}`);
    }
    const fingerprint = this.record(log);
    for (let i = 1; i < replays; i += 1) this.verify(log, fingerprint);
    return fingerprint;
  }

  /**
   * One replay: a fresh graph, its checkpoints, and the raw values behind them.
   *
   * The raw values are kept only so a divergence can carry a preview of what was
   * actually observed; nothing compares them.
   */
  replayOnce(log) {
    if (!(log instanceof ReplayLog)) {
      throw new TypeError("ReplayHarness needs a ReplayLog, so the replay carries a log digest");
    }
    const graph = this.build();
    if (typeof graph?.apply !== "function" || typeof graph?.observe !== "function") {
      throw new TypeError("build() must return a graph exposing apply(event) and observe()");
    }
    const observed = [];
    const checkpoints = [];
    const sample = (seq) => {
      const values = graph.observe();
      if (values === null || typeof values !== "object") {
        throw new TypeError(
          `observe() must return a label -> value mapping, got ${describe(values)}`,
        );
      }
      observed.push(values instanceof Map ? new Map(values) : { ...values });
      checkpoints.push(ReplayCheckpoint.of(seq, values, this.digest));
    };

    sample(INITIAL_SEQ);
    const total = log.length;
    let index = 0;
    for (const event of log) {
      graph.apply(event);
      index += 1;
      if (index % this.stride === 0 || index === total) sample(event.seq);
    }
    const fingerprint = new ReplayFingerprint(log.digest, this.stride, checkpoints, {
      digest: this.digest,
    });
    return { fingerprint, observed };
  }
}

/** Bind the fingerprint to these exact log bytes and this stride, before anything else. */
function revalidate(fingerprint, replayed) {
  if (!(fingerprint instanceof ReplayFingerprint)) {
    throw new TypeError("expected a ReplayFingerprint to verify against");
  }
  if (fingerprint.logDigest !== replayed.logDigest) {
    throw new ReplayLogMismatchError(fingerprint.logDigest, replayed.logDigest);
  }
  if (fingerprint.stride !== replayed.stride) {
    throw new ReplayStrideMismatchError(fingerprint.stride, replayed.stride);
  }
}

function readObserved(sampled, label) {
  if (sampled instanceof Map) return sampled.has(label) ? preview(sampled.get(label)) : null;
  if (sampled === undefined || sampled === null) return null;
  return label in sampled ? preview(sampled[label]) : null;
}

function compare(expected, actual, observed) {
  const divergences = [];
  const pairs = Math.min(expected.checkpoints.length, actual.checkpoints.length);
  for (let index = 0; index < pairs; index += 1) {
    const want = expected.checkpoints[index];
    const got = actual.checkpoints[index];
    const wantCells = want.asMap();
    const gotCells = got.asMap();
    const labels = [...new Set([...wantCells.keys(), ...gotCells.keys()])].sort();
    for (const label of labels) {
      const wantDigest = wantCells.get(label);
      const gotDigest = gotCells.get(label);
      if (wantDigest === gotDigest) continue;
      const kind =
        gotDigest === undefined ? "missing" : wantDigest === undefined ? "unexpected" : "value";
      divergences.push(
        new ReplayDivergence(
          want.seq,
          label,
          kind,
          wantDigest ?? null,
          gotDigest ?? null,
          readObserved(observed[index], label),
        ),
      );
    }
    // The FIRST diverging checkpoint is the actionable one; later ones are
    // almost always the same defect carried forward, and the contract lets them
    // be omitted from the report.
    if (divergences.length > 0) break;
  }
  if (divergences.length === 0 && expected.checkpoints.length !== actual.checkpoints.length) {
    // Same log digest and same stride, so this cannot come from sampling — it
    // means `observe` or `apply` changed the checkpoint count.
    throw new ReplayProofError(
      `fingerprint has ${expected.checkpoints.length} checkpoints but the replay produced ` +
        `${actual.checkpoints.length} for the same log`,
    );
  }
  return divergences;
}
