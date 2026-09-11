// `src/replay.js` — the library surface the canonical corpus does not reach
// (`#lzreplayjs`).
//
// The three corpus fixtures prove the three contract obligations. What they
// cannot reach is everything a fixture has no vocabulary for: the wire form, the
// outbox bridge, the graph-shape refusals, and the JavaScript-specific corners
// of the encoding (cycles, `undefined`, `-0`, NaN, typed arrays, non-BMP keys).
// Those are here.
import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIAL_SEQ,
  ReplayCheckpoint,
  ReplayDivergenceError,
  ReplayEncodingError,
  ReplayEvent,
  ReplayFingerprint,
  ReplayHarness,
  ReplayLog,
  ReplayLogMismatchError,
  ReplayProofError,
  ReplayStrideMismatchError,
  canonicalBytes,
  canonicalDigest,
  identityDigest,
  replayLogFromOutbox,
} from "../src/replay.js";

/** `assert.throws` returns undefined, and these tests inspect the error's fields. */
function caught(run, type) {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof type, `expected ${type.name}, got ${error}`);
    return error;
  }
  throw new assert.AssertionError({ message: `expected ${type.name}, nothing was thrown` });
}

class Counter {
  constructor(extra = 0n) {
    this.total = 0n;
    this.extra = extra;
  }
  apply(event) {
    this.total += BigInt(event.payload) + this.extra;
  }
  observe() {
    return { total: this.total };
  }
}

const addLog = () =>
  ReplayLog.fromRecords([
    ["add", 1],
    ["add", 2],
    ["add", 3],
  ]);

// -- the log ------------------------------------------------------------------

test("a log's seqs must strictly increase, and may be non-contiguous", () => {
  // Non-contiguous is the ack-truncated outbox case: real epochs, kept as they
  // are so a truncated prefix shows up in the digest instead of being renumbered
  // away.
  const sparse = ReplayLog.of(new ReplayEvent(4, "add", 1), new ReplayEvent(9, "add", 2));
  assert.deepEqual(
    [...sparse].map((event) => event.seq),
    [4, 9],
  );
  assert.throws(
    () => ReplayLog.of(new ReplayEvent(2, "add", 1), new ReplayEvent(2, "add", 2)),
    RangeError,
  );
  assert.throws(() => new ReplayEvent(-1, "add", 1), RangeError);
  assert.throws(() => new ReplayEvent(0, "", 1), TypeError);
});

test("the log digest covers order, names and payloads", () => {
  const forward = ReplayLog.fromRecords([
    ["add", 1],
    ["add", 2],
    ["add", 3],
  ]);
  const reversed = ReplayLog.fromRecords([
    ["add", 3],
    ["add", 2],
    ["add", 1],
  ]);
  // The case a value-only comparison would wrongly accept: both sum to 6.
  assert.notEqual(forward.digest, reversed.digest);
  assert.notEqual(
    forward.digest,
    ReplayLog.fromRecords([
      ["sub", 1],
      ["add", 2],
      ["add", 3],
    ]).digest,
  );
  assert.equal(
    forward.digest,
    ReplayLog.fromRecords([
      ["add", 1],
      ["add", 2],
      ["add", 3],
    ]).digest,
  );
});

test("a log can be built from an outbox's retained frames", () => {
  const outbox = {
    replayFrom: (cursor) => [
      [cursor + 1, "a"],
      [cursor + 4, "b"],
    ],
  };
  const log = replayLogFromOutbox(outbox, { cursor: 3, name: "frame" });
  assert.deepEqual(
    [...log].map((event) => [event.seq, event.name, event.payload]),
    [
      [4, "frame", "a"],
      [7, "frame", "b"],
    ],
  );
  // The epochs are the seqs, so a different cursor is a different log.
  assert.notEqual(log.digest, replayLogFromOutbox(outbox, { cursor: 0 }).digest);
  assert.throws(() => replayLogFromOutbox({}), TypeError);
});

