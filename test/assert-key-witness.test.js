// The runtime witness inside `assertKeyWith` (#lzunboundblockguard).
//
// `assertKeyWith` marks a key ASSERTED, and that mark is the whole evidence rung
// 3 of the assertion-key ladder stands on. Two guards keep the mark honest, and
// they cover different halves:
//
//   - lazily-spec's `check-assert-with-consumption.py` (the
//     `assertion-ordering-check` gate) rejects a callback whose fixture-value
//     parameter never OCCURS in its body. Source-level, cross-binding.
//   - the recording Proxy in `test/support/assert-key.js` rejects a callback
//     that mentions the parameter and never DEREFERENCES it. Runtime, and only
//     for an object or an array, which is what can be proxied.
//
// The second is the one nothing else can see, and nothing in the conformance
// suite fails if it is reverted — the corpus would simply go back to being
// asserted vacuously and every floor would still be met. So it is pinned here,
// against a stub recorder, where the mark itself is the observation.
//
// Every negative case below is written in a shape the STATIC gate accepts: the
// parameter is named in the body, and the assertion is still vacuous. That is
// deliberate, and it is the residual this file exists for.
import assert from "node:assert/strict";
import test from "node:test";

import { assertKey, assertKeyWith } from "./support/assert-key.js";

const CHANNEL = "__lazilyConformanceKeys";

/**
 * Run `body` with a stub recorder installed, and return the tags it marked for
 * `key`. The real recorder — a `--require` preload — is saved and restored, so
 * this file cannot disturb the manifest the rest of the suite is writing.
 */
function marksFor(block, key, body) {
  const saved = Object.prototype.hasOwnProperty.call(globalThis, CHANNEL)
    ? globalThis[CHANNEL]
    : undefined;
  const tags = [];
  globalThis[CHANNEL] = {
    owner: () => "stub/fixture.json\tstub",
    mark(_object, marked, tag) {
      if (marked === key) tags.push(tag);
      return true;
    },
    descend: () => null,
  };
  try {
    body();
  } finally {
    if (saved === undefined) delete globalThis[CHANNEL];
    else globalThis[CHANNEL] = saved;
  }
  return tags;
}

test("an object witness named but never dereferenced marks N, not A", () => {
  const block = { members: { a: 1, b: 2 } };
  const tags = marksFor(block, "members", () => {
    assertKeyWith(block, "members", (want) => {
      // `want` occurs, so the static gate is satisfied. Nothing about the
      // fixture's CONTENTS is compared, so flipping every field changes nothing.
      assert.ok(want !== null);
    });
  });
  assert.deepStrictEqual(tags, ["N"]);
});

test("an array witness named but never dereferenced marks N", () => {
  const block = { keys: ["a", "b"] };
  const tags = marksFor(block, "keys", () => {
    assertKeyWith(block, "keys", (want) => {
      const bound = want;
      assert.ok(bound !== undefined);
    });
  });
  assert.deepStrictEqual(tags, ["N"]);
});

test("an object witness compared with deepStrictEqual marks A", () => {
  const block = { members: { a: 1, b: 2 } };
  const tags = marksFor(block, "members", () => {
    assertKeyWith(block, "members", (want) => {
      assert.deepStrictEqual({ a: 1, b: 2 }, want);
    });
  });
  assert.deepStrictEqual(tags, ["A"]);
});

test("reading a single field of the witness is enough to count as consumption", () => {
  const block = { members: { a: 1 } };
  const tags = marksFor(block, "members", () => {
    assertKeyWith(block, "members", (want) => {
      assert.equal(1, want.a);
    });
  });
  assert.deepStrictEqual(tags, ["A"]);
});

test("an array witness is consumed by a spread", () => {
  const block = { keys: ["b", "a"] };
  const tags = marksFor(block, "keys", () => {
    assertKeyWith(block, "keys", (want) => {
      assert.deepStrictEqual(["a", "b"], [...want].sort());
    });
  });
  assert.deepStrictEqual(tags, ["A"]);
});

test("a membership test on the witness counts", () => {
  const block = { members: { a: 1 } };
  const tags = marksFor(block, "members", () => {
    assertKeyWith(block, "members", (want) => {
      assert.equal("a" in want, true);
    });
  });
  assert.deepStrictEqual(tags, ["A"]);
});

test("the witness does not change what the check sees", () => {
  const block = { members: { a: 1, nested: [1, 2] } };
  marksFor(block, "members", () => {
    assertKeyWith(block, "members", (want) => {
      assert.deepStrictEqual(want, { a: 1, nested: [1, 2] });
      assert.equal(Array.isArray(want.nested), true);
      assert.deepStrictEqual(Object.keys(want).sort(), ["a", "nested"]);
      assert.equal(JSON.stringify(want), '{"a":1,"nested":[1,2]}');
    });
  });
});

test("an async check is settled after it resolves, and an unread witness still marks N", async () => {
  const block = { members: { a: 1 } };
  const saved = Object.prototype.hasOwnProperty.call(globalThis, CHANNEL)
    ? globalThis[CHANNEL]
    : undefined;
  const tags = [];
  globalThis[CHANNEL] = {
    owner: () => "stub/fixture.json\tstub",
    mark: (_object, _key, tag) => tags.push(tag),
    descend: () => null,
  };
  try {
    await assertKeyWith(block, "members", async (want) => {
      await Promise.resolve();
      assert.ok(want !== null);
    });
  } finally {
    if (saved === undefined) delete globalThis[CHANNEL];
    else globalThis[CHANNEL] = saved;
  }
  assert.deepStrictEqual(tags, ["N"]);
});

// A PRIMITIVE cannot be proxied, so there is no runtime witness for one and the
// static gate owns that case entirely. Pinned so that the division of labour is
// visible rather than inferred from an absence.
test("a primitive value has no runtime witness and still marks A", () => {
  const block = { mode: "eager" };
  const tags = marksFor(block, "mode", () => {
    assertKeyWith(block, "mode", (mode) => {
      assert.equal("eager", mode);
    });
  });
  assert.deepStrictEqual(tags, ["A"]);
});

test("assertKey is unaffected — it threads the fixture value itself", () => {
  const block = { mode: "eager", members: { a: 1 } };
  assert.deepStrictEqual(
    marksFor(block, "mode", () => assertKey(block, "mode", "eager")),
    ["A"],
  );
  // Object-valued: asserted AND key-set checked, because deepStrictEqual over the
  // fixture's own object compares every sub-field in both directions.
  assert.deepStrictEqual(
    marksFor(block, "members", () => assertKey(block, "members", { a: 1 })),
    ["A", "K"],
  );
});
