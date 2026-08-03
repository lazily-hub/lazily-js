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
      `${verb}: key '${key}' is not present in the fixture block. ` +
        "A runner asserting a key the corpus does not carry is asserting nothing; " +
        "fix the key name or drop the call.",
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

// ---- Prose keys (#lzprosekeyconvention) ----
//
// The header above argues that comparing an English paragraph to a literal pins
// wording rather than behaviour. That reasoning is now family policy, and the two
// helpers below are what make it ENFORCEABLE rather than advisory.
//
// A prose key is a key of a fixture's top-level `assertions` block whose value is
// a paragraph stating an obligation and carrying nothing comparable. The CORPUS
// declares which keys those are, in `assertions.prose`; a binding must not decide
// for itself, and the declaration is itself a key of the block, so a runner that
// ignores it fails with an unconsumed key.
//
// A prose key is DISCHARGED — never asserted, never excused — by naming the
// executable keys that carry its obligation. That is the whole point: "`epoch_
// disambiguation` is discharged by `frame_epoch` and `blob_epoch`" is a claim
// about the run and the tracker can check it, while "`epoch_disambiguation` is
// prose" is an unfalsifiable free-text excuse indistinguishable from the
// undocumented default this clause exists to remove.
//
// The ledger is FIXTURE-scoped, not block-scoped, because the keys that discharge
// an `assertions` paragraph routinely live in a per-scenario `expect` block
// asserted long after the `assertions` block is finished. `verifyProse(fixture)`
// runs at the end of the fixture's replay; a run that never verifies fails, in
// `scripts/check-assertion-keys.mjs`, exactly as an unconsumed key does.

/** Presence, not a read: membership deliberately does not consume the key. */
function presentIn(block, key, verb) {
  if (block === null || typeof block !== "object") {
    throw new TypeError(`${verb}: expected an assertion block object, got ${typeof block}`);
  }
  if (!(key in block)) {
    throw new Error(`${verb}: key '${key}' is not present in the fixture block.`);
  }
}

/**
 * Discharge the prose key `key` by naming the executable assertion keys in
 * `dischargedBy` that carry its obligation.
 *
 * Every named key is matched BY NAME in any block of the same fixture, and the
 * fixture's own `assertions.prose` is compared against the set of keys discharged
 * — which is the comparison that consumes and asserts `prose` itself.
 */
export function proseKey(block, key, dischargedBy) {
  presentIn(block, key, "proseKey");
  if (!Array.isArray(dischargedBy) || dischargedBy.length === 0) {
    throw new Error(
      `proseKey('${key}'): a discharge must NAME the executable assertion keys that carry ` +
        "this paragraph's obligation. A discharge naming nothing is the unfalsifiable " +
        "excuse this convention exists to remove.",
    );
  }
  for (const name of dischargedBy) {
    if (typeof name !== "string" || name.trim() === "") {
      throw new TypeError(
        `proseKey('${key}'): every entry of dischargedBy must be an assertion key name; ` +
          `got ${typeof name}.`,
      );
    }
  }
  const rec = recorder();
  if (rec === null) return;
  if (rec.markProse(block, key, [...new Set(dischargedBy)]) === false) {
    throw new Error(
      `proseKey('${key}'): this object is not a tracked assertion block of a parsed corpus ` +
        "fixture, or the block carries no record for that key. A discharge against a copy " +
        "(structuredClone, a spread, a hand-built stand-in) is a claim the ledger cannot tie " +
        "to the corpus, and verification would then report the key as never discharged.",
    );
  }
}

/**
 * Verify every discharge claim this run made for `fixture`, and consume the
 * fixture's own `assertions.prose` by comparing it against the keys discharged.
 *
 * Call it once, at the END of the fixture's replay — the keys that discharge an
 * `assertions` paragraph are routinely asserted per scenario.
 */
