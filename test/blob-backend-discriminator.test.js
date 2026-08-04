// Blob-backend discriminator strictness on decode (#lzblobbackendstrict).
//
// protocol.md § Shared-memory payload path made `backend` optional and gave the
// absence exactly one meaning — `shm` — because that absence IS the
// forward-compatibility channel: every descriptor minted before the field
// existed has that shape. What it left open was the other case, a `backend`
// that is PRESENT and outside the enum, and the family split 5-2 on it. Five
// bindings normalized the unknown token to `shm` and wrote down a forward-compat
// rationale for doing so.
//
// The clause now says the opposite: a present token outside
// {shm, arrow, in_process} MUST be rejected, naming it, and MUST NOT be
// normalized. The reason is the `resolve_wrong_backend` theorem
// (docs/zero-copy-transport.md), which discharges non-resolution STRUCTURALLY by
// routing on kind. Normalizing an unknown kind to `shm` routes the descriptor
// into a table this build really does resolve, so the guarantee degrades from "a
// descriptor of one kind never resolves against another backend" to "a 64-bit
// checksum probably catches it downstream".
//
// lazily-js was already on the strict side of the split, by construction rather
// than by adjudication: `ShmBlobRef`'s constructor throws
// `unknown blob backend: <token>` for anything outside `BLOB_BACKEND_KINDS`, and
// `fromWire` only defaults the ABSENT key. This runner is what holds it there,
// and it pins the two halves a bare rejection assertion cannot see:
//
//   * the ENCODER — `toWire()` must OMIT `backend` when it is `shm` (so a
//     pre-field descriptor round-trips byte-identically) and EMIT it for
//     `arrow` and `in_process`. A decoder that reads the field correctly and
//     echoes whatever it received back out has a correct decoded value and a
//     non-conforming encoder;
//   * the REASON — the thrown error must name `rdma`. A decoder that refuses the
//     frame because it mis-parsed `checksum` satisfies "an error was thrown"
//     while implementing none of the clause.
//
// FIXTURE v2 (14 scenarios, seven wire shapes x two codecs) adds four facts v1
// declared or implied without carrying, and each lands somewhere different here:
//
//   * `in_process` — the THIRD declared backend. v1 carried scenarios for two of
//     the three names in `assertions.backends`, so a binding knowing only
//     {shm, arrow} refused `in_process` NAMING THE TOKEN, conformingly by the
//     letter of the clause, and passed all eight scenarios with a smaller enum
//     than the clause declares. The scenario is necessary and not sufficient:
//     the assertion that closes the hole is the set difference at the bottom of
//     this file — every backend in `assertions.backends` must turn up as the
//     `decoded_backend` of some accept scenario — because a scenario count
//     cannot reach it and neither can any per-scenario assertion.
//   * an explicit `null` — the ABSENT form, not a present-unknown one
//     (`#lzkeynullstrict`), because a serde-style peer that skipped
//     `skip_serializing_if` emits null where a conforming encoder omits. In
//     JavaScript this is the easiest of the four to get accidentally right and
//     accidentally wrong at once: `object.backend ?? Shm` treats `null` and
//     `undefined` identically, so the ACCEPT half is free, while nothing in the
//     language distinguishes "the frame carried an explicit null" from "the
//     frame carried no key" once the value is in hand. So this runner reads the
//     raw wire alongside the decode and asserts the two forms really are
//     different on the wire (`wireBackend` below) — otherwise the null scenarios
//     are the omitted scenarios wearing a different `id`.
//   * a NON-STRING `backend` (the integer 7) — the same refusal reached through
//     a door the clause, written entirely about tokens, does not describe. JS
//     coerces enthusiastically: `String(7)`, a `==` comparison, or an
//     `Array.includes` after a `.toString()` would all quietly turn 7 into
//     something a lenient reader accepts. `BLOB_BACKEND_KINDS.has(7)` does not,
//     because `Set.has` is SameValueZero — verified by running the frame rather
//     than by reading the line.
//   * `frame_epoch` vs `blob_epoch` — v1 carried 9 in the Delta AND in the
//     descriptor, so one `expect.epoch` could not tell a runner reading the
//     frame's epoch from one reading the blob's. They are now 9 and 5, they are
//     asserted against different sources, and `epochsDistinct` counts the runs
//     where the two observations really differed.
//
// The decode-error FAMILY, `rejection_is_decode_error`. This binding's decode
// path refuses structurally malformed frames with `TypeError` and nothing else:
// `assertObject`, `assertTagged`, `assertInteger`, the unknown-variant arm of
// `IpcMessage.fromWire` and the unknown-backend arm of `ShmBlobRef` all throw it,
// so `catch (e) { if (e instanceof TypeError) … }` is the one guard a caller
// wraps a decode in. A refusal raised outside that family still refuses the
// frame and still fails PAST every such handler, which is why the fixture
// asserts the family and not merely that something was thrown. `instanceof`
// alone is a weak instrument in a language where a stray property access on
// `undefined` also throws `TypeError`, so it is paired with the attribution
// control below: the same frame with a conforming token in the same slot must
// DECODE, which is what makes the refusal attributable to `backend` rather than
// to anything else in the descriptor. That control is the non-string form's
// analogue of `error_names_token`, which cannot apply where there is no token.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assertKey,
  assertKeyWith,
  fnv1a64Hex,
  proseKey,
  verifyProse,
} from "./support/assert-key.js";
import { scenarios } from "./support/scenario.js";

