// NodeId exact-representation bound (#lzspecdecoderbound).
//
// protocol.md § NodeId / PeerId stated the 2^53 bound as a PRODUCER obligation
// and said nothing about what a decoder does when it receives a violation. That
// left the receiving half undefined, which is exactly where the bindings
// diverged. The clause is now normative: a decoder that cannot represent a
// received identifier exactly MUST reject the frame rather than round it.
//
// lazily-js is the narrowest case and the reason the clause exists. A JavaScript
// `number` is an IEEE-754 double, so its exact range stops at
// Number.MAX_SAFE_INTEGER, and `JSON.parse` rounds anything past it WITHOUT AN
// ERROR — 9007199254740993 comes back as 9007199254740992, a valid-looking
// identifier for a different node. `assertInteger` in src/index.js and the
// `Number.isSafeInteger` guards in src/msgpack-codec.js are what turn that
// silent substitution into a TypeError, and this runner is what holds them in
// place: deleting either one makes the two over-range scenarios below decode
// "successfully" to a neighbour, which is exactly the failure being pinned.
//
// The fixture carries its wire frames as raw text (json) and hex (msgpack) and
// its expected identifier as a decimal STRING, for the same reason. A fixture
// that spelled 9007199254740993 as a bare JSON number would have its own
// expectation rounded by the `JSON.parse` that loads it, and would then agree
// with a rounding decoder.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  assertKey,
  assertKeySet,
  assertKeyWith,
  excuseKey,
  fnv1a64Hex,
  proseKey,
  verifyProse,
} from "./support/assert-key.js";
import { scenarios } from "./support/scenario.js";

import { IpcMessage, NodeStatePayload } from "../src/index.js";

import { conformanceRoot } from "./spec-corpus.cjs";

const specFixtures = conformanceRoot;

const FIXTURE = "codec/nodeid_exact_range.json";

/** Largest identifier a JavaScript number represents exactly: 2^53 - 1. */
const MAX_EXACT = BigInt(Number.MAX_SAFE_INTEGER);

