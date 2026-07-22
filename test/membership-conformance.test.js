import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Context } from "../src/reactive.js";
import { MembershipCell } from "../src/membership.js";

const here = dirname(fileURLToPath(import.meta.url));
const specDir = join(here, "..", "..", "lazily-spec", "conformance", "membership");

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
    for (const [peer, want] of Object.entries(exp.states)) {
      assert.equal(m.state(Number(peer)), want, `state of peer ${peer}`);
    }
    assert.deepEqual(m.peerSet(), exp.alive_set, "alive_set");

    const wasCached = ctx.isSet(observed);
    ctx.get(observed);
    assert.equal(!wasCached, exp.invalidates, "invalidation");
  }
});
