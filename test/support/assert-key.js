// Fixture-key assertion helpers (#lzconsumednotasserted).
//
// `#lzassertunknownkeys` made a conformance run fail when a fixture assertion key
// no runner READ. That proves consumption. It does not prove assertion: a runner
// can read a key and discard it, and the read alone turns the tracker green.
// Three shapes do exactly that —
//
//   1. a named skip inside a loop that iterates the block
//      (`for (const [k, v] of Object.entries(expect)) if (k === "x") continue;`
//      — `Object.entries` invokes the recorder's accessor, so `x` is marked read
//      on its way to being thrown away);
//   2. a value bound and never compared (`const want = expect.x;`);
//   3. an arm that reads the key and then compares against a hardcoded literal,
//      so editing the fixture changes nothing.
//
// These helpers are the ONLY path that marks a key asserted. The fixture's own
// value has to reach the comparison, so shape 3 cannot mark: an arm comparing
// against a literal never routes through here. Shapes 1 and 2 cannot mark either,
// because there is no comparison to route.
//
// When the recorder is not attached (a plain `node --test` with no
// `LAZILY_CONFORMANCE_KEY_MANIFEST`) the marking is a no-op and the helpers are
// ordinary assertions, so the suite behaves identically either way.
import assert from "node:assert/strict";

const recorder = () => globalThis.__lazilyConformanceKeys ?? null;

function mark(block, key, tag, reason) {
  const rec = recorder();
  if (rec === null) return;
  rec.mark(block, key, tag, reason);
}

function label(block, key, where) {
  const rec = recorder();
  const owner = rec === null ? null : rec.owner(block);
  const origin = owner === null ? "fixture" : owner.split("\t").join(" ");
  return where === undefined ? `${origin} ${key}` : `${origin} ${key} (${where})`;
}

function fetch(block, key, verb) {
  if (block === null || typeof block !== "object") {
    throw new TypeError(`${verb}: expected an assertion block object, got ${typeof block}`);
  }
  if (!(key in block)) {
    throw new Error(
      `${verb}: key '${key}' is not present in the fixture block. `
      + "A runner asserting a key the corpus does not carry is asserting nothing; "
      + "fix the key name or drop the call.",
    );
  }
  // Reading through the block marks it consumed via the recorder's accessor.
  return block[key];
}

/**
 * Assert `actual` deep-equals the fixture's own value for `key`, and mark the key
 * asserted. This is the entry point to prefer: the value under comparison comes
 * from the fixture, so a corpus edit moves the test.
 */
export function assertKey(block, key, actual, where) {
  const want = fetch(block, key, "assertKey");
  mark(block, key, "A");
  assert.deepStrictEqual(actual, want, label(block, key, where));
  return want;
}

/**
 * Assert a non-equality relation — a tolerance, a containment, a regex — while
 * still routing the fixture's value into the comparison. `check` receives the
 * fixture value; whatever it does with it is the assertion. The point is that the
 * fixture's value reaches the comparison, not that the comparison is `===`.
 */
export function assertKeyWith(block, key, check, where) {
  const want = fetch(block, key, "assertKeyWith");
  mark(block, key, "A");
  if (typeof check !== "function") {
    throw new TypeError(`assertKeyWith(${label(block, key, where)}): check must be a function`);
  }
  return check(want);
}

/**
 * Assert every own key of a tracked block at once against a fully constructed
 * observation. Marks each key asserted, because a deep equality over the whole
 * block does compare every one of its values against the fixture's.
 */
export function assertBlock(block, actual, where) {
  if (block === null || typeof block !== "object") {
    throw new TypeError(`assertBlock: expected an assertion block object, got ${typeof block}`);
  }
  for (const key of Object.keys(block)) mark(block, key, "A");
  assert.deepStrictEqual(actual, { ...block }, where ?? "fixture block");
}

/**
 * Declare that `key` cannot be asserted at this call site, and why.
 *
 * This is the fallback, not the default: prefer implementing the assertion. The
 * reason must name where the fact is proven instead, or why it is unprovable
 * here. Like the coverage allowlist, an excuse goes stale in BOTH directions —
 * excusing a key the same run also asserts fails the guard, because the excuse is
 * then hiding nothing.
 */
export function excuseKey(block, key, reason) {
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new Error(
      `excuseKey(${key}): a reason is required. An undeclared exception is the `
      + "silent skip this guard exists to catch.",
    );
  }
  if (block === null || typeof block !== "object") {
    throw new TypeError(`excuseKey: expected an assertion block object, got ${typeof block}`);
  }
  if (!(key in block)) {
    throw new Error(`excuseKey: key '${key}' is not present in the fixture block.`);
  }
  mark(block, key, "X", reason.replace(/\s+/g, " ").trim());
}
