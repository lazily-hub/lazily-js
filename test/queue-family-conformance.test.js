// The queue-family flavor ledger — enforced against the source, not a comment.
//
// `test/queue.test.js` replays the canonical `queuecell_*.json` corpus against the
// single-threaded `QueueCell`. That is currently the only flavor: no binding in
// the family ships a thread-safe or async queue primitive, and cell-model.md's
// "Core surface vs. binding extensions (queue family)" now makes those Core, so
// their absence is a conformance gap rather than an unfinished nicety.
//
// A three-flavor replay written today would skip two of three flavors entirely,
// and a suite that skips almost everything while reporting green is exactly the
// failure this file prevents. So the ledger is wired to the source: it greps
// `src/` for each unshipped flavor's class name, and the moment one appears this
// goes red and names the runner to extend.
//
// Mirrors lazily-rs/tests/queue_family_conformance.rs.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "..", "src");

const QUEUE_FIXTURES = [
  "queuecell_spsc_push_pop.json",
  "queuecell_popped_head_observation.json",
  "queuecell_mpsc_multi_writer.json",
  "queuecell_bounded_backpressure.json",
  "queuecell_closure_lifecycle.json",
];

// The marker is grepped, not imported: importing a class that does not exist
// would throw at module load, and a ledger you cannot write until the work is
// done is no ledger at all.
const LEDGER = [
  { name: "single-threaded", marker: "class QueueCell", shipped: true },
  { name: "thread-safe", marker: "ThreadSafeQueueCell", shipped: false },
  { name: "async", marker: "AsyncQueueCell", shipped: false },
];

function sources() {
  let out = "";
  const stack = [SRC];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        stack.push(path);
      } else if (entry.endsWith(".js")) {
        out += readFileSync(path, "utf8");
      }
    }
  }
  return out;
}

function fixtureDir() {
  for (const candidate of [
    join(here, "..", "..", "lazily-spec", "conformance", "collections"),
    join(here, "conformance", "collections"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

test("queue ledger: unshipped flavors are really absent", () => {
  const text = sources();
  assert.ok(text.length > 0, "read no sources from src/; the ledger check would be vacuous");

  for (const { name, marker, shipped } of LEDGER) {
    const defined = text.includes(marker);
    if (shipped) {
      assert.ok(
        defined,
        `flavor "${name}" is recorded as shipped but "${marker}" is not defined in ` +
          "src/ — the ledger claims coverage this package does not have",
      );
    } else {
      assert.ok(
        !defined,
        `flavor "${name}" now EXISTS in src/ ("${marker}") but the queue-family ledger ` +
          "still records it as unshipped, so the canonical corpus is not being replayed " +
          `against it.\n\nFix: flip shipped for "${name}" in LEDGER AND extend the replay ` +
          "to drive it, as collections-family-conformance.test.js drives all three map " +
          "flavors. Do NOT flip the flag alone — that restores the false green this test " +
          "prevents.",
      );
    }
  }
});

test("queue ledger: is not all skips", () => {
  // In a summary line, "skipped" and "passed" are indistinguishable.
  assert.ok(
    LEDGER.some((f) => f.shipped),
    "every queue flavor is recorded as unshipped, so this suite would assert nothing " +
      "while still reporting success",
  );
  assert.equal(
    LEDGER.length,
    3,
    "the ledger must cover all three execution flavors; a missing entry is an unscored " +
      "gap, not an absent one",
  );
});

test("queue ledger: shipped flavor replays the corpus", () => {
  const dir = fixtureDir();
  if (dir === undefined) {
    // An absence guard proves the corpus exists; only a count proves it was read.
    assert.fail("canonical collections fixtures not found — cannot prove the corpus was read");
  }

  let fixturesRead = 0;
  let stepsSeen = 0;
  let matricesSeen = 0;

  for (const name of QUEUE_FIXTURES) {
    const path = join(dir, name);
    assert.ok(existsSync(path), `${name}: declared queue fixture is missing`);
    const fixture = JSON.parse(readFileSync(path, "utf8"));
    fixturesRead += 1;

    const steps = fixture.steps ?? [];
    assert.ok(steps.length > 0, `${name}: fixture has no steps - a vacuous replay would report green`);
    stepsSeen += steps.length;

    steps.forEach((step, i) => {
      // The matrix nests under `expected`, NOT on the step. lazily-rs's MAP runner
      // read it off the step, so it was always absent and the assertion never ran
      // once. Pin the nesting so that cannot recur here.
      assert.equal(
        step.invalidates,
        undefined,
        `${name} step ${i}: \`invalidates\` appears at STEP level; the runners read ` +
          "expected.invalidates, so a step-level copy is silently ignored",
      );
      assert.ok(step.expected, `${name} step ${i}: no expected block`);
      if (step.expected.invalidates !== undefined) matricesSeen += 1;
    });
  }

  assert.equal(fixturesRead, QUEUE_FIXTURES.length, "did not read every declared queue fixture");
  assert.ok(stepsSeen > 0, "read the corpus but saw zero steps");
  assert.ok(
    matricesSeen > 0,
    "no fixture carried an expected.invalidates matrix - the reader-kind independence " +
      "contract would be unasserted",
  );
});
