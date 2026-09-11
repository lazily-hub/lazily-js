// Replay the canonical replay-equivalence corpus against `src/replay.js`
// (`#lzreplayjs`).
//
// Three fixtures, one obligation each
// (`lazily-spec/docs/replay-equivalence.md`): the fingerprint is bound to its
// log and that binding is revalidated before any value compare; a divergence is
// reported at the first checkpoint where the values parted; the observation
// encoding agrees with the family on which differences are differences.
//
// The corpus declares its subjects in PROSE, because a JSON fixture cannot carry
// a reactive graph. `Accumulator` below is this binding's copy of that
// declaration, kept to the letter — including that `observe` exposes `sum` and
// `names` under exactly those labels.
//
// `sum` is a bigint here and not a number. The corpus calls it "a signed
// integer", and in JavaScript the only exact integer is `BigInt`: a `number` is
// an IEEE-754 double, so it is the float class of the encoding's type-tagging
// table and it loses exactness past 2^53. Carrying the subject's state in the
// type the contract names is also what makes the `record` cross-check below
// mean something — it compares the recorded digest against the digest of the
// value the subject really ends on, in the representation it really holds.
import assert from "node:assert/strict";
import test from "node:test";

import { assertKey, assertKeyWith } from "./support/assert-key.js";

import {
  ReplayDivergenceError,
  ReplayEncodingError,
  ReplayEvent,
  ReplayHarness,
  ReplayLog,
  ReplayLogMismatchError,
  ReplayStrideMismatchError,
  canonicalDigest,
} from "../src/replay.js";

import { loadFixture } from "./spec-corpus.cjs";

function load(name) {
  const fixture = loadFixture("replay", name);
  assert.equal(fixture.kind, "Replay", `${name}: kind`);
  return fixture;
}

/**
 * Consume a step's `note`.
 *
 * It is prose: it names the property the step's executable keys already encode,
 * so there is nothing to compare an observation against and comparing the text
 * itself would pin a copy-edit rather than behaviour. Read here so it cannot sit
 * in the block hiding a key that DOES carry an assertion (#lzassertunknownkeys).
 */
function consumeNote(expected, where) {
  if (!("note" in expected)) return;
  assertKeyWith(expected, "note", (want) => {
    assert.equal(typeof want, "string", `${where}: note is prose`);
  });
}

// -- the corpus's canonical subjects ------------------------------------------

/** `accumulator`, and `drifting_accumulator` when a drift is configured. */
class Accumulator {
  constructor({ driftAt = null, drift = 0 } = {}) {
    this.sum = 0n;
    this.names = [];
    this.driftAt = driftAt;
    this.drift = BigInt(drift);
  }

  apply(event) {
    this.sum += BigInt(event.payload);
    this.names.push(event.name);
    // The one thing a replay proof is looking for: a value taken from outside
    // the log. `drift = 0` is the honest run.
    if (this.driftAt !== null && event.seq === this.driftAt) this.sum += this.drift;
  }

  observe() {
    return { sum: this.sum, names: [...this.names] };
  }
}

function logOf(entries) {
  return new ReplayLog(
    entries.map((entry) => new ReplayEvent(entry.seq, entry.name, entry.payload)),
  );
}

function buildFor(config, op) {
  if (config.subject === "accumulator") return () => new Accumulator();
  if (config.subject === "drifting_accumulator") {
    const driftAt = config.drift_at;
    const drift = op.drift ?? 0;
    return () => new Accumulator({ driftAt, drift });
  }
  throw new Error(`unknown canonical replay subject '${config.subject}'`);
}

/** Drive the subject to the end of the log, outside the harness. */
function finalSumOf(build, log) {
  const subject = build();
  for (const event of log) subject.apply(event);
  return subject.observe().sum;
}

// -- obligations 1 and 2 ------------------------------------------------------

