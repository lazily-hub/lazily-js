import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Context } from "../src/reactive.js";
import { BarrierCell, LeaderCell, LeaseCell, LockCell, SemaphoreCell } from "../src/coordination.js";

const here = dirname(fileURLToPath(import.meta.url));
const specDir = join(here, "..", "..", "lazily-spec", "conformance", "coordination");

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

test("LeaseCell", () => {
  const fx = loadFixture("lease.json");
  const ctx = new Context();
  const lease = new LeaseCell(ctx);
  const obs = observe(ctx, lease.holderCell);
  for (const step of fx.steps) {
    const op = step.op;
    if (op.type === "acquire") assert.equal(lease.acquire(op.peer, op.now, op.ttl), step.returns);
    else if (op.type === "renew") assert.equal(lease.renew(op.peer, op.now, op.ttl), step.returns);
    else if (op.type === "tick") assert.equal(lease.tick(op.now), step.returns);
    assert.equal(lease.holder(op.now), step.expected.holder);
    assert.equal(lease.isHeld(op.now), step.expected.held);
    assert.equal(lease.fence(), step.expected.fence);
    checkInval(ctx, obs, step, "holder");
  }
});

test("LeaderCell", () => {
  const fx = loadFixture("leader.json");
  const ctx = new Context();
  const leader = new LeaderCell(ctx, fx.config.me);
  const obs = observe(ctx, leader.currentLeaderCell);
  for (const step of fx.steps) {
    const op = step.op;
    let role;
    if (op.type === "campaign") role = leader.campaign(op.now, op.ttl);
    else if (op.type === "contend") role = leader.contend(op.peer, op.now, op.ttl);
    else role = leader.tick(op.now);
    assert.equal(role, step.expected.role);
    assert.equal(leader.currentLeader(op.now), step.expected.current_leader);
    checkInval(ctx, obs, step, "current_leader");
  }
});

test("LockCell", () => {
  const fx = loadFixture("lock.json");
  const ctx = new Context();
  const lock = new LockCell(ctx);
  const obs = observe(ctx, lock.isLockedCell);
  for (const step of fx.steps) {
    const op = step.op;
    const now = op.now ?? 0;
    if (op.type === "acquire") assert.equal(lock.acquire(op.peer, now, op.ttl), step.returns);
    else if (op.type === "validate") assert.equal(lock.validate(op.fence), step.returns);
    else if (op.type === "tick") assert.equal(lock.tick(now), step.returns);
    assert.equal(lock.isLocked(now), step.expected.is_locked);
    assert.equal(lock.fence(), step.expected.fence);
    checkInval(ctx, obs, step, "is_locked");
  }
});

test("SemaphoreCell", () => {
  const fx = loadFixture("semaphore.json");
  const ctx = new Context();
  const sem = new SemaphoreCell(ctx, fx.config.capacity);
  const obs = observe(ctx, sem.permitsAvailableCell);
  for (const step of fx.steps) {
    if (step.op.type === "acquire") assert.equal(sem.acquire(), step.returns);
    else sem.release();
    assert.equal(sem.permitsAvailable(), step.expected.permits_available);
    checkInval(ctx, obs, step, "permits_available");
  }
});

test("QuorumCell", () => {
  const fx = loadFixture("quorum.json");
  const ctx = new Context();
  const q = BarrierCell.quorum(ctx, fx.config.total);
  const obs = observe(ctx, q.isOpenCell);
  for (const step of fx.steps) {
    assert.equal(q.arrive(step.op.peer), step.returns);
    assert.equal(q.count(), step.expected.votes);
    assert.equal(q.isOpen(), step.expected.is_open);
    checkInval(ctx, obs, step, "is_open");
  }
});