// -- the harness --------------------------------------------------------------

test("record checkpoints the initial state and every event", () => {
  const harness = new ReplayHarness(() => new Counter());
  const fingerprint = harness.record(addLog());
  assert.deepEqual(
    fingerprint.checkpoints.map((checkpoint) => checkpoint.seq),
    [INITIAL_SEQ, 0, 1, 2],
  );
  assert.equal(fingerprint.stride, 1);
  assert.equal(fingerprint.final.asMap().get("total"), canonicalDigest(6n));
  assert.equal(harness.verify(addLog(), fingerprint).digest, fingerprint.digest);
});

test("a coarser stride still checkpoints the initial and final states", () => {
  const log = ReplayLog.fromRecords([
    ["a", 1],
    ["a", 2],
    ["a", 3],
    ["a", 4],
    ["a", 5],
  ]);
  const fingerprint = new ReplayHarness(() => new Counter(), { stride: 2 }).record(log);
  assert.deepEqual(
    fingerprint.checkpoints.map((checkpoint) => checkpoint.seq),
    [INITIAL_SEQ, 1, 3, 4],
  );
});

test("the log binding is revalidated before any value is compared", () => {
  const forward = ReplayLog.fromRecords([
    ["add", 1],
    ["add", 2],
    ["add", 3],
  ]);
  const reversed = ReplayLog.fromRecords([
    ["add", 3],
    ["add", 2],
    ["add", 1],
  ]);
  const harness = new ReplayHarness(() => new Counter());
  const fingerprint = harness.record(forward);

  // Every checkpoint VALUE happens to differ here (1,3,6 vs 3,5,6), so a harness
  // that compared first and revalidated second would report a divergence and
  // blame the graph for a stale artifact.
  const error = caught(() => harness.verify(reversed, fingerprint), ReplayLogMismatchError);
  assert.equal(error.expectedDigest, forward.digest);
  assert.equal(error.actualDigest, reversed.digest);
  // The reporting form refuses it too.
  assert.throws(() => harness.check(reversed, fingerprint), ReplayLogMismatchError);
});

test("a fingerprint is bound to the stride it was sampled at", () => {
  const log = addLog();
  const sparse = new ReplayHarness(() => new Counter(), { stride: 2 }).record(log);
  const dense = new ReplayHarness(() => new Counter());
  const error = caught(() => dense.verify(log, sparse), ReplayStrideMismatchError);
  assert.equal(error.expectedStride, 2);
  assert.equal(error.actualStride, 1);
  assert.throws(() => dense.check(log, sparse), ReplayStrideMismatchError);
});

test("a divergence names the first checkpoint and the cell, and check() collects", () => {
  const log = addLog();
  const clean = new ReplayHarness(() => new Counter()).record(log);
  const drifting = new ReplayHarness(() => new Counter(100n));

  const error = caught(() => drifting.verify(log, clean), ReplayDivergenceError);
  assert.equal(error.first.seq, 0);
  assert.equal(error.first.label, "total");
  assert.equal(error.first.kind, "value");
  // The preview carries what was really observed, so the failure is readable
  // without re-running under a debugger.
  assert.equal(error.first.preview, "101n");
  assert.match(String(error.first), /event seq=0: cell 'total'/);

  // Later checkpoints are the same defect carried forward and are omitted.
  const divergences = drifting.check(log, clean);
  assert.equal(divergences.length, 1);
  assert.equal(divergences[0].seq, 0);
});

test("a label that appears or vanishes on replay is its own divergence kind", () => {
  const log = ReplayLog.fromRecords([["add", 1]]);
  const both = new ReplayHarness(() => ({
    apply() {},
    observe: () => ({ a: 1n, b: 2n }),
  })).record(log);
  const onlyA = new ReplayHarness(() => ({ apply() {}, observe: () => ({ a: 1n }) }));
  assert.equal(onlyA.check(log, both)[0].kind, "missing");

  const fromA = new ReplayHarness(() => ({ apply() {}, observe: () => ({ a: 1n }) })).record(log);
  const bothAgain = new ReplayHarness(() => ({
    apply() {},
    observe: () => ({ a: 1n, b: 2n }),
  }));
  assert.equal(bothAgain.check(log, fromA)[0].kind, "unexpected");
});

