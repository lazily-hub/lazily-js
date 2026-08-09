// Canonical boundary-ingress adapter replay (`#lzingressadapters`).

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { assertKey } from "./support/assert-key.js";
import { scenarios } from "./support/scenario.js";

import { specPath } from "./spec-corpus.cjs";

const FIXTURE = "ingress/boundary_ingress_adapter.json";

function loadFixture() {
  const path = specPath(FIXTURE);
  assert.ok(existsSync(path), `missing canonical spec fixture ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

class BoundaryModel {
  constructor(maxBuffered, freshnessHorizon) {
    this.maxBuffered = maxBuffered;
    this.freshnessHorizon = freshnessHorizon;
    this.phase = "detached";
    this.generation = 0;
    this.cursor = null;
    this.buffered = new Map();
    this.sourceKeys = new Set();
    this.members = new Set();
    this.validation = "valid";
    this.replayFrom = null;
    this.staleEvents = 0;
    this.delivery = null;
    this.lastStampedAt = null;
    this.now = 0;
    this.revision = 0;
  }

  changed() {
    this.revision += 1;
  }

  applyPayload(event) {
    if (event.action === "upsert") this.sourceKeys.add(event.key);
    else if (event.action === "remove") this.sourceKeys.delete(event.key);
    else if (event.action === "validate") this.validation = event.validation;
    else assert.fail(`unknown boundary action ${event.action}`);
    this.cursor = event.cursor;
    this.lastStampedAt = event.stamped_at;
    this.phase = this.validation === "valid" ? "live" : "invalid";
    this.replayFrom = null;
  }

  drain() {
    while (this.buffered.has(this.cursor + 1)) {
      const next = this.buffered.get(this.cursor + 1);
      this.buffered.delete(this.cursor + 1);
      this.applyPayload(next);
    }
    if (this.buffered.size > 0) {
      this.phase = "replay_required";
      this.replayFrom = this.cursor + 1;
    }
  }

  apply(op) {
    if (op.type === "subscribe") {
      if (op.generation < this.generation) return;
      this.generation = op.generation;
      this.cursor = null;
      this.buffered.clear();
      this.sourceKeys.clear();
      this.members.clear();
      this.validation = "valid";
      this.replayFrom = null;
      this.phase = "bootstrapping";
      this.changed();
      return;
    }
    if (op.type === "snapshot") {
      if (op.generation < this.generation) {
        this.staleEvents += 1;
        this.changed();
        return;
      }
      if (op.generation > this.generation) {
        this.generation = op.generation;
        this.buffered.clear();
      }
      this.cursor = op.cursor;
      this.lastStampedAt = op.stamped_at;
      this.sourceKeys = new Set(op.source_keys);
      this.members = new Set(op.members);
      this.validation = op.validation;
      this.phase = this.validation === "valid" ? "live" : "invalid";
      this.replayFrom = null;
      this.buffered = new Map([...this.buffered].filter(([cursor]) => cursor > this.cursor));
      this.drain();
      this.changed();
      return;
    }
    if (op.type === "event") {
      if (op.generation < this.generation) {
        this.staleEvents += 1;
        this.changed();
        return;
      }
      if (op.generation > this.generation) {
        this.generation = op.generation;
        this.cursor = null;
        this.buffered.clear();
        this.sourceKeys.clear();
        this.members.clear();
        this.phase = "bootstrapping";
        this.replayFrom = null;
      }
      if (this.cursor === null) {
        if (this.buffered.size >= this.maxBuffered && !this.buffered.has(op.cursor)) {
          this.phase = "backpressured";
          this.replayFrom = 0;
          this.changed();
          return;
        }
        if (!this.buffered.has(op.cursor)) {
          this.buffered.set(op.cursor, op);
          this.changed();
        }
        return;
      }
      if (op.cursor <= this.cursor || this.buffered.has(op.cursor)) return;
      if (op.cursor === this.cursor + 1) {
        this.applyPayload(op);
        this.drain();
        this.changed();
        return;
      }
      if (this.buffered.size >= this.maxBuffered) {
        this.phase = "backpressured";
        this.replayFrom = this.cursor + 1;
        this.changed();
        return;
      }
      this.buffered.set(op.cursor, op);
      this.phase = "replay_required";
      this.replayFrom = this.cursor + 1;
      this.changed();
      return;
    }
    if (op.type === "member_join") {
      if (this.members.has(op.member)) return;
      this.members.add(op.member);
      if (this.delivery !== null && this.delivery.targets.size === 0) {
        this.delivery.targets.add(op.member);
      }
      this.changed();
      return;
    }
    if (op.type === "member_leave") {
      if (this.members.delete(op.member)) this.changed();
      return;
    }
    if (op.type === "open_receipt") {
      this.delivery = {
        receiptId: op.receipt_id,
        targets: new Set(this.members),
        acked: new Set(),
      };
      this.changed();
      return;
    }
    if (op.type === "ack") {
      if (this.delivery === null || this.delivery.receiptId !== op.receipt_id) return;
      if (this.delivery.targets.has(op.member) && !this.delivery.acked.has(op.member)) {
        this.delivery.acked.add(op.member);
        this.changed();
      }
      return;
    }
    if (op.type === "tick") {
      const before = this.fresh();
      this.now = op.now;
      if (this.fresh() !== before) this.changed();
      return;
    }
    assert.fail(`unknown boundary op ${op.type}`);
  }

  fresh() {
    return this.lastStampedAt !== null && this.now - this.lastStampedAt <= this.freshnessHorizon;
  }

  projection() {
    let delivery = null;
    if (this.delivery !== null) {
      const targets = [...this.delivery.targets].sort();
      const acked = [...this.delivery.acked].sort();
      delivery = {
        receipt_id: this.delivery.receiptId,
        targets,
        acked,
        converged: targets.length > 0 && targets.every((member) => this.delivery.acked.has(member)),
      };
    }
    return {
      phase: this.phase,
      generation: this.generation,
      cursor: this.cursor,
      buffered_cursors: [...this.buffered.keys()].sort((a, b) => a - b),
      source_keys: [...this.sourceKeys].sort(),
      members: [...this.members].sort(),
      validation: this.validation,
      replay_from: this.replayFrom,
      stale_events: this.staleEvents,
      delivery,
      ready: this.phase === "live" && this.validation === "valid",
      fresh: this.fresh(),
      observation_revision: this.revision,
      revision: this.revision,
    };
  }
}

test("boundary ingress adapter replays the canonical contract", () => {
  const fixture = loadFixture();
  let replayed = 0;
  for (const scenario of scenarios(fixture)) {
    const policy = { ...fixture.policy, ...(scenario.policy ?? {}) };
    const model = new BoundaryModel(policy.max_buffered, policy.freshness_horizon);
    for (const [index, step] of scenario.steps.entries()) {
      model.apply(step.op);
      const actual = model.projection();
      for (const key of Object.keys(step.expected)) {
        assertKey(step.expected, key, actual[key], `${scenario.id} step ${index}`);
      }
      replayed += 1;
    }
  }
  assert.ok(replayed > 0, "the canonical fixture must execute steps");
});