import {
  BlobBackendKind,
  Codec,
  DeltaOpSlotValue,
  IpcMessage,
  IpcValueSharedBlob,
  ShmBlobRef,
  decodeMsgpackValue,
  encodeMsgpackValue,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const specFixtures = join(here, "..", "..", "lazily-spec", "conformance");

const FIXTURE = "codec/blob_backend_discriminator.json";

// This binding's documented decode-error family (see the header note). Named
// here so the fixture's `rejection_is_decode_error` compares against something a
// reader can find, rather than an `instanceof TypeError` buried in an arm.
const DecodeError = TypeError;

function loadFixture() {
  const path = join(specFixtures, FIXTURE);
  assert.ok(
    existsSync(path),
    `missing canonical spec fixture ${path} — clone the lazily-spec sibling ` +
      `(git clone https://github.com/lazily-hub/lazily-spec.git ../lazily-spec)`,
  );
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(fixture.protocol_version, 1);
  assert.equal(fixture.kind, "BlobBackendDiscriminator");
  return fixture;
}

function hexToBytes(hex) {
  assert.equal(hex.length % 2, 0, "hex string has an odd length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * The scenario's wire frame as a plain tree, parsed WITHOUT the library.
 *
 * Two things need this. The first is the null/omitted distinction: once
 * `ShmBlobRef.fromWire` has run, `null` and a missing key are the same value in
 * hand and no assertion over the decoded descriptor can tell the two scenarios
 * apart. The second is the attribution control for the reject scenarios — the
 * same frame with a conforming token has to decode, and building that frame
 * means editing the tree, not the text.
 */
function wireTree(scenario) {
  if (scenario.codec === Codec.Json) return JSON.parse(scenario.wire_json);
  if (scenario.codec === Codec.Msgpack) {
    return decodeMsgpackValue(hexToBytes(scenario.wire_msgpack_hex));
  }
  throw new Error(`unknown codec in fixture: ${scenario.codec}`);
}

/** The raw `backend` slot of the scenario's descriptor: a value, `null`, or absent. */
function wireBackend(scenario) {
  const blob = wireTree(scenario).Delta.ops[0].SlotValue.payload.SharedBlob;
  // `in`, not `?.` or `??`: absent and null are two of the seven forms under
  // test and the whole point is that they stay distinguishable before the
  // decoder — which cannot tell them apart — runs.
  return "backend" in blob ? { present: true, value: blob.backend } : { present: false };
}

/**
 * Decode a scenario's wire frame through the codec it names.
 *
 * Deliberately the RAW text/hex through the library's own entry point, never a
 * pre-parsed object handed to `fromWire`. The reject frames cannot be carried as
 * structured JSON at all — `schemas/defs.json` closes `backend` to an enum, so a
 * fixture embedding `"backend": "rdma"` as an object would fail the corpus's own
 * schema gate — and re-serializing a parsed object would move the decode being
 * tested outside the code under test.
 *
 * Returns `{ ok: true, message }` or `{ ok: false, error }`; which one is
 * conforming is the scenario's `outcome`, and that split is the fixture.
 */
function decodeScenario(scenario, expect, observedCodecs) {
  try {
    if (scenario.codec === Codec.Json) {
      // The branch really taken, recorded where it is taken
      // (#lznullformblind) — `codecs` is asserted against this set rather than
      // against a runner-side transcription of the corpus's own list.
      observedCodecs.add(Codec.Json);
      const wireInput = Buffer.from(scenario.wire_json, "utf8");
      assertKey(expect, "wire_input_fnv1a64", fnv1a64Hex(wireInput));
      return { ok: true, message: IpcMessage.decodeJson(wireInput.toString("utf8")) };
    }
    if (scenario.codec === Codec.Msgpack) {
      observedCodecs.add(Codec.Msgpack);
      const wireInput = hexToBytes(scenario.wire_msgpack_hex);
      assertKey(expect, "wire_input_fnv1a64", fnv1a64Hex(wireInput));
      return {
        ok: true,
        message: IpcMessage.decodeMsgpack(wireInput),
      };
    }
  } catch (error) {
    return { ok: false, error };
  }
  // Fail closed on an unrecognised codec (#lzscenariobodyskip). An if/else chain
  // whose last arm is a fallback replays a frame the scenario never named.
  throw new Error(`unknown codec in fixture: ${scenario.codec}`);
}

/** The one `SharedBlob` descriptor the fixture's Delta carries, as decoded. */
function decodedBlob(scenario, message) {
  assert.equal(scenario.variant, "Delta", "the fixture declares the Delta variant");
  assert.ok(message.isDelta, `${scenario.id}: decoded frame is not a Delta`);
  const op = message.delta.ops[0];
  assert.ok(op instanceof DeltaOpSlotValue, `${scenario.id}: the fixture declares a SlotValue op`);
  assert.ok(
    op.payload instanceof IpcValueSharedBlob,
    `${scenario.id}: the fixture declares a SharedBlob payload`,
  );
  return op.payload.blob;
}

/**
 * Re-encode and read the descriptor's field set back off the WIRE tree.
 *
 * Off the wire, not off the typed object: `ShmBlobRef.backend` is always a
 * string, so a typed object cannot distinguish "the encoder omitted the field"
 * from "the encoder wrote `shm`" — which is precisely the distinction the
 * encoder half of the clause is about.
 */
function reencodedBlob(scenario, message) {
  let wire = message.toWire();
  if (scenario.codec === Codec.Msgpack) {
    // Through the msgpack codec specifically. Both codecs share `toWire()` here,
    // but that is worth proving rather than assuming: the #lzmsgpackparity defect
    // was a msgpack encoder writing a field the json encoder omitted.
    wire = decodeMsgpackValue(encodeMsgpackValue(wire));
  }
  return wire.Delta.ops[0].SlotValue.payload.SharedBlob;
}

test("blob backend: an absent discriminator is shm, an unknown one is refused by name", () => {
  const fixture = loadFixture();

  const block = fixture.assertions;
  assertKey(block, "required_of_binding", "MUST", FIXTURE);
  // `codecs` and `outcomes` are asserted AFTER the loop, against the branches
  // this run really dispatched on (#lznullformblind). Naming the library's
  // `Codec` members, or writing `["accept", "reject"]`, still compares the
  // corpus's list against a runner-side transcription of it: both stay green
  // over a runner whose replay loop never runs, which is the vacuity
  // `anti_vacuity` exists to forbid.
  const observedCodecs = new Set();
  const observedOutcomes = new Set();
  // The nine PARAGRAPHS the corpus declares in `assertions.prose`
  // (#lzprosekeyconvention). Each is discharged by naming the executable keys
  // that carry its obligation, and `verifyProse` at the bottom of this test
  // checks that this run really asserted every key named — which is what turns
  // the free-text excuses these calls replace into a claim about the run.
  proseKey(block, "clause", [
    // Omitted/null decode as shm; a present unknown token is refused, through
    // the decode-error family, naming the token, and never normalized.
    "decoded_backend",
    "rejected",
    "rejection_is_decode_error",
    "error_names_token",
  ]);
  proseKey(block, "wire_encoding", ["wire_input_fnv1a64"]);
  proseKey(block, "backend_form_vocabulary", [
    // Its normative half — every backend in `assertions.backends` must appear
    // as the `decoded_backend` of some accept scenario — is the set difference
    // inside the `backends` assertion below; its descriptive half (seven wire
    // shapes) is the `backend_forms` set equality.
    "backends",
    "backend_forms",
    "decoded_backend",
  ]);
  proseKey(block, "reject_obligation", [
    // "Refused for the stated reason", not merely "refused".
    "rejected",
    "error_names_token",
    "rejection_is_decode_error",
  ]);
  proseKey(block, "null_form", [
    // An explicit null is the ABSENT form: it decodes as `shm` and re-encodes
    // to no entry at all.
    "decoded_backend",
    "reencoded_backend_field_present",
  ]);
  proseKey(block, "non_string_form", [
    // Refused, through the documented family, and identified as the non-string
    // refusal rather than the unknown-token one. `error_names_token` is
    // deliberately absent: there is no token to name.
    "rejected",
    "rejection_is_decode_error",
    "rejection_kind",
  ]);
  proseKey(block, "epoch_disambiguation", [
    // The two epochs, asserted against two different sources.
    "frame_epoch",
    "blob_epoch",
  ]);
  proseKey(block, "anti_vacuity", [
    // Controls (1) and (2) are `decoded_backend` (a real decode, and the field
    // really read); (3) is the encoder half; (4) is the vocabulary completeness
    // asserted through `backends`.
    "decoded_backend",
    "reencoded_backend_field_present",
    "backends",
  ]);
  proseKey(block, "theorem", [
    // A PROXY discharge, declared as one (#lzprosekeyconvention).
    // `resolve_wrong_backend` is a Lean theorem in lazily-formal; nothing this
    // run asserts can prove it. What the run can prove is its CONSEQUENCE — an
    // unknown kind is refused rather than routed into a table this build really
    // does resolve.
    "rejected",
    "rejection_is_decode_error",
  ]);
  // Counters, one per way this runner could pass without proving anything.
  //
  //   `accepted`/`refused` — a runner that decodes nothing reports every frame
  //     refused and satisfies the reject half trivially.
  //   `nonShmDecoded` — a decoder that ignores `backend` and hardcodes `shm`
  //     passes the omitted, null and explicit-shm scenarios; only a non-shm
  //     decoded value can come from actually reading the field.
  //   `inProcessDecoded` — the vocabulary, in the positive direction. A binding
  //     that knows {shm, arrow} refuses `in_process` and lands at zero here
  //     while still decoding `arrow`.
  //   `fieldEmitted` — the encoder half in the positive direction. Every
  //     `reencoded_backend_field_present` assertion is satisfiable by an encoder
  //     that omits `backend` unconditionally except the arrow and in_process
  //     scenarios, so count those rather than trusting the per-scenario
  //     assertion alone.
  //   `omitted`/`nullForm` — the two spellings of absence, counted separately so
  //     a runner that collapsed them (the easy JS mistake) cannot reach both.
  //   `epochsDistinct` — the two epochs came from two sources and really
  //     differed; a runner reading the frame epoch twice lands at zero.
  //   `unknownTokenRefusals`/`nonStringRefusals` — the two rejection kinds, so a
  //     dispatch that fell through one arm cannot hide behind `refused`.
  let accepted = 0;
  let refused = 0;
  let nonShmDecoded = 0;
  let inProcessDecoded = 0;
  let fieldEmitted = 0;
  let omitted = 0;
  let nullForm = 0;
  let epochsDistinct = 0;
  let unknownTokenRefusals = 0;
  let nonStringRefusals = 0;
  const observedForms = new Set();
  const observedRejectionKinds = new Set();
  const decodedBackends = new Set();

  for (const scenario of scenarios(fixture)) {
    const expect = scenario.expect;
    const where = `${FIXTURE} ${scenario.id}`;
    const onWire = wireBackend(scenario);
    observedForms.add(scenario.backend_form);
    const result = decodeScenario(scenario, expect, observedCodecs);

    if (scenario.outcome === "reject") {
      observedOutcomes.add("reject");
      refused += 1;
      assertKey(expect, "rejected", !result.ok, where);
      assert.ok(
        !result.ok,
        `${where}: a \`backend\` outside ${JSON.stringify(Object.values(BlobBackendKind))} was ` +
          "ACCEPTED. Normalizing it to `shm` routes a descriptor of an unknown kind into a " +
          "table this build really does resolve, which is the misroute resolve_wrong_backend " +
          "discharges structurally.",
      );

      // The FAMILY. A refusal raised outside the type every caller guards a
      // decode with is invisible: the frame is still refused and the peer still
      // never sees the error, because it failed past the handler.
      assertKey(expect, "rejection_is_decode_error", result.error instanceof DecodeError, where);

      // ATTRIBUTION. `instanceof TypeError` is cheap in a language where reading
      // a property off `undefined` throws one too, so prove the refusal is about
      // `backend` and nothing else: swap a conforming token into the same slot
      // of the same frame and it must decode. A decoder that refused because it
      // mis-parsed `checksum`, or rejected the op tag, fails here.
      const repaired = wireTree(scenario);
      repaired.Delta.ops[0].SlotValue.payload.SharedBlob.backend = BlobBackendKind.Shm;
      assert.doesNotThrow(
        () => IpcMessage.fromWire(repaired),
        `${where}: the same frame with a conforming \`backend\` must DECODE. It does not, so ` +
          "the refusal above is not attributable to the discriminator — something else in " +
          "this descriptor is being refused and the reject assertion is passing by accident.",
      );

      assertKeyWith(
        expect,
        "rejection_kind",
        (kind) => {
          if (kind === "unknown_token") {
            unknownTokenRefusals += 1;
            assert.ok(onWire.present, `${where}: an unknown TOKEN must be present on the wire`);
            assert.equal(
              typeof onWire.value,
              "string",
              `${where}: \`rejection_kind\` is 'unknown_token' but the wire carries ` +
                `${typeof onWire.value} — the scenario labels are crossed`,
            );
            // The reason, not just the refusal. The fixture's own token reaches
            // the containment check, so a decoder that refused the frame for
            // some other reason fails here while passing the bare is-error
            // assertion above.
            assertKeyWith(
              expect,
              "error_names_token",
              (token) => {
                assert.equal(
                  onWire.value,
                  token,
                  `${where}: the fixture names token '${token}' but the wire carries ` +
                    `'${onWire.value}'`,
                );
                assert.ok(
                  String(result.error.message).includes(token),
                  `${where}: the refusal must name the offending token '${token}'; got ` +
                    `${result.error.message}`,
                );
              },
              where,
            );
            return;
          }
          if (kind === "non_string") {
            nonStringRefusals += 1;
            assert.ok(onWire.present, `${where}: a non-string \`backend\` must be present`);
            assert.notEqual(
              typeof onWire.value,
              "string",
              `${where}: \`rejection_kind\` is 'non_string' but the wire carries a string — ` +
                "the scenario would then be a duplicate of the unknown-token one",
            );
            assert.notEqual(
              onWire.value,
              null,
              `${where}: an explicit null is the ABSENT form and is accepted; it must not be ` +
                "replayed as the non-string refusal",
            );
            // Membership, not a read: `in` deliberately does not mark the key
            // consumed, which is exactly right here — the assertion is that the
            // corpus carries no token to name, and reading one would be reading
            // a key that must not exist.
            assert.ok(
              !("error_names_token" in expect),
              `${where}: the non-string form has no token, so pinning a message format here ` +
                "would bind a shape no codec's native type error carries",
            );
            return;
          }
          assert.fail(
            `${where}: unknown rejection_kind '${kind}'. Failing closed rather than treating an ` +
              "unrecognised kind as satisfied (#lzscenariobodyskip).",
          );
        },
        where,
      );
      observedRejectionKinds.add(expect.rejection_kind);
      continue;
    }

    // Fail closed rather than treating any non-"reject" label as "accept"
    // (#lzscenariobodyskip): a mistyped outcome would otherwise be replayed
    // against the wrong half of the contract.
    assert.equal(scenario.outcome, "accept", `${where}: unknown outcome ${scenario.outcome}`);
    observedOutcomes.add("accept");
    assert.ok(result.ok, `${where}: a conforming frame was refused — ${result.error}`);
    accepted += 1;

    const blob = decodedBlob(scenario, result.message);
    assertKey(expect, "decoded_backend", blob.backend, where);
    decodedBackends.add(blob.backend);
    if (blob.backend !== BlobBackendKind.Shm) nonShmDecoded += 1;
    if (blob.backend === BlobBackendKind.InProcess) inProcessDecoded += 1;

    if (scenario.backend_form === "omitted") {
      omitted += 1;
      assert.equal(
        onWire.present,
        false,
        `${where}: the omitted form must carry NO \`backend\` key on the wire — otherwise it ` +
          "is the null scenario under a different id",
      );
      // `absent means shm` is defaulted TWICE and only one of the two sites is on
      // the decode path: `ShmBlobRef.fromWire` fills the key in before handing it
      // to the constructor, whose own `backend ?? Shm` is therefore dead for every
      // frame that arrives off the wire. A mutation probe aimed at the constructor
      // default survived the whole fixture for exactly that reason — the frames it
      // decodes never reach it. So assert the second site directly, against the
      // value the first one produced: two defaulting sites that disagree is a
      // descriptor whose meaning depends on which door it came through.
      const constructed = new ShmBlobRef({
        offset: blob.offset,
        len: blob.len,
        generation: blob.generation,
        epoch: blob.epoch,
        checksum: blob.checksum,
      });
      assert.equal(
        constructed.backend,
        blob.backend,
        `${where}: constructing a descriptor with no \`backend\` disagrees with decoding a ` +
          "frame that omits it — the same absence must mean the same backend at both sites",
      );
    }

    if (scenario.backend_form === "null") {
      nullForm += 1;
      // The distinction the decoded value cannot carry. Without this the two
      // null scenarios are the two omitted ones wearing a different id, because
      // `??` erases the difference the moment the value is in hand.
      assert.ok(
        onWire.present,
        `${where}: the null form must carry an EXPLICIT \`backend\` entry on the wire — if the ` +
          "key is absent this scenario is a duplicate of the omitted one and proves nothing " +
          "the omitted one did not",
      );
      assert.equal(
        onWire.value,
        null,
        `${where}: the null form must carry a JSON null / msgpack nil, not ${onWire.value}`,
      );
      // Both defaulting sites again, this time on null rather than on absence. A
      // constructor spelling its default `backend === undefined ? Shm : backend`
      // accepts every decoded frame (`fromWire` already substituted) and stores
      // `null` here — a descriptor whose backend depends on the door it came
      // through, which is the same defect the omitted branch guards one value
      // over.
      const constructed = new ShmBlobRef({
        offset: blob.offset,
        len: blob.len,
        generation: blob.generation,
        epoch: blob.epoch,
        checksum: blob.checksum,
        backend: null,
      });
      assert.equal(
        constructed.backend,
        blob.backend,
        `${where}: constructing a descriptor with an explicit null \`backend\` disagrees with ` +
          "decoding a frame that carries one — null is the absent form at both sites",
      );
    }

    const node = result.message.delta.ops[0].node;
    assertKey(expect, "node", node, where);
    assertKey(expect, "offset", blob.offset, where);
    assertKey(expect, "len", blob.len, where);
    assertKey(expect, "generation", blob.generation, where);
    assertKey(expect, "checksum", blob.checksum, where);

    // Two epochs, two sources. v1 carried the same number in both, so a runner
    // reading either satisfied one `expect.epoch`; these are 9 and 5 and are
    // read off the Delta and off the descriptor respectively. Swapping the two
    // observations is now a failure rather than a wash.
    const frameEpoch = result.message.delta.epoch;
    assertKey(expect, "frame_epoch", frameEpoch, where);
    assertKey(expect, "blob_epoch", blob.epoch, where);
    if (frameEpoch !== blob.epoch) epochsDistinct += 1;

    // The encoder half, which no assertion over the decoded value can reach.
    const wireBlob = reencodedBlob(scenario, result.message);
    const present = wireBlob.backend !== undefined;
    assertKey(expect, "reencoded_backend_field_present", present, where);
    if (present) {
      fieldEmitted += 1;
      // Emitting the field is not enough; it has to carry the decoded kind. An
      // encoder that wrote a constant would satisfy the presence flag.
      assert.equal(wireBlob.backend, blob.backend, `${where}: re-encoded backend disagrees`);
    } else {
      // The omission has to be a real omission, not a `backend: null` echoed
      // straight back out. The null scenarios are what make this reachable: an
      // encoder that copied the decoded field verbatim would write `null` here,
      // and `!== undefined` alone reads that as absent.
      assert.ok(
        !("backend" in wireBlob),
        `${where}: the re-encoded descriptor carries a \`backend\` entry (${wireBlob.backend}) ` +
          "where a conforming encoder writes no entry at all — an explicit null must not " +
          "survive a round trip",
      );
    }
  }

  // ---- The vocabulary is COMPLETE, not merely read ----
  //
  // This is the assertion v1 lacked, and no count reaches it: it is a set
  // difference. `arrow` proves the discriminator is READ — a decoder that
  // hardcodes `shm` fails it — but a binding knowing only {shm, arrow} refuses
  // `in_process` NAMING THE TOKEN, which is conforming behaviour for an unknown
  // token, and so passed every v1 scenario while implementing a smaller enum
  // than the clause declares. The fixture's own list reaches both comparisons:
  // against the library's exported enum (a binding that grew or dropped a name)
  // and against the backends actually DECODED from accept frames (a name in the
  // enum that no frame this run replayed can produce).
  assertKeyWith(
    block,
    "backends",
    (backends) => {
      assert.deepStrictEqual(
        Object.values(BlobBackendKind),
        backends,
        `${FIXTURE}: the library's BlobBackendKind and the corpus's declared backends differ`,
      );
      const missing = backends.filter((backend) => !decodedBackends.has(backend));
      assert.deepStrictEqual(
        missing,
        [],
        `${FIXTURE}: ${JSON.stringify(missing)} is declared in \`assertions.backends\` but is ` +
          "the `decoded_backend` of no accept scenario this run replayed. Either the corpus " +
          "declares a backend it carries no accept frame for, or this binding refuses one it " +
          "must accept — v1 shipped the first and hid the second behind it.",
      );
      assert.deepStrictEqual(
        [...decodedBackends].sort(),
        [...backends].sort(),
        `${FIXTURE}: an accept scenario decoded to a backend the corpus does not declare`,
      );
    },
    FIXTURE,
  );

  // Every declared wire SHAPE was replayed, and no other. Four are tokens; the
  // other three (`omitted`, `null`, `non_string`) are the shapes the clause's
  // token-only prose does not describe, which is why they are enumerated rather
  // than implied.
  assertKeyWith(
    block,
    "backend_forms",
    (forms) => {
      assert.deepStrictEqual(
        [...observedForms].sort(),
        [...forms].sort(),
        `${FIXTURE}: the wire shapes replayed and the wire shapes declared differ`,
      );
    },
    FIXTURE,
  );

  // Both refusal kinds were reached. A dispatch that fell through the
  // `non_string` arm would leave `refused` at four and this set at one.
  assertKeyWith(
    block,
    "rejection_kinds",
    (kinds) => {
      assert.deepStrictEqual(
        [...observedRejectionKinds].sort(),
        [...kinds].sort(),
        `${FIXTURE}: the rejection kinds replayed and the rejection kinds declared differ`,
      );
    },
    FIXTURE,
  );

  // The codec branches this run really dispatched on. The library's `Codec`
  // members written out here read like the library reaching the comparison, but
  // nothing tied them to a decode: a runner that stopped dispatching on msgpack
  // kept passing (#lznullformblind).
  assertKeyWith(
    block,
    "codecs",
    (codecs) => {
      assert.deepStrictEqual(
        [...observedCodecs].sort(),
        [...codecs].sort(),
        `${FIXTURE}: the codecs replayed and the codecs declared differ`,
      );
      // Every declared codec is also a member of the library's own `Codec`, so a
      // corpus that renamed one is a failure rather than a set of two strings
      // this runner happens to agree with. `Codec` is deliberately WIDER than
      // the fixture (it also carries `bincode`/`postcard`), so this is
      // containment, not equality.
      for (const codec of codecs) {
        assert.ok(
          Object.values(Codec).includes(codec),
          `${FIXTURE}: the corpus declares codec '${codec}', which the library's Codec ` +
            `does not carry (${JSON.stringify(Object.values(Codec))})`,
        );
      }
    },
    FIXTURE,
  );

  // Both arms of the accept/reject dispatch were entered. `accepted`/`refused`
  // pin the counts; this pins that neither VALUE went unrecognised — a corpus
  // that grew a third outcome would land in the `assert.equal(..., "accept")`
  // fail-closed arm, and this is what says so from the other direction.
  assertKeyWith(
    block,
    "outcomes",
    (outcomes) => {
      assert.deepStrictEqual(
        [...observedOutcomes].sort(),
        [...outcomes].sort(),
        `${FIXTURE}: the outcomes replayed and the outcomes declared differ`,
      );
    },
    FIXTURE,
  );

  // Against what this run REPLAYED, not against `fixture.scenarios.length` —
  // comparing the fixture's count to the fixture's own array is an identity that
  // holds however few scenarios the loop entered.
  assertKey(block, "scenario_count", accepted + refused, FIXTURE);

  // Finish fixture-owned assertions before the runner-side coverage floors.
  // `epoch_disambiguation` is discharged by `expect.frame_epoch` and
  // `expect.blob_epoch`, asserted per scenario (#lzprosekeyconvention).
  verifyProse(fixture);

  assert.equal(accepted, 10, "five accepted backend forms x two codecs");
  assert.equal(
    omitted,
    2,
    "the forward-compatibility form, in both codecs — without these the second " +
      "defaulting site is never reached and its default is unfalsifiable",
  );
  assert.equal(
    nullForm,
    2,
    "the explicit-null form, in both codecs — the ABSENT form spelled the other way",
  );
  assert.equal(refused, 4, "two refusal kinds x two codecs");
  assert.equal(unknownTokenRefusals, 2, "the unknown token, in both codecs");
  assert.equal(nonStringRefusals, 2, "the non-string value, in both codecs");
  assert.equal(
    nonShmDecoded,
    4,
    "only the `arrow` and `in_process` scenarios decode to a non-shm backend; a decoder that " +
      "ignores the field and hardcodes `shm` satisfies the other six and lands at zero here",
  );
  assert.equal(
    inProcessDecoded,
    2,
    "the third declared backend, in both codecs — a binding knowing only {shm, arrow} refuses " +
      "these two frames, conformingly by the letter of the unknown-token clause, and lands at " +
      "zero here while every other counter still balances",
  );
  assert.equal(
    fieldEmitted,
    4,
    "the encoder emits `backend` for exactly the two `arrow` and two `in_process` scenarios " +
      "and omits it for the six shm ones — an encoder that always omits lands at zero, one " +
      "that always emits lands at ten",
  );
  assert.equal(
    epochsDistinct,
    10,
    "every accept scenario carries a Delta epoch and a descriptor epoch that DIFFER; a runner " +
      "reading one source for both lands at zero, which is what v1's single `expect.epoch` " +
      "could not distinguish",
  );
});