export function verifyProse(fixture) {
  const rec = recorder();
  if (rec === null) return;
  const rel = rec.fixtureOf(fixture);
  if (rel === null) {
    throw new Error(
      "verifyProse: this object is not a parsed corpus fixture. Pass the object your runner " +
        "parsed — a copy is not the thing the ledger tracks, and verifying one would report " +
        "the real fixture as never verified.",
    );
  }
  // Booked BEFORE the checks: a verification that FAILS still happened, and the
  // failure is its own report. Booking after would turn one red into two.
  rec.markVerified(rel);

  const blocks = rec.proseBlocks(rel);
  if (blocks.length === 0) return;

  const records = rec.records(rel);
  const assertedNames = new Set();
  const assertedIds = new Set();
  const excusedIds = new Set();
  const claims = [];
  for (const entry of records) {
    if (entry.tag === "A") {
      assertedNames.add(entry.key);
      assertedIds.add(`${entry.block}\t${entry.key}`);
    } else if (entry.tag === "X") {
      excusedIds.add(`${entry.block}\t${entry.key}`);
    } else if (entry.tag === "D") {
      claims.push({
        block: entry.block,
        key: entry.key,
        names: entry.extra === undefined || entry.extra === "" ? [] : entry.extra.split(","),
      });
    }
  }
  const everyProseName = new Set(blocks.flatMap((entry) => entry.declared));

  const problems = [];
  const toMark = [];
  for (const { block, object, declared } of blocks) {
    const declaredSet = new Set(declared);
    const mine = claims.filter((claim) => claim.block === block);

    for (const name of declared) {
      // Rule 1. A tally derived from a paragraph is still a comparison against
      // English: a copy-edit reddens the run and a library regression does not.
      if (assertedIds.has(`${block}\t${name}`)) {
        problems.push(
          `'${name}' is declared prose in ${block} and was ASSERTED. Comparing a paragraph, ` +
            "or a tally derived from one, pins wording rather than behaviour. Discharge it " +
            "with proseKey() instead.",
        );
      }
      // Rule 2. Free text is exactly the undocumented default this removes.
      if (excusedIds.has(`${block}\t${name}`)) {
        problems.push(
          `'${name}' is declared prose in ${block} and was EXCUSED with free text. An ` +
            "unfalsifiable reason is what proseKey() replaces; delete the excuseKey() call.",
        );
      }
    }

    for (const claim of mine) {
      // Rule 3.
      if (!declaredSet.has(claim.key)) {
        problems.push(
          `'${claim.key}' in ${block} was DISCHARGED but the corpus does not list it in ` +
            "`assertions.prose`. A key carrying a comparable value must be asserted, not " +
            "discharged.",
        );
      }
      // Rule 5. Also refused at the call site; kept here so a claim that reached
      // the ledger empty by any other route cannot pass.
      if (claim.names.length === 0) {
        problems.push(`'${claim.key}' in ${block} was discharged naming NO keys.`);
        continue;
      }
      for (const name of claim.names) {
        // Rule 7 before rule 6: naming another paragraph is a distinct mistake
        // from naming a key nothing asserted, and it would otherwise be reported
        // as the latter.
        if (everyProseName.has(name)) {
          problems.push(
            `'${claim.key}' in ${block} is discharged by '${name}', which is itself declared ` +
              "prose. A paragraph cannot discharge a paragraph.",
          );
        } else if (!assertedNames.has(name)) {
          // Rule 6 — the whole convention. The excuse became falsifiable.
          problems.push(
            `'${claim.key}' in ${block} is discharged by '${name}', which this fixture's run ` +
              "never ASSERTED. Either the obligation is unchecked, or the discharge names the " +
              "wrong key.",
          );
        }
      }
    }

    // Rule 4, and the read that consumes `prose`. Done through the block's own
    // accessor, so the fixture's value reaches the comparison.
    const discharged = [...new Set(mine.map((claim) => claim.key))].sort();
    const wanted = [...object.prose].sort();
    let matches = discharged.length === wanted.length;
    if (matches) matches = discharged.every((name, index) => name === wanted[index]);
    if (!matches) {
      problems.push(
        `the keys discharged in ${block} (${JSON.stringify(discharged)}) differ from the ` +
          `corpus's \`prose\` declaration (${JSON.stringify(wanted)}). This is the comparison ` +
          "that consumes `prose`, and it is what makes a forgotten paragraph fail rather than " +
          "vanish.",
      );
    } else {
      toMark.push(object);
    }
  }

  if (problems.length > 0) {
    throw new assert.AssertionError({
      message:
        `${rel}: prose-key discharge is not conforming (#lzprosekeyconvention)\n  - ` +
        problems.join("\n  - "),
      operator: "verifyProse",
    });
  }
  for (const object of toMark) mark(object, "prose", "A");
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
      `excuseKey(${key}): a reason is required. An undeclared exception is the ` +
        "silent skip this guard exists to catch.",
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
