import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertKey, assertKeyWith } from "./support/assert-key.js";

import { Context } from "../src/reactive.js";
import {
  BarrierCell,
  LeaderCell,
  LeaseCell,
  LockCell,
  SemaphoreCell,
} from "../src/coordination.js";

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
  assertKeyWith(step.expected, "invalidates", (want) => {
    assert.equal(!wasCached, want[reader], `${reader} invalidation`);
  });
}

test("LeaseCell", () => {
  const fx = loadFixture("lease.json");
  const ctx = new Context();
  const lease = new LeaseCell(ctx);
  const obs = observe(ctx, lease.holderCell);
  for (const step of fx.steps) {
    const op = step.op;
    // The chain had no closing arm (#lzscenariobodyskip): the corpus `op.type`
    // union also carries `release` and `vote`, so an unmatched spelling drove
    // NOTHING and the `holder`/`held`/`fence` assertions below then compared the
    // fixture's expectations against untouched state — a step the ledger books
    // as replayed and nothing observed.
    if (op.type === "acquire") assert.equal(lease.acquire(op.peer, op.now, op.ttl), step.returns);
    else if (op.type === "renew") assert.equal(lease.renew(op.peer, op.now, op.ttl), step.returns);
    else if (op.type === "tick") assert.equal(lease.tick(op.now), step.returns);
    else throw new Error(`unknown LeaseCell op type in fixture: ${op.type}`);
    assertKey(step.expected, "holder", lease.holder(op.now));
    assertKey(step.expected, "held", lease.isHeld(op.now));
    assertKey(step.expected, "fence", lease.fence());
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
    // The final `else` assumed `tick` without checking it (#lzscenariobodyskip):
    // any unrecognised spelling ran the clock instead of the op the fixture
    // named, and `role` was then asserted against the wrong transition.
    if (op.type === "campaign") role = leader.campaign(op.now, op.ttl);
    else if (op.type === "contend") role = leader.contend(op.peer, op.now, op.ttl);
    else if (op.type === "tick") role = leader.tick(op.now);
    else throw new Error(`unknown LeaderCell op type in fixture: ${op.type}`);
    assertKey(step.expected, "role", role);
    assertKey(step.expected, "current_leader", leader.currentLeader(op.now));
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
    // No closing arm (#lzscenariobodyskip): an unmatched `op.type` skipped the
    // op AND its `returns` comparison, leaving `is_locked`/`fence` checked
    // against state nothing moved.
    if (op.type === "acquire") assert.equal(lock.acquire(op.peer, now, op.ttl), step.returns);
    else if (op.type === "validate") assert.equal(lock.validate(op.fence), step.returns);
    else if (op.type === "tick") assert.equal(lock.tick(now), step.returns);
    else throw new Error(`unknown LockCell op type in fixture: ${op.type}`);
    assertKey(step.expected, "is_locked", lock.isLocked(now));
    assertKey(step.expected, "fence", lock.fence());
    checkInval(ctx, obs, step, "is_locked");
  }
});

test("SemaphoreCell", () => {
  const fx = loadFixture("semaphore.json");
  const ctx = new Context();
  const sem = new SemaphoreCell(ctx, fx.config.capacity);
  const obs = observe(ctx, sem.permitsAvailableCell);
  for (const step of fx.steps) {
    // The `else` assumed `release` (#lzscenariobodyskip); the corpus union for
    // this family also carries acquire/renew/tick/validate/vote, so a fixture
    // that grew a new op would have released a permit instead.
    if (step.op.type === "acquire") assert.equal(sem.acquire(), step.returns);
    else if (step.op.type === "release") sem.release();
    else throw new Error(`unknown SemaphoreCell op type in fixture: ${step.op.type}`);
    assertKey(step.expected, "permits_available", sem.permitsAvailable());
    checkInval(ctx, obs, step, "permits_available");
  }
});

test("QuorumCell", () => {
  const fx = loadFixture("quorum.json");
  const ctx = new Context();
  const q = BarrierCell.quorum(ctx, fx.config.total);
  const obs = observe(ctx, q.isOpenCell);
  for (const step of fx.steps) {
    // `op.type` was never read here (#lzscenariobodyskip): every step was driven
    // as an arrival whatever the fixture named it, so a corpus that added a
    // second quorum op would have been replayed as a run of votes.
    if (step.op.type !== "vote") {
      throw new Error(`unknown QuorumCell op type in fixture: ${step.op.type}`);
    }
    assert.equal(q.arrive(step.op.peer), step.returns);
    assertKey(step.expected, "votes", q.count());
    assertKey(step.expected, "is_open", q.isOpen());
    checkInval(ctx, obs, step, "is_open");
  }
});
