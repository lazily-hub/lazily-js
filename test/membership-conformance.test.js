import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { assertKey, subBlock } from "./support/assert-key.js";

import { Context } from "../src/reactive.js";
import { MembershipCell } from "../src/membership.js";

import { specPath } from "./spec-corpus.cjs";

const specDir = specPath("membership");

function loadFixture(name) {
  const path = join(specDir, name);
  assert.ok(existsSync(path), `missing spec fixture ${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

test("MembershipCell lifecycle", () => {
  const fx = loadFixture("membership_lifecycle.json");
  const c = fx.config;
  const config = {
    phiThreshold: c.phi_threshold,
    suspectTimeout: c.suspect_timeout,
    maxSamples: c.max_samples,
    minStd: c.min_std,
  };
  const ctx = new Context();
  const m = new MembershipCell(ctx, config);
  const observed = ctx.computed((cx) => cx.get(m.peerSetCell));
  ctx.get(observed);

  for (const step of fx.steps) {
    const op = step.op;
    if (op.type === "join") m.join(op.peer, op.now);
    else if (op.type === "heartbeat") m.heartbeat(op.peer, op.now);
    else if (op.type === "leave") m.leave(op.peer, op.now);
    else if (op.type === "tick") m.tick(op.now);
    else throw new Error(`unknown op ${op.type}`);

    const exp = step.expected;
    // Descended (#lzsubblockkeyset): the child tracker owns every peer the
    // fixture names, so one added upstream is unconsumed rather than skipped.
    const states = subBlock(exp, "states");
    for (const peer of Object.keys(states)) {
      assertKey(states, peer, m.state(Number(peer)), `state of peer ${peer}`);
    }
    assertKey(exp, "alive_set", m.peerSet(), "alive_set");

    const wasCached = ctx.isSet(observed);
    ctx.get(observed);
    assertKey(exp, "invalidates", !wasCached, "invalidation");
  }
});
