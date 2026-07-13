import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  Delta,
  DriverError,
  IpcMessage,
  InMemoryOutbox,
  InMemoryStore,
  OrSet,
  OutboxAck,
  Outbox,
  Progress,
  ResyncAction,
  ResyncCoordinator,
  ResyncRequest,
  Snapshot,
  SyncDriver,
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

test("reliable-sync: generic Outbox owns cursor, prune, and replay", () => {
  const store = new InMemoryStore();
  const first = new Outbox(store);
  const one = IpcMessage.delta(new Delta({ baseEpoch: 0, epoch: 1 }));
  const two = IpcMessage.delta(new Delta({ baseEpoch: 1, epoch: 2 }));
  first.append(1, one);
  first.append(2, two);
  first.ackThrough(1);

  const reopened = new Outbox(store);
  assert.equal(reopened.ackedThrough, 1);
  assert.deepEqual(reopened.retainedEpochs(), [2]);
  assert.deepEqual(reopened.replayFrom(0).map(([epoch, msg]) => [epoch, msg.toWire()]), [
    [2, two.toWire()],
  ]);
});

test("reliable-sync: outbox_store_protocol.json", () => {
  const fixture = loadFixture("outbox_store_protocol.json");
  assert.equal(fixture.model, "OutboxStore");

  for (const entry of fixture.scenarios) {
    const store = new InMemoryStore();
    const outbox = new Outbox(store);
    for (const epoch of entry.put_epochs) {
      outbox.append(epoch, IpcMessage.delta(new Delta({ baseEpoch: epoch - 1, epoch })));
    }
    if (entry.scan_after !== undefined) {
      assert.deepEqual(
        outbox.replayFrom(entry.scan_after).map(([epoch]) => epoch),
        entry.expect.epochs,
        entry.name,
      );
    }
    for (const epoch of entry.ack_through ?? []) outbox.ackThrough(epoch);
    const observed = entry.restart ? new Outbox(store) : outbox;
    if (entry.expect.cursor !== undefined) assert.equal(observed.ackedThrough, entry.expect.cursor, entry.name);
    if (entry.expect.loaded_cursor !== undefined) {
      assert.equal(observed.ackedThrough, entry.expect.loaded_cursor, entry.name);
    }
    if (entry.expect.retained !== undefined) {
      assert.deepEqual(observed.retainedEpochs(), entry.expect.retained, entry.name);
    }
    const expectedReplay = entry.expect.replay_from_zero ?? entry.expect.replay;
    if (expectedReplay !== undefined) {
      assert.deepEqual(observed.replayFrom(0).map(([epoch]) => epoch), expectedReplay, entry.name);
    }
  }
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

// -- SyncDriver (#sync-driver): the loop-shape mechanism over a scripted seam --
//
// A SimWorld-style deterministic transport pair mirroring lazily-rs: the sink
// records what the driver sends (and can be toggled "down" to model a
// disconnect); the source replays a scripted inbound stream (and can inject one
// read error). No threads, no real socket — every tick is a pure step. The seam
// carries no wire form of its own, so it has no conformance fixture (the
// message-sequence fixtures above already pin the driver's observable behavior);
// these unit tests pin the loop shape the spec § SyncDriver requires.

function makeWire() {
  return { sent: [], inbound: [], up: true, sourceErr: false };
}

// SnapshotProvider that answers ResyncRequest{from} with a snapshot at from + 5.
const snapAhead = { snapshot: (from) => IpcMessage.snapshot(new Snapshot({ epoch: from + 5 })) };
const zeroClock = { nowMillis: () => 0 };

function driverAt(wire, lastEpoch) {
  const sink = {
    send(m) {
      if (!wire.up) return false;
      wire.sent.push(m);
      return true;
    },
  };
  const source = {
    recv() {
      if (wire.sourceErr) {
        wire.sourceErr = false;
        throw new Error("scripted source read failure");
      }
      return wire.inbound.shift() ?? null;
    },
  };
  return new SyncDriver({
    sink,
    source,
    outbox: new InMemoryOutbox(),
    clock: zeroClock,
    provider: snapAhead,
    lastEpoch,
  });
}

const dframe = (base, epoch) => IpcMessage.delta(new Delta({ baseEpoch: base, epoch }));

test("sync-driver: drains append-before-send and retains until acked", () => {
  const wire = makeWire();
  const d = driverAt(wire, 0);
  d.enqueue(1, dframe(0, 1));
  d.enqueue(2, dframe(1, 2));
  let p = d.tick();
  assert.ok(p instanceof Progress);
  assert.equal(p.sent, 2, "both fresh frames pushed to the sink");
  assert.equal(wire.sent.length, 2);
  assert.equal(p.retained, 2, "appended-before-send, retained until acked");
  assert.equal(d.isStalled(), false);

  // Peer proves receipt → the outbox prunes and the resume cursor advances.
  wire.inbound.push(IpcMessage.outboxAckMessage(new OutboxAck({ throughEpoch: 2 })));
  p = d.tick();
  assert.equal(p.peerAckedThrough, 2);
  assert.equal(p.retained, 0, "acked frames pruned");
});

test("sync-driver: retains on send failure and replays on reconnect", () => {
  const wire = makeWire();
  const d = driverAt(wire, 0);
  wire.up = false; // sink down before the first send
  d.enqueue(1, dframe(0, 1));
  let p = d.tick();
  assert.equal(p.sent, 0);
  assert.equal(d.isStalled(), true, "a failed send stalls the driver");
  assert.equal(p.retained, 1, "frame retained in the outbox despite the failure");
  assert.equal(wire.sent.length, 0);
  assert.equal(d.stalledFor(250), 250, "stall duration is a host backoff signal");

  // Transport recovers → the unacked suffix replays from the ack cursor.
  wire.up = true;
  d.onReconnect();
  p = d.tick();
  assert.equal(d.isStalled(), false);
  assert.equal(p.sent, 1, "the retained frame is replayed");
  assert.ok(
    wire.sent.some((m) => m.isDelta && m.delta.epoch === 1),
    "the replayed delta reached the sink",
  );
});

test("sync-driver: applies inbound delta and advertises receiver cursor", () => {
  const wire = makeWire();
  const d = driverAt(wire, 0);
  wire.inbound.push(dframe(0, 1));
  const p = d.tick();
  assert.equal(p.applied.length, 1, "the applied frame is handed to the host");
  assert.equal(d.lastEpoch(), 1);
  assert.ok(
    wire.sent.some((m) => m.isOutboxAck && m.outboxAck.throughEpoch === 1),
    "an OutboxAck advertising the new cursor was sent",
  );
});

test("sync-driver: re-delivery is an idempotent no-op", () => {
  const wire = makeWire();
  const d = driverAt(wire, 0);
  wire.inbound.push(dframe(0, 1));
  assert.equal(d.tick().applied.length, 1);
  // Re-deliver the exact same frame (an outbox replay from the peer).
  wire.inbound.push(dframe(0, 1));
  const p = d.tick();
  assert.equal(p.applied.length, 0, "already-applied re-delivery is ignored");
  assert.equal(d.lastEpoch(), 1, "cursor does not double-advance");
});

test("sync-driver: requests a snapshot on an inbound gap", () => {
  const wire = makeWire();
  const d = driverAt(wire, 2);
  wire.inbound.push(dframe(3, 4)); // base 3 > last 2 → gap
  const p = d.tick();
  assert.equal(p.resyncRequested, true);
  assert.equal(p.applied.length, 0, "the gapped delta is not applied");
  assert.ok(
    wire.sent.some((m) => m.isResyncRequest && m.resyncRequest.fromEpoch === 2),
    "a ResyncRequest at the current cursor was emitted",
  );
});

test("sync-driver: answers a ResyncRequest with a provider snapshot", () => {
  const wire = makeWire();
  const d = driverAt(wire, 0);
  wire.inbound.push(IpcMessage.resyncRequestMessage(new ResyncRequest({ fromEpoch: 2 })));
  const p = d.tick();
  assert.equal(p.snapshotsServed, 1);
  assert.ok(
    wire.sent.some((m) => m.isSnapshot && m.snapshot.epoch === 7),
    "a covering snapshot (from + 5) was sent",
  );
});

test("sync-driver: surfaces a source read error as DriverError", () => {
  const wire = makeWire();
  const d = driverAt(wire, 0);
  wire.sourceErr = true;
  assert.throws(() => d.tick(), (e) => e instanceof DriverError && e.kind === "Source");
});

test("sync-driver: gap then covering snapshot converges", () => {
  const wire = makeWire();
  const d = driverAt(wire, 2);
  wire.inbound.push(dframe(4, 5)); // gap
  d.tick();
  assert.equal(d.lastEpoch(), 2, "still stuck at the pre-gap cursor");
  wire.inbound.push(IpcMessage.snapshot(new Snapshot({ epoch: 5 })));
  const p = d.tick();
  assert.equal(p.applied.length, 1);
  assert.equal(d.lastEpoch(), 5, "snapshot restored convergence");
});
