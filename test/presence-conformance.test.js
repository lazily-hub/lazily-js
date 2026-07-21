import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

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
  const obs = ctx.computed(() => ctx.get(cell));
  ctx.get(obs);
  return obs;
}
function checkInval(ctx, obs, step, reader) {
  const wasCached = ctx.isSet(obs);
  ctx.get(obs);
  assert.equal(!wasCached, step.expected.invalidates[reader], `${reader} invalidation`);
}

test("PresenceCell", () => {
  const fx = loadFixture("presence.json");
  const ctx = new Context();
  const cell = new PresenceCell(ctx, fx.config.ttl);
  const obs = observe(ctx, cell.presentCell);
  for (const step of fx.steps) {
    const op = step.op;
    if (op.type === "heartbeat") cell.heartbeat(op.peer, op.value, op.now);
    else if (op.type === "evict") cell.evict(op.peer, op.now);
    else if (op.type === "tick") cell.tick(op.now);
    assert.deepEqual(cell.present(), step.expected.present);
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
    if (op.type === "set") cell.set(op.peer, op.value, op.now);
    else if (op.type === "tick") cell.tick(op.now);
    assert.deepEqual(cell.present(), step.expected.present);
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
    if (op.type === "set") cell.set(op.value, op.now, op.ttl);
    else if (op.type === "tick") cell.tick(op.now);
    assert.equal(cell.value(), step.expected.value);
    checkInval(ctx, obs, step, "value");
  }
});
