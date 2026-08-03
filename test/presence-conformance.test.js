import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertKey, subBlock } from "./support/assert-key.js";

import { Context } from "../src/reactive.js";
import { AwarenessCell, EphemeralCell, PresenceCell } from "../src/presence.js";

const here = dirname(fileURLToPath(import.meta.url));
const specDir = join(here, "..", "..", "lazily-spec", "conformance", "presence");

function loadFixture(name) {
  const path = join(specDir, name);
  assert.ok(existsSync(path), `missing spec fixture ${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function observe(ctx, cell) {
  const obs = ctx.computed((cx) => cx.get(cell));
  ctx.get(obs);
  return obs;
}
function checkInval(ctx, obs, step, reader) {
  const wasCached = ctx.isSet(obs);
  ctx.get(obs);
  // The `invalidates` sub-block, descended rather than probed by name
  // (#lzsubblockkeyset): the child tracker owns every projection the corpus
  // declares, so a second one added upstream is reported as unconsumed instead
  // of being compared by nothing while this key still reports asserted.
  const invalidates = subBlock(step.expected, "invalidates");
  assertKey(invalidates, reader, !wasCached, `${reader} invalidation`);
}

test("PresenceCell", () => {
  const fx = loadFixture("presence.json");
  const ctx = new Context();
  const cell = new PresenceCell(ctx, fx.config.ttl);
  const obs = observe(ctx, cell.presentCell);
  for (const step of fx.steps) {
    const op = step.op;
    // No closing arm (#lzscenariobodyskip): the presence corpus union also
    // carries `set`, so an unmatched spelling drove nothing and `present` was
    // then compared against untouched state.
    if (op.type === "heartbeat") cell.heartbeat(op.peer, op.value, op.now);
    else if (op.type === "evict") cell.evict(op.peer, op.now);
    else if (op.type === "tick") cell.tick(op.now);
    else throw new Error(`unknown PresenceCell op type in fixture: ${op.type}`);
    assertKey(step.expected, "present", cell.present());
    checkInval(ctx, obs, step, "present");
  }
});

test("AwarenessCell", () => {
  const fx = loadFixture("awareness.json");
  const ctx = new Context();
  const cell = new AwarenessCell(ctx, fx.config.ttl);
  const obs = observe(ctx, cell.presentCell);
  for (const step of fx.steps) {
    const op = step.op;
    // No closing arm (#lzscenariobodyskip): an unmatched spelling skipped the op
    // and left `present` asserted against untouched state.
    if (op.type === "set") cell.set(op.peer, op.value, op.now);
    else if (op.type === "tick") cell.tick(op.now);
    else throw new Error(`unknown AwarenessCell op type in fixture: ${op.type}`);
    assertKey(step.expected, "present", cell.present());
    checkInval(ctx, obs, step, "present");
  }
});

test("EphemeralCell", () => {
  const fx = loadFixture("ephemeral.json");
  const ctx = new Context();
  const cell = new EphemeralCell(ctx);
  const obs = observe(ctx, cell.valueCell);
  for (const step of fx.steps) {
    const op = step.op;
    // No closing arm (#lzscenariobodyskip): an unmatched spelling skipped the op
    // and left `value` asserted against untouched state.
    if (op.type === "set") cell.set(op.value, op.now, op.ttl);
    else if (op.type === "tick") cell.tick(op.now);
    else throw new Error(`unknown EphemeralCell op type in fixture: ${op.type}`);
    assertKey(step.expected, "value", cell.value());
    checkInval(ctx, obs, step, "value");
  }
});
