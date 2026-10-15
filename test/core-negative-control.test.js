// The Core report generator credits a negative control only on a library
// divergence. A mutated fixture leaf that makes the runner fail on its OWN
// bookkeeping (an unknown node id, a renamed scenario label, an unconsumed key)
// proves the runner read the leaf, not that the assertion over the library
// discriminates. These tests drive `killRoute` with a scripted runner so the
// over-credit cannot come back.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { divergenceLines, killRoute, routeLeaves } from "../scripts/core-negative-control.mjs";

const REL = "reactive-graph/pair.json";
const FIXTURE = {
  expected: {
    observationally_equal: ["left", "right"],
    note: "prose is never perturbed",
    final_state: { dependents_of: { topic: 1 } },
  },
};
const DIVERGENCE =
  "\nDIVERGENCE Context/pair.json[left]#expected:final.dependents_of.topic — got 1, want 1000004\n";
const LABEL_CRASH = "Error: Context/pair.json: unknown scenario left__core_mutant__\n";

function fail(message) {
  throw new Error(`core conformance: ${message}`);
}

function withCorpus(body) {
  const scratch = mkdtempSync(join(tmpdir(), "lazily-core-negative-control-"));
  try {
    mkdirSync(join(scratch, "corpus", "reactive-graph"), { recursive: true });
    writeFileSync(join(scratch, "corpus", REL), JSON.stringify(FIXTURE));
    return body(join(scratch, "corpus"), join(scratch, "mutant"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** A runner that fails every probe with the next scripted output. */
function scripted(outputs, status = 1) {
  const seen = [];
  const runner = (root) => {
    seen.push(JSON.parse(readFileSync(join(root, REL), "utf8")));
    return { status, stdout: outputs[seen.length - 1] ?? "", stderr: "" };
  };
  return { runner, seen };
}

test("leaves are scalars in document order, prose excluded", () => {
  assert.deepEqual(
    routeLeaves(structuredClone(FIXTURE), "/expected").map(([, , path]) => path),
    [
      "/expected/observationally_equal/0",
      "/expected/observationally_equal/1",
      "/expected/final_state/dependents_of/topic",
    ],
  );
});

test("a divergence line counts only for the mutated fixture", () => {
  assert.deepEqual(divergenceLines(DIVERGENCE, "pair.json"), [DIVERGENCE.trim()]);
  assert.deepEqual(divergenceLines(DIVERGENCE, "other.json"), []);
  assert.deepEqual(divergenceLines(LABEL_CRASH, "pair.json"), []);
});

test("a runner bookkeeping failure is not a kill", () => {
  withCorpus((corpus, mutationRoot) => {
    const { runner, seen } = scripted([LABEL_CRASH, LABEL_CRASH, DIVERGENCE]);
    const kill = killRoute({ corpus, rel: REL, route: "/expected", mutationRoot, runner, fail });
    assert.equal(kill.rejected_by, "divergence");
    assert.equal(kill.mutation.json_pointer, "/expected/final_state/dependents_of/topic");
    assert.deepEqual(
      kill.non_discriminating_mutants.map((item) => item.mutation.json_pointer),
      ["/expected/observationally_equal/0", "/expected/observationally_equal/1"],
    );
    // Exactly one leaf differs from the corpus per attempt.
    assert.deepEqual(seen[0].expected.observationally_equal, ["left__core_mutant__", "right"]);
    assert.deepEqual(seen[1].expected.observationally_equal, ["left", "right__core_mutant__"]);
    assert.deepEqual(seen[2].expected.final_state, { dependents_of: { topic: 1000004 } });
  });
});

test("a route without a divergence kill fails the report", () => {
  withCorpus((corpus, mutationRoot) => {
    const { runner, seen } = scripted([LABEL_CRASH, LABEL_CRASH, LABEL_CRASH]);
    assert.throws(
      () => killRoute({ corpus, rel: REL, route: "/expected", mutationRoot, runner, fail }),
      /rejected by a library divergence/,
    );
    assert.equal(seen.length, 3);
  });
});

test("a surviving mutant fails the report", () => {
  withCorpus((corpus, mutationRoot) => {
    const { runner } = scripted([""], 0);
    assert.throws(
      () => killRoute({ corpus, rel: REL, route: "/expected", mutationRoot, runner, fail }),
      /negative control survived/,
    );
  });
});
