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
//     `arrow`. A decoder that reads the field correctly and echoes whatever it
//     received back out has a correct decoded value and a non-conforming
//     encoder;
//   * the REASON — the thrown error must name `rdma`. A decoder that refuses the
//     frame because it mis-parsed `checksum` satisfies "an error was thrown"
//     while implementing none of the clause.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertKey, assertKeyWith, excuseKey } from "./support/assert-key.js";
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
function decodeScenario(scenario) {
  try {
    if (scenario.codec === Codec.Json) {
      return { ok: true, message: IpcMessage.decodeJson(scenario.wire_json) };
    }
    if (scenario.codec === Codec.Msgpack) {
      return {
        ok: true,
        message: IpcMessage.decodeMsgpack(hexToBytes(scenario.wire_msgpack_hex)),
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
  // The library's own values reach the comparison, not a transcription of them:
  // a binding that grew a fourth backend the corpus does not know about, or
  // dropped one it does, is a failure here rather than a silent divergence.
  assertKey(block, "codecs", [Codec.Json, Codec.Msgpack], FIXTURE);
  assertKey(block, "backends", Object.values(BlobBackendKind), FIXTURE);
  assertKey(block, "outcomes", ["accept", "reject"], FIXTURE);
  assertKey(block, "scenario_count", fixture.scenarios.length, FIXTURE);
  for (const prose of [
    "clause",
    "wire_encoding",
    "reject_obligation",
    "anti_vacuity",
    "theorem",
    "generator",
  ]) {
    excuseKey(
      block,
      prose,
      "prose: it states WHY the fixture is shaped this way; the behaviour it " +
        "describes is asserted by the per-scenario decode, re-encode and refusal below",
    );
  }

  // Four counters, one per way this runner could pass without proving anything.
  //
  //   `accepted`/`refused` — a runner that decodes nothing reports every frame
  //     refused and satisfies the reject half trivially.
  //   `arrowDecoded` — a decoder that ignores `backend` and hardcodes `shm`
  //     passes the omitted and explicit-shm scenarios; only a non-shm decoded
  //     value can come from actually reading the field.
  //   `fieldEmitted` — the encoder half in the positive direction. Every
  //     `reencoded_backend_field_present` assertion is satisfiable by an encoder
  //     that omits `backend` unconditionally except the two arrow scenarios, so
  //     count those rather than trusting the per-scenario assertion alone.
  let accepted = 0;
  let refused = 0;
  let arrowDecoded = 0;
  let fieldEmitted = 0;
  let omitted = 0;

  for (const scenario of scenarios(fixture)) {
    const expect = scenario.expect;
    const where = `${FIXTURE} ${scenario.id}`;
    const result = decodeScenario(scenario);

    if (scenario.outcome === "reject") {
      refused += 1;
      assertKey(expect, "rejected", !result.ok, where);
      assert.ok(
        !result.ok,
        `${where}: a \`backend\` outside ${JSON.stringify(Object.values(BlobBackendKind))} was ` +
          "ACCEPTED. Normalizing it to `shm` routes a descriptor of an unknown kind into a " +
          "table this build really does resolve, which is the misroute resolve_wrong_backend " +
          "discharges structurally.",
      );
      // The reason, not just the refusal. The fixture's own token reaches the
      // containment check, so a decoder that refused the frame for some other
      // reason — a mis-parsed checksum, a rejected op tag — fails here while
      // passing the bare is-error assertion above.
      assertKeyWith(
        expect,
        "error_names_token",
        (token) => {
          assert.ok(
            String(result.error.message).includes(token),
            `${where}: the refusal must name the offending token '${token}'; got ` +
              `${result.error.message}`,
          );
        },
        where,
      );
      continue;
    }

    // Fail closed rather than treating any non-"reject" label as "accept"
    // (#lzscenariobodyskip): a mistyped outcome would otherwise be replayed
    // against the wrong half of the contract.
    assert.equal(scenario.outcome, "accept", `${where}: unknown outcome ${scenario.outcome}`);
    assert.ok(result.ok, `${where}: a conforming frame was refused — ${result.error}`);
    accepted += 1;

    const blob = decodedBlob(scenario, result.message);
    assertKey(expect, "decoded_backend", blob.backend, where);
    if (blob.backend !== BlobBackendKind.Shm) arrowDecoded += 1;

    if (scenario.backend_form === "omitted") {
      omitted += 1;
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

    const node = result.message.delta.ops[0].node;
    assertKey(expect, "node", node, where);
    assertKey(expect, "offset", blob.offset, where);
    assertKey(expect, "len", blob.len, where);
    assertKey(expect, "generation", blob.generation, where);
    assertKey(expect, "epoch", blob.epoch, where);
    assertKey(expect, "checksum", blob.checksum, where);

    // The encoder half, which no assertion over the decoded value can reach.
    const wireBlob = reencodedBlob(scenario, result.message);
    const present = wireBlob.backend !== undefined;
    assertKey(expect, "reencoded_backend_field_present", present, where);
    if (present) {
      fieldEmitted += 1;
      // Emitting the field is not enough; it has to carry the decoded kind. An
      // encoder that wrote a constant would satisfy the presence flag.
      assert.equal(wireBlob.backend, blob.backend, `${where}: re-encoded backend disagrees`);
    }
  }

  assert.equal(accepted, 6, "three accepted backend forms x two codecs");
  assert.equal(
    omitted,
    2,
    "the forward-compatibility form, in both codecs — without these the second " +
      "defaulting site is never reached and its default is unfalsifiable",
  );
  assert.equal(refused, 2, "the unknown token, in both codecs");
  assert.equal(
    arrowDecoded,
    2,
    "only the `arrow` scenarios decode to a non-shm backend; a decoder that ignores the " +
      "field and hardcodes `shm` satisfies the other four and lands at zero here",
  );
  assert.equal(
    fieldEmitted,
    2,
    "the encoder emits `backend` for exactly the two `arrow` scenarios and omits it for " +
      "the four shm ones — an encoder that always omits lands at zero, one that always " +
      "emits lands at six",
  );
});
