import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

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

const here = dirname(fileURLToPath(import.meta.url));
const specCollections = join(here, "..", "..", "lazily-spec", "conformance", "collections");

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
  for (const scenario of fixture.scenarios) {
    if (scenario.name.includes("content key survives")) {
      const blocks = toBlocks(scenario.blocks);
      for (const [i, j] of scenario.expect.key_equal) {
        assert.ok(blockKey(blocks[i]).equals(blockKey(blocks[j])), `${scenario.name}: ${i}==${j}`);
      }
      for (const [i, j] of scenario.expect.key_not_equal ?? []) {
        assert.ok(!blockKey(blocks[i]).equals(blockKey(blocks[j])), `${scenario.name}: ${i}!=${j}`);
      }
    } else if (scenario.old) {
      const oldB = toBlocks(scenario.old);
      const newB = toBlocks(scenario.new);
      const a = align(oldB, newB);
      if (scenario.expect.matches) {
        assert.deepEqual(
          a.newMatches.map((m) =>
            m.kind === "inserted" ? "Inserted" : `${m.kind === "same" ? "Same" : "Edited"}:${m.oldIndex}`,
          ),
          scenario.expect.matches,
          scenario.name,
        );
      }
      if (scenario.expect.removed) {
        assert.deepEqual(a.removed, scenario.expect.removed, scenario.name);
      }
      if (scenario.expect.new_key_equals_old_key) {
        const keys = assignStableKeys(oldB, newB);
        const oldKeys = oldB.map((b) => blockKey(b).asString());
        for (const [ni, oi] of scenario.expect.new_key_equals_old_key) {
          assert.equal(keys[ni], oldKeys[oi], scenario.name);
        }
      }
    }
  }
});
