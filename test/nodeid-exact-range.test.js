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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertKey, assertKeyWith, excuseKey } from "./support/assert-key.js";
import { scenarios } from "./support/scenario.js";

import { IpcMessage, NodeStatePayload } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const specFixtures = join(here, "..", "..", "lazily-spec", "conformance");

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
 */
function decodeScenario(scenario) {
  try {
    if (scenario.codec === "json") {
      // Deliberately the raw TEXT through the codec's own entry point, not a
      // pre-parsed object: `JSON.parse` is where the rounding would happen, so
      // a runner that parsed the frame itself and handed over the object would
      // move the defect outside the code under test.
      return { ok: true, message: IpcMessage.decodeJson(scenario.wire_json) };
    }
    if (scenario.codec === "msgpack") {
      return { ok: true, message: IpcMessage.decodeMsgpack(hexToBytes(scenario.wire_msgpack_hex)) };
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
  assertKey(block, "codecs", ["json", "msgpack"], where);
  assertKey(block, "scenario_count", fixture.scenarios.length, where);
  for (const prose of ["clause", "wire_encoding", "outcomes", "anti_vacuity", "generator"]) {
    excuseKey(
      block,
      prose,
      "prose: it states WHY the fixture is shaped this way; the behaviour it " +
        "describes is asserted by the per-scenario decode below",
    );
  }

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
        if (want === "exact") {
          assert.ok(
            representable,
            `${scenarioWhere}: fixture marks an unrepresentable identifier \`exact\``,
          );
        }
      },
      scenarioWhere,
    );

    const result = decodeScenario(scenario);

    if (!result.ok) {
      assert.ok(
        !representable,
        `${scenarioWhere}: lazily-js represents ${expected} exactly, so this frame ` +
          `must decode; got ${result.error}`,
      );
      // No excuseKey() for this scenario's value keys. The assertion-key ledger
      // namespaces by `fixture\tblock\tkey`, so every scenario's `expect` shares
      // one namespace: excusing `node_id_decimal` here while the 2^53 - 1
      // scenario asserts it would register as a stale excuse — an excuse that
      // hides nothing. The refusal is asserted by `refused` below instead, which
      // is the stronger claim anyway: it counts, rather than merely permitting.
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

  // Two scenarios (2^53 - 1, in both codecs) are inside the double range; the
  // four above it are not. Pinning both halves means a guard that stopped
  // refusing, and a decoder that stopped decoding, are each a failure here.
  assert.equal(accepted, 2, "lazily-js decodes exactly the two 2^53 - 1 scenarios");
  assert.equal(refused, 4, "lazily-js refuses both over-range identifiers in both codecs");
});