function loadFixture() {
  const path = join(specFixtures, FIXTURE);
  assert.ok(
    existsSync(path),
    `missing canonical spec fixture ${path} — clone the lazily-spec sibling ` +
      `(git clone https://github.com/lazily-hub/lazily-spec.git ../lazily-spec)`,
  );
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(fixture.protocol_version, 1);
  assert.equal(fixture.kind, "NodeIdExactRange");
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
 * Decode a scenario's wire frame with the codec it names.
 *
 * Returns `{ ok: true, message }` or `{ ok: false, error }`. Both are
 * conforming outcomes depending on the identifier; the caller decides which,
 * because that split is the whole point of the fixture.
 *
 * `observedCodecs` collects the codec whose BRANCH was really taken, at the
 * point it is taken (#lznullformblind). The `codecs` vocabulary is asserted
 * against that set, so a codec the corpus declares and this runner never
 * dispatches on is a failure rather than a transcription that always matches.
 */
function decodeScenario(scenario, expect, observedCodecs) {
  try {
    if (scenario.codec === "json") {
      observedCodecs.add("json");
      // Deliberately the raw TEXT through the codec's own entry point, not a
      // pre-parsed object: `JSON.parse` is where the rounding would happen, so
      // a runner that parsed the frame itself and handed over the object would
      // move the defect outside the code under test.
      const wireInput = Buffer.from(scenario.wire_json, "utf8");
      assertKey(expect, "wire_input_fnv1a64", fnv1a64Hex(wireInput));
      return { ok: true, message: IpcMessage.decodeJson(wireInput.toString("utf8")) };
    }
    if (scenario.codec === "msgpack") {
      observedCodecs.add("msgpack");
      const wireInput = hexToBytes(scenario.wire_msgpack_hex);
      assertKey(expect, "wire_input_fnv1a64", fnv1a64Hex(wireInput));
      return { ok: true, message: IpcMessage.decodeMsgpack(wireInput) };
    }
  } catch (error) {
    return { ok: false, error };
  }
  throw new Error(`unknown codec: ${scenario.codec}`);
}

test("NodeId exact-representation bound is enforced by refusal, never rounding", () => {
  const fixture = loadFixture();

  const block = fixture.assertions;
  const where = FIXTURE;
  assertKey(block, "required_of_binding", "MUST", where);
  // `codecs` and `scenario_count` are asserted AFTER the loop, against the
  // codec branches this run really dispatched on and the scenarios it really
  // replayed (#lznullformblind). Transcribing `["json", "msgpack"]` here, or
  // comparing `scenario_count` to `fixture.scenarios.length`, is a comparison
  // of the fixture against itself: both stay green over a runner that decodes
  // nothing, which is the vacuity `anti_vacuity` names.
  const observedCodecs = new Set();
  // The three PARAGRAPHS the corpus declares in `assertions.prose`
  // (#lzprosekeyconvention), each discharged by naming the executable keys that
  // carry it. `verifyProse` below checks that this run really asserted them.
  proseKey(block, "clause", [
    // "MUST reject, MUST NOT round/truncate/saturate/wrap": `outcome` is the
    // permitted-behaviour split and `node_id_decimal` is the comparison that
    // makes a rounded neighbour visible rather than approximately right.
    "outcome",
    "node_id_decimal",
  ]);
  proseKey(block, "wire_encoding", ["wire_input_fnv1a64"]);
  proseKey(block, "anti_vacuity", [
    // The two `exact` scenarios are the control: the boundary value must decode
    // correctly before the refusals count. `scenario_count` is the other half —
    // it is `accepted + refused`, so a loop that entered no body at all cannot
    // reach the declared count (#lznullformblind). It used to be
    // `fixture.scenarios.length`, which is the fixture agreeing with itself, so
    // the paragraph MOST about vacuity was the one discharged most vacuously.
    "outcome",
    "node_id_decimal",
    "scenario_count",
  ]);
  // NOT prose (a vocabulary mapped to English glosses, #lzprosekeyconvention):
  // the assertion is the KEY SET, and asserting the parent key discharges the
  // glosses. Every outcome this run replayed must be one the corpus declares,
  // and every outcome the corpus declares must have been replayed — otherwise
  // `outcomes` grows a third value nothing here dispatches on.
  const observedOutcomes = new Set();
  // Anti-vacuity. `exact_or_reject` is satisfied by a runner that decodes
  // nothing and reports "rejected" — and lazily-js REFUSES four of the six
  // scenarios, so a broken runner would look almost exactly like a working one.
  // These two counters, pinned to exact values below, are what separates them.
  let accepted = 0;
  let refused = 0;

  for (const scenario of scenarios(fixture)) {
    const expect = scenario.expect;
    const scenarioWhere = `${FIXTURE} ${scenario.id}`;
    const expected = BigInt(expect.node_id_decimal);
    const representable = expected <= MAX_EXACT;

    // `outcome` is the corpus-wide statement of what a decoder may do. lazily-js
    // reads it as a constraint on the fixture: an `exact` scenario it cannot
    // represent would be a fixture bug, not a binding bug.
    assertKeyWith(
      expect,
      "outcome",
      (want) => {
        assert.ok(
          want === "exact" || want === "exact_or_reject",
          `${scenarioWhere}: unknown outcome ${want}`,
        );
        observedOutcomes.add(want);
        if (want === "exact") {
          assert.ok(
            representable,
            `${scenarioWhere}: fixture marks an unrepresentable identifier \`exact\``,
          );
        }
      },
      scenarioWhere,
    );

    const result = decodeScenario(scenario, expect, observedCodecs);

    if (!result.ok) {
      // The refusal is correct only BECAUSE the fixture's own identifier is
      // outside the exact range, so `node_id_decimal` is threaded through the
      // comparison rather than compared to the derived `representable` flag. A
      // fixture edit that brought this identifier inside the range would make
      // the refusal the very silent-substitution failure the clause exists to
      // prevent, and this reddens instead of staying green on a stale local.
      assertKeyWith(
        expect,
        "node_id_decimal",
        (want) => {
          assert.ok(
            BigInt(want) > MAX_EXACT,
            `${scenarioWhere}: lazily-js represents ${want} exactly, so this frame ` +
              `must decode; got ${result.error}`,
          );
        },
        scenarioWhere,
      );
      // The keys that describe the SNAPSHOT this frame would have decoded to are
      // excused here, per scenario (#lzjsblocknamemasking). There is no decoded
      // message to compare them against: `decodeScenario` threw, which is the
      // conforming outcome for an identifier a JavaScript number cannot hold, so
      // asserting them would mean fabricating an observation.
      //
      // This used to be impossible to declare. The assertion-key ledger booked
      // every scenario's `expect` under the bare block name `assertions`/`expect`,
      // so all six scenarios of this fixture shared ONE namespace: excusing
      // `type_tag` here while the two 2^53 - 1 scenarios asserted it registered as
      // an excuse that hides nothing, and the guard failed it as stale. The ledger
      // is now keyed by the block's JSON PATH (`scenarios[3].expect`), so a
      // sibling's assertion no longer satisfies this one — which is also why these
      // five keys showed up as NEVER CONSUMED the moment the collapse was removed:
      // scenario 0's assertions had been marking them for all six.
      for (const key of ["epoch", "node_count", "type_tag", "payload", "root_id_decimal"]) {
        excuseKey(
          expect,
          key,
          `${scenario.id}: the frame is REFUSED because its identifier is outside the ` +
            "IEEE-754 exact range, so no decoded snapshot exists to compare this key " +
            "against; asserting it would mean fabricating an observation. The refusal " +
            "itself is asserted through node_id_decimal above and counted by " +
            "scenario_count/refused. A binding that gains exact decoding asserts this " +
            "key and fails this excuse as stale.",
        );
      }
      refused += 1;
      continue;
    }

    assert.ok(
      representable,
      `${scenarioWhere}: a JavaScript number cannot represent ${expected} exactly, so ` +
        `decoding it means the identifier was ROUNDED to a neighbouring node id — ` +
        `the silent corruption this clause exists to prevent`,
    );
    accepted += 1;

    const snapshot = result.message.snapshot;
    assert.ok(snapshot, `${scenarioWhere}: fixture declares the Snapshot variant`);
    assert.equal(scenario.variant, "Snapshot");

    assertKey(expect, "epoch", snapshot.epoch, scenarioWhere);
    assertKey(expect, "node_count", snapshot.nodes.length, scenarioWhere);

    const node = snapshot.nodes[0];
    // The discriminating assertion: the decimal rendering, not the number, so a
    // decoder that returned a neighbour is visible rather than approximately right.
    assertKey(expect, "node_id_decimal", String(node.node), scenarioWhere);
    assertKey(expect, "type_tag", node.typeTag, scenarioWhere);
    assert.ok(node.state instanceof NodeStatePayload, "the fixture carries a Payload node state");
    assertKey(expect, "payload", Array.from(node.state.bytes), scenarioWhere);
    assert.equal(snapshot.roots.length, 1, `${scenarioWhere}: one root`);
    assertKey(expect, "root_id_decimal", String(snapshot.roots[0]), scenarioWhere);
  }

  // Both vocabularies against what this run REALLY did (#lznullformblind).
  //
  // `codecs` is the set of branches `decodeScenario` took, not a runner-side
  // transcription of the corpus's list: a binding that quietly stopped
  // dispatching on msgpack — or a corpus that grew a third codec — is a failure
  // here rather than a literal that agrees with the fixture forever.
  assertKeyWith(
    block,
    "codecs",
    (codecs) => {
      assert.deepStrictEqual(
        [...observedCodecs].sort(),
        [...codecs].sort(),
        `${where}: the codecs replayed and the codecs declared differ`,
      );
    },
    where,
  );
  // `scenario_count` against the two counters, not `fixture.scenarios.length`.
  // The identity form holds however few scenarios the loop entered.
  assertKey(block, "scenario_count", accepted + refused, where);

  // The vocabulary, not the glosses. A third outcome added upstream would land
  // in neither arm of the dispatch above, and the set difference is what says so.
  //
  // Through the tracker's key-set entry point rather than a hand-rolled
  // `Object.keys` inside `assertKeyWith` (#lzsubblockkeyset). The comparison is
  // the same one; what changes is that the TRACKER now knows this object-valued
  // key was checked by its key set. A site that reached for `assertKeyWith` here
  // instead — comparing named sub-fields and stopping — is failed by the
  // finish-time guard rather than reporting asserted over a silent hole.
  assertKeySet(block, "outcomes", observedOutcomes, where);

  verifyProse(fixture);

  // Two scenarios (2^53 - 1, in both codecs) are inside the double range; the
  // four above it are not. Pinning both halves means a guard that stopped
  // refusing, and a decoder that stopped decoding, are each a failure here.
  assert.equal(accepted, 2, "lazily-js decodes exactly the two 2^53 - 1 scenarios");
  assert.equal(refused, 4, "lazily-js refuses both over-range identifiers in both codecs");
});