test("prove catches a graph that is not a pure function of its log", () => {
  const log = addLog();
  assert.doesNotThrow(() => new ReplayHarness(() => new Counter()).prove(log));

  // The whole point of rebuilding: a harness that reused one instance would
  // compare the state it already has against itself and never see this.
  let calls = 0;
  const impure = new ReplayHarness(() => {
    calls += 1;
    return new Counter(BigInt(calls));
  });
  assert.throws(() => impure.prove(log), ReplayDivergenceError);
  assert.throws(
    () => new ReplayHarness(() => new Counter()).prove(log, { replays: 1 }),
    RangeError,
  );
});

test("the harness refuses a build or an observe it cannot fingerprint", () => {
  assert.throws(() => new ReplayHarness(null), TypeError);
  assert.throws(() => new ReplayHarness(() => new Counter(), { stride: 0 }), RangeError);
  assert.throws(() => new ReplayHarness(() => new Counter()).record([]), TypeError);
  assert.throws(() => new ReplayHarness(() => ({ apply() {} })).record(addLog()), TypeError);
  assert.throws(
    () => new ReplayHarness(() => ({ apply() {}, observe: () => 7 })).record(addLog()),
    TypeError,
  );
  // A graph whose observation has no canonical encoding fails loudly rather than
  // fingerprinting `[object Object]`.
  assert.throws(
    () =>
      new ReplayHarness(() => ({ apply() {}, observe: () => ({ v: new Date(0) }) })).record(
        addLog(),
      ),
    ReplayEncodingError,
  );
});

test("a checkpoint count that changed for the same log is a proof error, not a divergence", () => {
  const log = addLog();
  const fingerprint = new ReplayHarness(() => new Counter()).record(log);
  const truncated = new ReplayFingerprint(
    fingerprint.logDigest,
    fingerprint.stride,
    fingerprint.checkpoints.slice(0, 2),
  );
  assert.throws(
    () => new ReplayHarness(() => new Counter()).check(log, truncated),
    (error) => error instanceof ReplayProofError && /checkpoints/.test(error.message),
  );
});

// -- the wire form ------------------------------------------------------------

test("a fingerprint round-trips through its JSON-safe wire form", () => {
  const fingerprint = new ReplayHarness(() => new Counter(), { stride: 2 }).record(addLog());
  const wire = JSON.parse(JSON.stringify(fingerprint.toWire()));
  const rebuilt = ReplayFingerprint.fromWire(wire);
  assert.equal(rebuilt.digest, fingerprint.digest);
  assert.equal(rebuilt.logDigest, fingerprint.logDigest);
  assert.equal(rebuilt.stride, 2);
  assert.doesNotThrow(() =>
    new ReplayHarness(() => new Counter(), { stride: 2 }).verify(addLog(), rebuilt),
  );
  assert.throws(
    () => ReplayFingerprint.fromWire({ ...wire, schema_version: 99 }),
    ReplayProofError,
  );
});

test("a fingerprint needs at least the initial checkpoint", () => {
  assert.throws(() => new ReplayFingerprint("d", 1, []), RangeError);
  assert.throws(() => new ReplayFingerprint("d", 0, [new ReplayCheckpoint(-1, [])]), RangeError);
  assert.throws(() => new ReplayCheckpoint(-1, [[1, "d"]]), TypeError);
});

// -- the canonical encoding ---------------------------------------------------

const toPlain = (event) => ({ seq: BigInt(event.seq), name: event.name, payload: event.payload });