function driveHarnessFixture(name, minimumSteps) {
  const fixture = load(name);
  assert.equal(fixture.model, "ReplayHarness", `${name}: model`);
  const config = fixture.config;
  const logs = new Map(Object.entries(config.logs).map(([key, value]) => [key, logOf(value)]));
  const fingerprints = new Map();
  const steps = fixture.steps;
  assert.ok(steps.length >= minimumSteps, `${name}: expected >= ${minimumSteps} steps`);

  for (const [index, step] of steps.entries()) {
    const op = step.op;
    const where = `${name} step ${index} (${op.type})`;
    const expected = step.expected;

    if (op.type === "log_digest_equal") {
      const actual = logs.get(op.left).digest === logs.get(op.right).digest;
      assert.equal(actual, step.returns, `${where}: returns`);
      consumeNote(expected, where);
      continue;
    }

    const build = buildFor(config, op);
    const stride = op.stride ?? config.stride ?? 1;
    const harness = new ReplayHarness(build, { stride });
    const log = logs.get(op.log);

    if (op.type === "record") {
      const fingerprint = harness.record(log);
      fingerprints.set(op.into, fingerprint);
      assertKey(expected, "outcome", "recorded", where);
      assertKey(
        expected,
        "checkpoint_seqs",
        fingerprint.checkpoints.map((checkpoint) => checkpoint.seq),
        where,
      );
      assertKey(expected, "stride", fingerprint.stride, where);
      const finalSum = finalSumOf(build, log);
      assertKey(expected, "final_sum", Number(finalSum), where);
      // The fingerprint must have observed the value the subject ends ON, not
      // merely some value. Without this the fixture would accept a harness that
      // recorded a digest of something else entirely and still reported the
      // right checkpoint seqs — the digest and the declared state meet in
      // exactly one place, and this is it.
      const finalCells = fingerprint.final.asMap();
      assert.deepEqual(
        [...finalCells.keys()],
        ["names", "sum"],
        `${where}: the subject must observe exactly the corpus's two labels`,
      );
      assert.equal(
        finalCells.get("sum"),
        canonicalDigest(finalSum),
        `${where}: the recorded 'sum' digest is not the digest of the subject's final sum`,
      );
      consumeNote(expected, where);
      continue;
    }

    if (op.type === "prove") {
      harness.prove(log, { replays: op.replays });
      assertKey(expected, "outcome", "ok", where);
      assertKey(expected, "divergences", 0, where);
      consumeNote(expected, where);
      continue;
    }

    const fingerprint = fingerprints.get(op.fingerprint);
    assert.ok(fingerprint !== undefined, `${where}: no fingerprint named '${op.fingerprint}'`);

    if (op.type === "verify") {
      let outcome = "ok";
      let first = null;
      try {
        harness.verify(log, fingerprint);
      } catch (error) {
        // Routed on the TYPE. A driver that matched on the message would pass
        // today and break on a copy-edit, and the four classes exist precisely
        // so it does not have to.
        if (error instanceof ReplayLogMismatchError) outcome = "log_mismatch";
        else if (error instanceof ReplayStrideMismatchError) outcome = "stride_mismatch";
        else if (error instanceof ReplayDivergenceError) {
          outcome = "divergent";
          first = error.first;
        } else throw error;
      }
      assertKey(expected, "outcome", outcome, where);
      if (first === null) {
        assertKey(expected, "divergences", 0, where);
      } else {
        assertKey(expected, "first_divergent_seq", first.seq, where);
        assertKey(expected, "first_divergent_label", first.label, where);
        assertKey(expected, "first_divergent_kind", first.kind, where);
      }
      consumeNote(expected, where);
      continue;
    }

    if (op.type === "check") {
      let divergences = null;
      try {
        divergences = harness.check(log, fingerprint).length;
      } catch (error) {
        // The reporting form collects value divergences instead of failing, but
        // a stale fingerprint is still refused here: an unanswerable question is
        // not a report.
        if (!(error instanceof ReplayLogMismatchError)) throw error;
        assertKey(expected, "outcome", "log_mismatch", where);
        assertKey(expected, "divergences", 0, where);
        consumeNote(expected, where);
        continue;
      }
      assertKey(expected, "outcome", "ok", where);
      assertKey(expected, "divergences", divergences, where);
      consumeNote(expected, where);
      continue;
    }

    throw new Error(`unknown canonical replay operation '${op.type}'`);
  }
}

test("canonical replay: the fingerprint is bound to its log", () => {
  driveHarnessFixture("fingerprint_log_binding.json", 8);
});

test("canonical replay: a divergence is localized to its first checkpoint", () => {
  driveHarnessFixture("divergence_localization.json", 7);
});

// -- obligation 3 -------------------------------------------------------------

/** A value the encoding does not define, as the corpus's `opaque` tag. */
class Opaque {}

function bytesFromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function valueOf(tagged) {
  switch (tagged.t) {
    // A BigInt, never a number: the corpus carries integers as decimal STRINGS
    // so `9007199254740993` survives, and `Number("9007199254740993")` is
    // already `9007199254740992` — the two "adjacent integers" steps would then
    // compare one value with itself and pass with the encoding broken.
    case "int":
      return BigInt(tagged.v);
    case "str":
      return tagged.v;
    case "float":
      return Number(tagged.v);
    case "bool":
      return tagged.v;
    case "bytes":
      return bytesFromHex(tagged.v);
    case "seq":
      return tagged.v.map(valueOf);
    case "set":
      return new Set(tagged.v.map(valueOf));
    case "map":
      return Object.fromEntries(tagged.v.map(([key, item]) => [key, valueOf(item)]));
    case "opaque":
      return new Opaque();
    default:
      throw new Error(`unknown canonical value tag '${tagged.t}'`);
  }
}

test("canonical replay: the observation encoding's equality classes", () => {
  const name = "canonical_encoding_equality.json";
  const fixture = load(name);
  assert.equal(fixture.model, "CanonicalEncoding", `${name}: model`);
  const values = fixture.config.values;
  const steps = fixture.steps;
  assert.ok(steps.length >= 11, `${name}: expected >= 11 steps`);
  const outcomes = new Set();

  for (const [index, step] of steps.entries()) {
    const op = step.op;
    const where = `${name} step ${index} (${op.type})`;

    if (op.type === "digest_equal") {
      const actual =
        canonicalDigest(valueOf(values[op.left])) === canonicalDigest(valueOf(values[op.right]));
      assert.equal(actual, step.returns, `${where}: returns`);
      outcomes.add(actual);
      consumeNote(step.expected, where);
      continue;
    }

    if (op.type === "digest_defined") {
      let defined = true;
      try {
        canonicalDigest(valueOf(values[op.value]));
      } catch (error) {
        if (!(error instanceof ReplayEncodingError)) throw error;
        defined = false;
      }
      assert.equal(defined, step.returns, `${where}: returns`);
      assertKey(step.expected, "outcome", "encoding_error", where);
      consumeNote(step.expected, where);
      continue;
    }

    throw new Error(`unknown canonical encoding operation '${op.type}'`);
  }

  // Both outcomes really occurred. A runner that only ever saw `false` would
  // satisfy every inequality claim in the fixture with a completely broken
  // encoding — every pair unequal is the easiest way to be wrong here.
  assert.deepEqual([...outcomes].sort(), [false, true], `${name}: both outcomes must occur`);
});
