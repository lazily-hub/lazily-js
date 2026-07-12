import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  Delta,
  IpcMessage,
  InMemoryOutbox,
  OrSet,
  OutboxAck,
  ResyncAction,
  ResyncCoordinator,
  ResyncRequest,
  WireLwwRegister,
  WireStamp,
} from "../src/index.js";

// Replays the canonical lazily-spec/conformance/reliable-sync fixtures against the
// native ResyncCoordinator / InMemoryOutbox / OrSet / WireLwwRegister, and
// round-trips the two control frames (ResyncRequest / OutboxAck) through JSON.
// Cross-language pin with lazily-rs / lazily-kt; backstop lazily-formal ReliableSync.lean.

const here = dirname(fileURLToPath(import.meta.url));
const specDir = join(here, "..", "..", "lazily-spec", "conformance", "reliable-sync");
const localDir = join(here, "conformance", "reliable-sync");

function loadFixture(name) {
  const specPath = join(specDir, name);
  const path = existsSync(specPath) ? specPath : join(localDir, name);
  return JSON.parse(readFileSync(path, "utf8"));
}

const scenario = (fx, name) => fx.scenarios.find((s) => s.name === name);
const msg = (wire) => IpcMessage.fromWire(wire);

// -- control-frame serde round-trip -----------------------------------------

test("reliable-sync: ResyncRequest round-trips JSON", () => {
  const m = IpcMessage.resyncRequestMessage(new ResyncRequest({ fromEpoch: 2 }));
  const text = JSON.stringify(m.toWire());
  assert.equal(text, '{"ResyncRequest":{"from_epoch":2}}');
  assert.deepEqual(IpcMessage.decodeJson(text).toWire(), m.toWire());
});

test("reliable-sync: OutboxAck round-trips JSON", () => {
  const m = IpcMessage.outboxAckMessage(new OutboxAck({ throughEpoch: 41 }));
  const text = JSON.stringify(m.toWire());
  assert.equal(text, '{"OutboxAck":{"through_epoch":41}}');
  assert.deepEqual(IpcMessage.decodeJson(text).toWire(), m.toWire());
});

// -- multi_epoch_delta.json -------------------------------------------------

test("reliable-sync: multi_epoch_delta.json", () => {
  const fx = loadFixture("multi_epoch_delta.json");
  assert.equal(fx.kind, "ReliableSync");

  const sc = scenario(fx, "span_3_applies_equal_to_unit_fold");
  const { base_epoch: base, epoch } = sc.delta;
  assert.ok(epoch > base + 1, "fixture pins a multi-epoch span");
  const delta = new Delta({ baseEpoch: base, epoch });
  assert.equal(delta.span(), epoch - base);
  const coord = new ResyncCoordinator(sc.receiver_last_epoch);
  assert.equal(coord.ingestDelta(delta).action, ResyncAction.Apply);
  assert.equal(coord.lastEpoch, sc.expect.receiver_last_epoch_after);

  const gap = scenario(fx, "gap_rule_unchanged_under_span");
  const gc = new ResyncCoordinator(gap.receiver_last_epoch);
  const res = gc.ingestDelta(new Delta({ baseEpoch: gap.delta.base_epoch, epoch: gap.delta.epoch }));
  assert.equal(res.action, ResyncAction.RequestSnapshot);
  assert.equal(res.fromEpoch, gap.expect.request_from);
  assert.equal(gc.lastEpoch, gap.receiver_last_epoch);
});

// -- resync_gap_converge.json -----------------------------------------------

test("reliable-sync: resync_gap_converge.json", () => {
  const fx = loadFixture("resync_gap_converge.json");

  const sc = scenario(fx, "drop_suffix_then_resync_converges");
  const coord = new ResyncCoordinator(sc.start_last_epoch);
  let requests = 0;
  for (const frame of sc.inbound) {
    if (frame.dropped) continue;
    const res = coord.ingest(msg(frame.frame));
    if (frame.expect_action === "Apply") {
      assert.equal(res.action, ResyncAction.Apply);
    } else if (frame.expect_action === "RequestSnapshot") {
      requests++;
      assert.equal(res.action, ResyncAction.RequestSnapshot);
      assert.equal(res.fromEpoch, frame.request_from);
    } else {
      assert.equal(res.action, ResyncAction.Ignore);
    }
    assert.equal(coord.lastEpoch, frame.last_epoch_after);
  }
  assert.equal(coord.lastEpoch, sc.expect.final_last_epoch);
  assert.equal(requests, sc.expect.resync_requests_emitted);

  const single = scenario(fx, "single_request_per_gap");
  const c2 = new ResyncCoordinator(single.start_last_epoch);
  let req2 = 0;
  for (const frame of single.inbound) {
    if (c2.ingest(msg(frame.frame)).action === ResyncAction.RequestSnapshot) req2++;
  }
  assert.equal(req2, single.expect.resync_requests_emitted);
});

// -- idempotent_redelivery.json ---------------------------------------------

test("reliable-sync: idempotent_redelivery.json", () => {
  const fx = loadFixture("idempotent_redelivery.json");
  for (const name of ["replayed_delta_is_ignored", "duplicate_current_head_is_ignored"]) {
    const sc = scenario(fx, name);
    const coord = new ResyncCoordinator(sc.start_last_epoch);
    for (const frame of sc.inbound) {
      assert.equal(coord.ingest(msg(frame.frame)).action, ResyncAction.Ignore, name);
      assert.equal(coord.lastEpoch, frame.last_epoch_after);
    }
    assert.equal(coord.lastEpoch, sc.expect.final_last_epoch);
  }
});

