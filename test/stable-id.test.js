import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertKey, assertKeyWith } from "./support/assert-key.js";
import { scenarios } from "./support/scenario.js";

import {
  Block,
  align,
  assignStableKeys,
  blockKey,
  contentHash,
  normalize,
  similarity,
  EDIT_THRESHOLD,
} from "../src/stable-id.js";

import { specPath } from "./spec-corpus.cjs";

const here = dirname(fileURLToPath(import.meta.url));
const specCollections = specPath("collections");

function loadFixture(name) {
  const path = join(specCollections, name);
  assert.ok(existsSync(path), `missing spec fixture ${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function toBlocks(raw) {
  return raw.map((b) => (b.anchor ? Block.anchored(b.anchor, b.text) : Block.text(b.text)));
}

test("normalize collapses whitespace runs", () => {
  assert.equal(normalize("the   quick\n  brown   fox\n"), "the quick brown fox");
  assert.equal(normalize(""), "");
});

test("content hash is stable for normalized text (FNV-1a-64)", () => {
  assert.equal(contentHash("hello"), contentHash("   hello   "));
  assert.notEqual(contentHash("hello"), contentHash("hello!"));
});

test("content key survives reflow but not edit", () => {
  const a = Block.text("the quick brown fox");
  const b = Block.text("the   quick\n  brown   fox\n");
  const c = Block.text("the quick red fox");
  assert.ok(blockKey(a).equals(blockKey(b)));
  assert.ok(!blockKey(a).equals(blockKey(c)));
});

test("anchored key survives full body rewrite", () => {
  const a = Block.anchored("item-1", "original body");
  const b = Block.anchored("item-1", "completely different prose now");
  assert.ok(blockKey(a).equals(blockKey(b)));
});

test("key prefixes partition anchored vs content", () => {
  assert.equal(blockKey(Block.anchored("x", "y")).asString(), "a:x");
  const s = blockKey(Block.text("z")).asString();
  assert.ok(s.startsWith("c:"));
  assert.equal(s.length, 2 + 16); // "c:" + 16 hex digits
});

test("similarity word-LCS ratio", () => {
  assert.equal(similarity("", ""), 1.0);
  assert.equal(similarity("the quick brown fox", "the quick brown fox"), 1.0);
  const sim = similarity(
    "the quick brown fox jumps over the lazy dog",
    "the quick brown fox jumps over the sleepy dog",
  );
  assert.ok(sim > EDIT_THRESHOLD);
});

test("small edit is Edited not Insert+Remove", () => {
  const old = [Block.text("the quick brown fox jumps over the lazy dog")];
  const next = [Block.text("the quick brown fox jumps over the sleepy dog")];
  const a = align(old, next);
  assert.equal(a.newMatches[0].kind, "edited");
  assert.deepEqual(a.removed, []);
});

test("genuine insert and remove", () => {
  const old = [Block.text("keep me"), Block.text("delete me entirely")];
  const next = [Block.text("keep me"), Block.text("brand new unrelated content here")];
  const a = align(old, next);
  assert.equal(a.newMatches[0].kind, "same");
  assert.equal(a.newMatches[1].kind, "inserted");
  assert.deepEqual(a.removed, [1]);
});

test("assign_stable_keys flows identity through edit", () => {
  const old = [
    Block.text("first paragraph stays the same"),
    Block.text("second paragraph will be tweaked a little"),
  ];
  const next = [
    Block.text("second paragraph will be tweaked a bit"),
    Block.text("first paragraph stays the same"),
  ];
  const keys = assignStableKeys(old, next);
  const oldKeys = old.map((b) => blockKey(b).asString());
  assert.equal(keys[0], oldKeys[1]); // edited inherits old[1]'s key
  assert.equal(keys[1], oldKeys[0]); // moved inherits old[0]'s key
});

// -- conformance fixture replay ----------------------------------------------

test("conformance: stableid_alignment.json", () => {
  const fixture = loadFixture("stableid_alignment.json");
  for (const scenario of scenarios(fixture)) {
    // Dispatch on the SHAPE the scenario carries, not on a substring of its name
    // (#lzscenariocoverage). The name match here was `content key survives`, which
    // is the first scenario only: `anchored key survives full body rewrite` carries
    // the same `blocks` + `expect.key_equal` shape, matched neither arm, and fell
    // out of the chain replaying nothing. Nothing noticed, because the key tracker
    // records `fixture\texpect\tkey_equal` once for the whole file and the first
    // scenario had already marked it asserted — so a fixture-level guard and a
    // key-level guard both reported green over a scenario that never ran.
    if (scenario.blocks) {
      const blocks = toBlocks(scenario.blocks);
      assertKeyWith(scenario.expect, "key_equal", (pairs) => {
        for (const [i, j] of pairs) {
          assert.ok(
            blockKey(blocks[i]).equals(blockKey(blocks[j])),
            `${scenario.name}: ${i}==${j}`,
          );
        }
      });
      if ("key_not_equal" in scenario.expect) {
        assertKeyWith(scenario.expect, "key_not_equal", (pairs) => {
          for (const [i, j] of pairs) {
            assert.ok(
              !blockKey(blocks[i]).equals(blockKey(blocks[j])),
              `${scenario.name}: ${i}!=${j}`,
            );
          }
        });
      }
    } else if (scenario.old) {
      const oldB = toBlocks(scenario.old);
      const newB = toBlocks(scenario.new);
      const a = align(oldB, newB);
      if ("matches" in scenario.expect) {
        assertKey(
          scenario.expect,
          "matches",
          a.newMatches.map((m) =>
            m.kind === "inserted"
              ? "Inserted"
              : `${m.kind === "same" ? "Same" : "Edited"}:${m.oldIndex}`,
          ),
          scenario.name,
        );
      }
      if ("removed" in scenario.expect) {
        assertKey(scenario.expect, "removed", a.removed, scenario.name);
      }
      // The threshold the "Edited, not Insert+Remove" classification rests on.
      // `matches` records the verdict; only this pins that the verdict came from
      // a similarity at or above the floor rather than from a lucky tie-break.
      if ("similarity_min" in scenario.expect) {
        assertKeyWith(scenario.expect, "similarity_min", (floor) => {
          const edited = a.newMatches.filter((m) => m.kind === "edited");
          assert.ok(edited.length > 0, `${scenario.name}: no edited match to score`);
          for (const m of edited) {
            assert.ok(
              m.similarity >= floor,
              `${scenario.name}: similarity ${m.similarity} < ${floor}`,
            );
          }
        });
      }
      if ("new_key_equals_old_key" in scenario.expect) {
        assertKeyWith(scenario.expect, "new_key_equals_old_key", (pairs) => {
          const keys = assignStableKeys(oldB, newB);
          const oldKeys = oldB.map((b) => blockKey(b).asString());
          for (const [ni, oi] of pairs) {
            assert.equal(keys[ni], oldKeys[oi], scenario.name);
          }
        });
      }
    } else {
      // No silent third arm. A scenario shape this runner does not model must fail
      // the run rather than replay nothing, which is how the anchored scenario went
      // missing in the first place.
      assert.fail(
        `${scenario.name}: unmodelled stableid_alignment scenario shape ` +
          `(keys: ${Object.keys(scenario).join(", ")})`,
      );
    }
  }
});
