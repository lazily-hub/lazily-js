import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Context } from "../src/reactive.js";
import { DiscoveryCell, HealthCell, ReadinessCell, ServiceRegistry } from "../src/service.js";

const here = dirname(fileURLToPath(import.meta.url));
const specDir = join(here, "..", "..", "lazily-spec", "conformance", "service");

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
  assert.equal(!wasCached, step.expected.invalidates[reader], `${reader} invalidation`);
}

test("HealthCell", () => {
  const fx = loadFixture("health.json");
  const ctx = new Context();
  const h = new HealthCell(ctx);
  const obs = observe(ctx, h.healthCell);
  for (const step of fx.steps) {
    const op = step.op;
    h.set(op.name, op.up, op.critical);
    assert.equal(h.health(), step.expected.health);
    checkInval(ctx, obs, step, "health");
  }
});

test("ReadinessCell", () => {
  const fx = loadFixture("readiness.json");
  const ctx = new Context();
  const r = new ReadinessCell(ctx);
  const obs = observe(ctx, r.readyCell);
  for (const step of fx.steps) {
    r.set(step.op.name, step.op.ready);
    assert.equal(r.ready(), step.expected.ready);
    checkInval(ctx, obs, step, "ready");
  }
});

test("DiscoveryCell", () => {
  const fx = loadFixture("discovery.json");
  const ctx = new Context();
  const d = new DiscoveryCell(ctx);
  const obs = observe(ctx, d.discoveryCell);
  for (const step of fx.steps) {
    const op = step.op;
    if (op.type === "register") d.register(op.service, op.endpoint, op.peer);
    else if (op.type === "deregister") d.deregister(op.service);
    else if (op.type === "evict") d.evict(op.peer);
    else if (op.type === "resolve") assert.equal(d.resolve(op.service), step.returns);
    assert.deepEqual(d.discovery(), step.expected.discovery);
    checkInval(ctx, obs, step, "discovery");
  }
});

test("ServiceRegistry", () => {
  const fx = loadFixture("service_registry.json");
  const ctx = new Context();
  const reg = new ServiceRegistry(ctx);
  const obs = observe(ctx, reg.projectionCell);
  for (const step of fx.steps) {
    const op = step.op;
    if (op.type === "register") reg.register(op.service, op.endpoint);
    else if (op.type === "deregister") reg.deregister(op.service);
    else if (op.type === "replay") reg.replay();
    assert.deepEqual(reg.projection(), step.expected.projection);
    checkInval(ctx, obs, step, "projection");
  }
});