test("the digest is pluggable, and a mixed digest cannot silently pass", () => {
  const short = (bytes) => String(bytes.length);
  const log = new ReplayLog([...addLog()], { digest: short });
  assert.equal(log.digest, String(canonicalBytes([...addLog()].map(toPlain)).length));
  // The real claim: a fingerprint recorded under one digest and verified under
  // another is refused as a LOG mismatch, because the log digest moved too.
  const recorded = new ReplayHarness(() => new Counter(), { digest: short }).record(log);
  assert.throws(
    () => new ReplayHarness(() => new Counter()).verify(addLog(), recorded),
    ReplayLogMismatchError,
  );
  assert.throws(() => new ReplayHarness(() => new Counter(), { digest: 7 }), TypeError);
});

test("a mapping's property order and a set's insertion order are not part of the value", () => {
  assert.equal(canonicalDigest({ a: 1n, b: 2n }), canonicalDigest({ b: 2n, a: 1n }));
  assert.equal(canonicalDigest(new Set([1n, 2n, 3n])), canonicalDigest(new Set([3n, 1n, 2n])));
  // A Map and a plain object are the same mapping, deliberately: an `observe()`
  // returns whichever the graph finds natural.
  assert.equal(canonicalDigest(new Map([["a", 1n]])), canonicalDigest({ a: 1n }));
  assert.notEqual(canonicalDigest([1n, 2n]), canonicalDigest([2n, 1n]));
});

test("members are framed, so a concatenation is never ambiguous", () => {
  // These two rows assert the equality CLASS the corpus pins, and nothing more:
  // every member carries a type tag, so `s1:a` + `s2:bc` and `s2:ab` + `s1:c`
  // already differ as byte strings BEFORE the length is consulted. An encoder
  // that emitted `<tag><body>` with no length at all would pass both of them.
  // This binding ran exactly that mutation during the phase-2 rollout, watched
  // it survive, and wrongly filed it benign because "the tag still delimits".
  assert.notEqual(canonicalDigest(["a", "bc"]), canonicalDigest(["ab", "c"]));
  assert.notEqual(canonicalDigest({ a: "", bc: "" }), canonicalDigest({ ab: "", c: "" }));

  // The rows that actually pin the LENGTH (#lzreplayframing). A colliding pair
  // is layout-specific, so it can only be written against a known byte layout,
  // and only this repo knows this binding's. `frame()` in src/replay.js emits
  // `<tag><decimal byte length>:<body>` with the string tag `s`, the sequence
  // tag `l` and the mapping tag `m` — that IS the reference layout the corpus
  // describes, so the corpus's own pairs are this binding's pairs too and are
  // reproduced here rather than replaced.
  //
  // Strip the `<length>:` and the bytes below collide outright:
  //   ["a","sbc"] -> "sa" + "ssbc" == "sas" + "sbc" <- ["as","bc"]
  // The first member's content SPELLS the second member's tag, so the tag stops
  // being a boundary and only the length separates them.
  assert.notEqual(canonicalDigest(["a", "sbc"]), canonicalDigest(["as", "bc"]));
  // The mapping analogue: a key is framed apart from its value, so the same
  // spelled-tag trick must not slide the boundary between them.
  //   {"a":"sb"} -> "sa" + "ssb" == "sas" + "sb" <- {"as":"b"}
  assert.notEqual(canonicalDigest({ a: "sb" }), canonicalDigest({ as: "b" }));
  // The layout-INDEPENDENT one: a nested container boundary has no tag to hide
  // behind, so this pair collides under ANY unframed concatenation, whatever
  // the tag bytes are.
  //   [["a"],"b"] -> "l" + ("l" + "sa") + "sb" == "l" + ("l" + "sa" + "sb") <- [["a","b"]]
  assert.notEqual(canonicalDigest([["a"], "b"]), canonicalDigest([["a", "b"]]));
});