// -- a reference file-backed durable outbox (crash-replay test helper) --------

class FileOutbox {
  constructor(path) {
    this.path = path;
    this.ackedThrough = 0;
    if (!existsSync(path)) writeFileSync(path, "");
  }

  #readAll() {
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        const [epoch, wire] = JSON.parse(l);
        return [epoch, IpcMessage.fromWire(wire)];
      });
  }

  append(epoch, m) {
    appendFileSync(this.path, `${JSON.stringify([epoch, m.toWire()])}\n`);
  }

  ackThrough(epoch) {
    if (epoch > this.ackedThrough) this.ackedThrough = epoch;
    const retained = this.#readAll().filter(([e]) => e > this.ackedThrough);
    writeFileSync(this.path, retained.map(([e, m]) => `${JSON.stringify([e, m.toWire()])}\n`).join(""));
  }

  replayFrom(cursor) {
    return this.#readAll().filter(([e]) => e > cursor).sort((a, b) => a[0] - b[0]);
  }

  retainedEpochs() {
    return this.#readAll().map(([e]) => e).sort((a, b) => a - b);
  }
}

const framesOf = (sc, key) => sc[key].map((e) => [e.epoch, IpcMessage.fromWire(e.frame)]);

// -- outbox_replay_after_crash.json -----------------------------------------

test("reliable-sync: outbox_replay_after_crash.json", () => {
  const fx = loadFixture("outbox_replay_after_crash.json");
  const sc = scenario(fx, "crash_between_append_and_ack_replays_on_reconnect");
  const appended = framesOf(sc, "appended");
  const ack = sc.ack_through;
  const cursor = sc.reconnect_cursor;

  const dir = mkdtempSync(join(tmpdir(), "lz_outbox_js_"));
  const path = join(dir, "outbox.jsonl");

  const mem = new InMemoryOutbox();
  let file = new FileOutbox(path);
  for (const [e, m] of appended) {
    mem.append(e, m);
    file.append(e, m);
  }
  mem.ackThrough(ack);
  file.ackThrough(ack);

  assert.deepEqual(mem.retainedEpochs(), sc.expect.retained_after_ack);
  assert.deepEqual(file.retainedEpochs(), sc.expect.retained_after_ack);

  // "crash": reopen the durable file outbox from disk.
  file = new FileOutbox(path);
  const replay = file.replayFrom(cursor);
  assert.deepEqual(replay.map(([e]) => e), sc.expect.replayed_from_cursor);

  const coord = new ResyncCoordinator(cursor);
  const applied = [];
  for (const [, m] of replay) {
    if (coord.ingest(m).action === ResyncAction.Apply) applied.push(coord.lastEpoch);
  }
  assert.deepEqual(applied, sc.expect.receiver_applies);
  assert.equal(coord.lastEpoch, sc.expect.receiver_last_epoch_after);

  // send_failure_retains_frame_for_next_tick
  const sc2 = scenario(fx, "send_failure_retains_frame_for_next_tick");
  const mem2 = new InMemoryOutbox();
  for (const [e, m] of framesOf(sc2, "appended")) mem2.append(e, m);
  assert.deepEqual(mem2.retainedEpochs(), sc2.expect.retained);
  assert.deepEqual(
    mem2.replayFrom(sc2.expect.retained[0] - 1).map(([e]) => e),
    sc2.expect.retained,
  );

  rmSync(dir, { recursive: true, force: true });
});

// -- liveness_orset_lww.json ------------------------------------------------

const stamp = (o) => new WireStamp({ wallTime: o.wall_time, logical: o.logical, peer: o.peer });

test("reliable-sync: liveness_orset_lww.json", () => {
  const fx = loadFixture("liveness_orset_lww.json");

  const add = scenario(fx, "open_set_add_wins_over_stale_remove");
  const set = new OrSet();
  for (const op of add.ops) {
    if (op.op === "add") set.add(op.tag);
    else if (op.op === "remove") set.removeObserved(op.observed_tags);
  }
  assert.equal(set.present(), add.expect.present);

  const lww = scenario(fx, "lww_alive_highest_stamp_wins");
  const reg = new WireLwwRegister(stamp(lww.ops[0].stamp), lww.ops[0].value);
  for (const op of lww.ops.slice(1)) reg.set(stamp(op.stamp), op.value);
  assert.equal(reg.value, lww.expect.value);

  const death = scenario(fx, "whole_editor_death_cascades");
  const open = death.open_set
    .filter((e) => e.present)
    .map((e) => {
      const [doc, pid] = e.key.split("/");
      return [doc, Number(pid.replace("pid", ""))];
    });
  const alive = new Map();
  for (const [pid, v] of Object.entries(death.alive_before)) {
    alive.set(Number(pid), new WireLwwRegister(new WireStamp({ wallTime: 1, logical: 0, peer: 1 }), v));
  }
  const op = death.op;
  const pid = Number(op.key.replace("alive/pid", ""));
  alive.get(pid).set(stamp(op.stamp), op.value);
  const live = [...new Set(open.filter(([, p]) => alive.get(p)?.value === true).map(([doc]) => doc))].sort();
  assert.deepEqual(live, [...death.expect.live_docs_after].sort());
});