test("bigint is the integer and number is the double", () => {
  // The five classes the family agrees on.
  const one = [1n, "1", 1, true, Uint8Array.of(0x31)].map((value) => canonicalDigest(value));
  assert.equal(new Set(one).size, 5);
  // Exactness past 2^53 — the reason the corpus carries integers as strings.
  assert.notEqual(canonicalDigest(9007199254740992n), canonicalDigest(9007199254740993n));
  // ... and the trap that costs: as doubles those two are ONE value, because
  // `9007199254740993` is not representable and rounds to its even neighbour.
  assert.equal(canonicalDigest(9007199254740992), canonicalDigest(9007199254740993));
  // The float encoding is the exact bits, so these stay apart.
  assert.notEqual(canonicalDigest(0), canonicalDigest(-0));
  assert.equal(canonicalDigest(Number.NaN), canonicalDigest(Number.NaN));
  assert.notEqual(canonicalDigest(Infinity), canonicalDigest(-Infinity));
});

test("bytes are bytes however they are viewed, and never text", () => {
  const bytes = Uint8Array.of(1, 2, 3);
  assert.equal(canonicalDigest(bytes), canonicalDigest(bytes.buffer));
  assert.equal(canonicalDigest(bytes), canonicalDigest(new DataView(bytes.buffer)));
  // A view into a larger buffer encodes its own window, not the whole buffer.
  const wide = Uint8Array.of(9, 1, 2, 3, 9);
  assert.equal(canonicalDigest(wide.subarray(1, 4)), canonicalDigest(bytes));
  assert.notEqual(canonicalDigest(Uint8Array.of(0x31)), canonicalDigest("1"));
});

test("members are ordered by UTF-8 BYTES, not by UTF-16 code units", () => {
  // Both keys encode to exactly four UTF-8 bytes, so the length prefix cannot
  // decide the order and the character bytes must. As UTF-16 code units
  // "\u{10000}" sorts FIRST (its lead surrogate is 0xD800, below 0xFFFD); as
  // UTF-8 bytes it sorts SECOND (0xF0 > 0xEF). Sorting the encoded members is
  // what makes the digest reproducible for any reader that is not a JS engine.
  const astral = "\u{10000}";
  const bmp = "\uFFFDA";
  assert.equal(new TextEncoder().encode(astral).length, new TextEncoder().encode(bmp).length);
  assert.ok(astral < bmp, "UTF-16 code-unit order puts the astral key first");
  assert.equal(
    canonicalDigest({ [astral]: 1n, [bmp]: 2n }),
    canonicalDigest({ [bmp]: 2n, [astral]: 1n }),
  );
  const text = new TextDecoder().decode(canonicalBytes({ [astral]: 1n, [bmp]: 2n }));
  assert.ok(text.indexOf(bmp) < text.indexOf(astral), "UTF-8 byte order puts it second");
});

test("a value the encoding does not define fails loudly", () => {
  class Opaque {}
  for (const value of [undefined, new Opaque(), new Date(0), /x/, () => {}, Symbol("s")]) {
    assert.throws(
      () => canonicalDigest(value),
      ReplayEncodingError,
      `undefined encoding: ${String(value)}`,
    );
  }
  // `undefined` nested inside a mapping is the same refusal: encoding it as
  // `null` would merge `{a: undefined}` with `{a: null}`.
  assert.throws(() => canonicalDigest({ a: undefined }), ReplayEncodingError);
  // A cycle terminates with an error rather than a stack overflow.
  const cyclic = { self: null };
  cyclic.self = cyclic;
  assert.throws(() => canonicalDigest(cyclic), ReplayEncodingError);
  // Repeating a value on two BRANCHES is not a cycle.
  const shared = { v: 1n };
  assert.doesNotThrow(() => canonicalDigest([shared, shared]));
});

test("identityDigest is injective over the canonical bytes", () => {
  const value = { a: [1n, "x"], b: new Set([true]) };
  const hex = identityDigest(canonicalBytes(value));
  assert.match(hex, /^[0-9a-f]+$/);
  assert.equal(hex.length, canonicalBytes(value).length * 2);
  assert.equal(canonicalDigest(value), hex);
});
