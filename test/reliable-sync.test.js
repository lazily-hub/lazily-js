import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertKey, assertKeyWith } from "./support/assert-key.js";
import { scenarios } from "./support/scenario.js";

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
  wireStampGreater,
} from "../src/index.js";

// Replays the canonical lazily-spec/conformance/reliable-sync fixtures against the
// native ResyncCoordinator / InMemoryOutbox / OrSet / WireLwwRegister, and
// round-trips the two control frames (ResyncRequest / OutboxAck) through JSON.
// Cross-language pin with lazily-rs / lazily-kt; backstop lazily-formal ReliableSync.lean.

const here = dirname(fileURLToPath(import.meta.url));
const specDir = join(here, "..", "..", "lazily-spec", "conformance", "reliable-sync");

function loadFixture(name) {
  const path = join(specDir, name);
  assert.ok(
    existsSync(path),
    `missing canonical spec fixture ${path} — clone the lazily-spec sibling ` +
      `(git clone https://github.com/lazily-hub/lazily-spec.git ../lazily-spec)`,
  );
  return JSON.parse(readFileSync(path, "utf8"));
}

// Several fixtures here are replayed by NAME rather than by iteration, which is
// exactly the shape #lzscenariocoverage exists for: `liveness_orset_lww.json`
// carries four scenarios and this runner picked three, so the fourth simply never
// ran while both the coverage guard and the key guard stayed green.
//
// The SELECTION deliberately does not book (#lzscenariobodyskip). `.name` is a
// label read, and the `find` above walks past every scenario ahead of the match —
// booking here would credit each of those, and would credit a scenario this
// runner selected and then did nothing with. The booking rides on the scenario's
// payload instead, so it happens when the caller actually replays what it picked.
const scenario = (fx, name) => {
  const found = fx.scenarios.find((s) => s.name === name);
  assert.ok(found, `fixture has no scenario named ${name}`);
  return found;
};
const msg = (wire) => IpcMessage.fromWire(wire);

// -- receiver-side state model ----------------------------------------------
//
// Several fixtures state their outcome as a converged node map (`state_after`,
// `converged_nodes`) or as an op-accounting claim (`ops_lost`, `ops_doubled`).
// Those keys are the only ones that can tell "the coordinator returned Apply"
// apart from "the ops actually landed, once each": a coordinator that returned
// the right action while dropping or doubling the op list satisfies every epoch
// assertion in the corpus. Nothing in this runner folded a frame's ops before,
// so all of them were carried and never read.
//
// `{node: bytes}` is exactly the shape the fixtures use, so no translation layer
// stands between the observation and the claim.
function foldFrame(state, message) {
  if (message.isSnapshot) {
    state.clear();
    for (const node of message.snapshot.nodes) state.set(node.node, [...node.state.bytes]);
    return message.snapshot.nodes.length;
  }
  let applied = 0;
  for (const op of message.delta.ops) {
    if (op.node === undefined || op.payload === undefined) continue;
    state.set(op.node, [...op.payload.bytes]);
    applied += 1;
  }
  return applied;
}

const stateWire = (state) =>
  Object.fromEntries(
    [...state.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v]),
  );

const seedState = (wire) =>
  new Map(Object.entries(wire ?? {}).map(([node, bytes]) => [Number(node), [...bytes]]));

// Every (node, byte) an accepted frame carries, as a multiset, so a lost or
// doubled op is countable rather than merely invisible in the final state.
function opKeysOf(message) {
  if (message.isSnapshot) return [];
  return message.delta.ops
    .filter((op) => op.node !== undefined && op.payload !== undefined)
    .map((op) => `${op.node}=${[...op.payload.bytes].join(",")}`);
}

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
  assert.deepEqual(
    reopened.replayFrom(0).map(([epoch, msg]) => [epoch, msg.toWire()]),
    [[2, two.toWire()]],
  );
});

test("reliable-sync: outbox_store_protocol.json", () => {
  const fixture = loadFixture("outbox_store_protocol.json");
  assert.equal(fixture.model, "OutboxStore");

  for (const entry of scenarios(fixture)) {
    const store = new InMemoryStore();
    if (entry.save_cursor !== undefined) {
      const handles = { stale: new Outbox(store), current: new Outbox(store) };
      for (const write of entry.save_cursor) handles[write.handle].ackThrough(write.epoch);
      const observed = new Outbox(store);
      assertKey(entry.expect, "loaded_cursor", observed.ackedThrough, entry.name);
      continue;
    }
    const outbox = new Outbox(store);
    for (const epoch of entry.put_epochs) {
      outbox.append(epoch, IpcMessage.delta(new Delta({ baseEpoch: epoch - 1, epoch })));
    }
    if (entry.scan_after !== undefined) {
      assertKey(
        entry.expect,
        "epochs",
        outbox.replayFrom(entry.scan_after).map(([epoch]) => epoch),
        entry.name,
      );
    }
    for (const epoch of entry.ack_through ?? []) outbox.ackThrough(epoch);
    const observed = entry.restart ? new Outbox(store) : outbox;
    // Every key the entry carries is asserted, and an unmodelled one fails the
    // run rather than falling through — `in`, not `!== undefined`, so a key whose
    // canonical value IS `undefined` cannot slip past unchecked.
    for (const key of Object.keys(entry.expect)) {
      switch (key) {
        case "cursor":
          assertKey(entry.expect, "cursor", observed.ackedThrough, entry.name);
          break;
        case "loaded_cursor":
          assertKey(entry.expect, "loaded_cursor", observed.ackedThrough, entry.name);
          break;
        case "retained":
          assertKey(entry.expect, "retained", observed.retainedEpochs(), entry.name);
          break;
        case "epochs":
          break; // asserted above, against the `scan_after` replay
        case "replay":
        case "replay_from_zero":
          assertKey(
            entry.expect,
            key,
            observed.replayFrom(0).map(([epoch]) => epoch),
            entry.name,
          );
          break;
        default:
          assert.fail(`${entry.name}: unknown outbox_store_protocol expectation \`${key}\``);
      }
    }
  }
});

// -- multi_epoch_delta.json -------------------------------------------------

test("reliable-sync: multi_epoch_delta.json", () => {
  const fx = loadFixture("multi_epoch_delta.json");
  assert.equal(fx.kind, "ReliableSync");

  // The fixture's `assertions` block, decoded from the `wire` frame it ships.
  // Neither was touched before: the runner rebuilt bare epoch-only Deltas from
  // the scenarios, so `wire` was never decoded and all five keys — including
  // `op_count`, the one that would notice a dropped op list — went unread.
  const wireDelta = msg(fx.wire).delta;
  for (const key of Object.keys(fx.assertions)) {
    assertKeyWith(fx.assertions, key, (expected) => {
      switch (key) {
        case "base_epoch":
          assert.equal(wireDelta.baseEpoch, expected, key);
          break;
        case "epoch":
          assert.equal(wireDelta.epoch, expected, key);
          break;
        case "span":
          assert.equal(wireDelta.span(), expected, key);
          break;
        case "is_multi_epoch":
          assert.equal(wireDelta.epoch > wireDelta.baseEpoch + 1, expected, key);
          break;
        case "op_count":
          assert.equal(wireDelta.ops.length, expected, key);
          break;
        default:
          assert.fail(`multi_epoch_delta: unknown assertion key \`${key}\``);
      }
    });
  }

  for (const sc of scenarios(fx)) {
    const delta = msg({ Delta: sc.delta }).delta;
    const coord = new ResyncCoordinator(sc.receiver_last_epoch);
    const state = new Map();
    const res = coord.ingestDelta(delta);
    const applied = res.action === ResyncAction.Apply;
    if (applied) foldFrame(state, IpcMessage.delta(delta));

    for (const key of Object.keys(sc.expect)) {
      assertKeyWith(sc.expect, key, (expected) => {
        const where = `${sc.name}: ${key}`;
        switch (key) {
          case "action":
            assert.equal(res.action, ResyncAction[expected], where);
            break;
          case "applied":
            assert.equal(applied, expected, where);
            break;
          case "receiver_last_epoch_after":
            assert.equal(coord.lastEpoch, expected, where);
            break;
          case "request_from":
            assert.equal(res.fromEpoch, expected, where);
            break;
          // last_epoch jumps straight to `epoch`; it never stops at base+1, which
          // is where a receiver that folded the span as a run of unit deltas and
          // advanced per op would land.
          case "atomic_advance":
            assert.equal(
              coord.lastEpoch === delta.epoch && coord.lastEpoch !== delta.baseEpoch + 1,
              expected,
              where,
            );
            break;
          // batch = fold: the same ops delivered as unit deltas must leave the
          // same last_epoch AND the same node state. Comparing epochs alone would
          // pass on a receiver that advanced correctly and applied nothing.
          case "fold_equivalent": {
            const unitCoord = new ResyncCoordinator(sc.receiver_last_epoch);
            const unitState = new Map();
            for (const step of sc.equivalent_unit_fold ?? []) {
              const unit = msg({ Delta: step }).delta;
              if (unitCoord.ingestDelta(unit).action === ResyncAction.Apply) {
                foldFrame(unitState, IpcMessage.delta(unit));
              }
            }
            assert.equal(
              unitCoord.lastEpoch === coord.lastEpoch &&
                JSON.stringify(stateWire(unitState)) === JSON.stringify(stateWire(state)),
              expected,
              where,
            );
            break;
          }
          default:
            assert.fail(`${sc.name}: unknown expectation \`${key}\``);
        }
      });
    }
  }
});

// -- resync_gap_converge.json -----------------------------------------------

test("reliable-sync: resync_gap_converge.json", () => {
  const fx = loadFixture("resync_gap_converge.json");

  const sc = scenario(fx, "drop_suffix_then_resync_converges");
  const coord = new ResyncCoordinator(sc.start_last_epoch);
  const state = new Map();
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
    if (res.action === ResyncAction.Apply) foldFrame(state, msg(frame.frame));
    assert.equal(coord.lastEpoch, frame.last_epoch_after);
  }

  // The receiver that missed nothing. `equals_no_drop_receiver` is the whole
  // claim of the scenario — that resync CONVERGES, not merely that it stops
  // requesting — and neither it nor `converged_nodes` was read before, so the
  // dropped-suffix receiver's graph was never compared to anything.
  const whole = new ResyncCoordinator(sc.start_last_epoch);
  const wholeState = new Map();
  for (const frame of sc.inbound) {
    if (!frame.frame) continue;
    if (whole.ingest(msg(frame.frame)).action === ResyncAction.Apply) {
      foldFrame(wholeState, msg(frame.frame));
    }
  }

  for (const key of Object.keys(sc.expect)) {
    assertKeyWith(sc.expect, key, (expected) => {
      const where = `drop_suffix_then_resync_converges: ${key}`;
      switch (key) {
        case "final_last_epoch":
          assert.equal(coord.lastEpoch, expected, where);
          break;
        case "resync_requests_emitted":
          assert.equal(requests, expected, where);
          break;
        case "converged_nodes":
          assert.deepEqual(stateWire(state), expected, where);
          break;
        case "equals_no_drop_receiver":
          assert.equal(
            JSON.stringify(stateWire(state)) === JSON.stringify(stateWire(wholeState)),
            expected,
            where,
          );
          break;
        default:
          assert.fail(`drop_suffix_then_resync_converges: unknown expectation \`${key}\``);
      }
    });
  }

  const single = scenario(fx, "single_request_per_gap");
  const c2 = new ResyncCoordinator(single.start_last_epoch);
  let req2 = 0;
  for (const frame of single.inbound) {
    if (c2.ingest(msg(frame.frame)).action === ResyncAction.RequestSnapshot) req2++;
  }
  for (const key of Object.keys(single.expect)) {
    assertKeyWith(single.expect, key, (expected) => {
      const where = `single_request_per_gap: ${key}`;
      switch (key) {
        case "final_last_epoch":
          assert.equal(c2.lastEpoch, expected, where);
          break;
        case "resync_requests_emitted":
          assert.equal(req2, expected, where);
          break;
        default:
          assert.fail(`single_request_per_gap: unknown expectation \`${key}\``);
      }
    });
  }
});

// -- idempotent_redelivery.json ---------------------------------------------

test("reliable-sync: idempotent_redelivery.json", () => {
  const fx = loadFixture("idempotent_redelivery.json");
  for (const name of ["replayed_delta_is_ignored", "duplicate_current_head_is_ignored"]) {
    const sc = scenario(fx, name);
    const coord = new ResyncCoordinator(sc.start_last_epoch);
    // The state the receiver already holds. Folding it is what makes the
    // redelivery test real: the replayed frame in the first scenario carries
    // node 1 = 99, so a receiver that double-applied would be caught HERE and
    // nowhere else — every epoch assertion in this fixture stays satisfied.
    const state = seedState(sc.state_before);
    for (const frame of sc.inbound) {
      const result = coord.ingest(msg(frame.frame));
      assert.equal(result.action, ResyncAction.Ignore, name);
      if (result.action === ResyncAction.Apply) foldFrame(state, msg(frame.frame));
      assert.equal(coord.lastEpoch, frame.last_epoch_after);
    }
    for (const key of Object.keys(sc.expect)) {
      assertKeyWith(sc.expect, key, (expected) => {
        const where = `${name}: ${key}`;
        switch (key) {
          case "final_last_epoch":
            assert.equal(coord.lastEpoch, expected, where);
            break;
          case "state_after":
            assert.deepEqual(stateWire(state), expected, where);
            break;
          case "net_effect_unchanged":
            assert.equal(
              JSON.stringify(stateWire(state)) ===
                JSON.stringify(stateWire(seedState(sc.state_before))),
              expected,
              where,
            );
            break;
          default:
            assert.fail(`${name}: unknown expectation \`${key}\``);
        }
      });
    }
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
    writeFileSync(
      this.path,
      retained.map(([e, m]) => `${JSON.stringify([e, m.toWire()])}\n`).join(""),
    );
  }

  replayFrom(cursor) {
    return this.#readAll()
      .filter(([e]) => e > cursor)
      .sort((a, b) => a[0] - b[0]);
  }

  retainedEpochs() {
    return this.#readAll()
      .map(([e]) => e)
      .sort((a, b) => a - b);
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

  assertKey(sc.expect, "retained_after_ack", mem.retainedEpochs());
  assertKey(sc.expect, "retained_after_ack", file.retainedEpochs());

  // "crash": reopen the durable file outbox from disk.
  file = new FileOutbox(path);
  const replay = file.replayFrom(cursor);

  const coord = new ResyncCoordinator(cursor);
  const applied = [];
  const landed = [];
  for (const [, m] of replay) {
    if (coord.ingest(m).action === ResyncAction.Apply) {
      applied.push(coord.lastEpoch);
      landed.push(...opKeysOf(m));
    }
  }
  // Every op the sender appended ABOVE the reconnect cursor must land exactly
  // once. Below it, nothing may be re-applied — that is the "doubled" half.
  const owed = appended.filter(([e]) => e > cursor).flatMap(([, m]) => opKeysOf(m));
  const alreadySeen = appended.filter(([e]) => e <= cursor).flatMap(([, m]) => opKeysOf(m));
  const lost = owed.filter((k) => !landed.includes(k)).length;
  const doubled =
    landed.filter((k, i) => landed.indexOf(k) !== i).length +
    landed.filter((k) => alreadySeen.includes(k)).length;

  for (const key of Object.keys(sc.expect)) {
    assertKeyWith(sc.expect, key, (expected) => {
      const where = `${sc.name}: ${key}`;
      switch (key) {
        case "retained_after_ack":
          assert.deepEqual(mem.retainedEpochs(), expected, where);
          break;
        case "replayed_from_cursor":
          assert.deepEqual(
            replay.map(([e]) => e),
            expected,
            where,
          );
          break;
        // Order, not just membership: at-least-once replay that arrives out of
        // order fails the base_epoch chain, and `replayed_from_cursor` compared as
        // a set would not have seen it.
        case "replay_order":
          assert.deepEqual(
            replay.map(([e]) => e),
            expected,
            where,
          );
          break;
        case "receiver_applies":
          assert.deepEqual(applied, expected, where);
          break;
        case "receiver_last_epoch_after":
          assert.equal(coord.lastEpoch, expected, where);
          break;
        case "ops_lost":
          assert.equal(lost, expected, where);
          break;
        case "ops_doubled":
          assert.equal(doubled, expected, where);
          break;
        // The property the whole fixture is named for. At-least-once delivery plus
        // idempotent apply = exactly-once EFFECT; the epoch keys above cannot see
        // it because they never look at the ops.
        case "exactly_once_effect":
          assert.equal(lost === 0 && doubled === 0, expected, where);
          break;
        default:
          assert.fail(`${sc.name}: unknown expectation \`${key}\``);
      }
    });
  }

  // send_failure_retains_frame_for_next_tick
  const sc2 = scenario(fx, "send_failure_retains_frame_for_next_tick");
  const mem2 = new InMemoryOutbox();
  for (const [e, m] of framesOf(sc2, "appended")) mem2.append(e, m);
  // The send is modelled as failing: nothing is acked, so nothing is pruned.
  const resent = mem2.replayFrom(sc2.expect.retained[0] - 1).map(([e]) => e);
  const appendedEpochs = framesOf(sc2, "appended").map(([e]) => e);
  for (const key of Object.keys(sc2.expect)) {
    assertKeyWith(sc2.expect, key, (expected) => {
      const where = `${sc2.name}: ${key}`;
      switch (key) {
        case "retained":
          assert.deepEqual(mem2.retainedEpochs(), expected, where);
          break;
        // Append-before-send: a failed send leaves the frame durable, which is
        // exactly what the pre-outbox bug did not do.
        case "frame_retained_after_failed_send":
          assert.equal(
            appendedEpochs.every((e) => mem2.retainedEpochs().includes(e)),
            expected,
            where,
          );
          break;
        case "resent_on_next_tick":
          assert.deepEqual(resent, expected, where);
          break;
        // The pre-outbox defect: bumping the out-epoch before the send left a hole
        // no later tick could fill. A gap is permanent iff some appended epoch is
        // neither retained nor re-sent.
        case "permanent_gap":
          assert.equal(
            appendedEpochs.some((e) => !resent.includes(e)),
            expected,
            where,
          );
          break;
        default:
          assert.fail(`${sc2.name}: unknown expectation \`${key}\``);
      }
    });
  }

  rmSync(dir, { recursive: true, force: true });
});

// -- liveness_orset_lww.json ------------------------------------------------

const stamp = (o) => new WireStamp({ wallTime: o.wall_time, logical: o.logical, peer: o.peer });

// Fold an OR-set op list into a fresh OrSet, so a scenario can be replayed in
// any order and any number of times.
function foldOrSet(ops, order = (o) => o) {
  const set = new OrSet();
  for (const op of order([...ops])) {
    // No closing arm (#lzscenariobodyskip): an unmatched `op.op` folded NOTHING
    // into the set, and `present`/`tags` were then asserted against a set the
    // fixture's op list never reached.
    if (op.op === "add") set.add(op.tag);
    else if (op.op === "remove") set.removeObserved(op.observed_tags);
    else throw new Error(`unknown OR-set op in fixture: ${op.op}`);
  }
  return set;
}

const reverse = (ops) => ops.reverse();

test("reliable-sync: liveness_orset_lww.json", () => {
  const fx = loadFixture("liveness_orset_lww.json");

  const add = scenario(fx, "open_set_add_wins_over_stale_remove");
  const set = foldOrSet(add.ops);
  for (const key of Object.keys(add.expect)) {
    assertKeyWith(add.expect, key, (expected) => {
      const where = `open_set_add_wins_over_stale_remove: ${key}`;
      switch (key) {
        case "present":
          assert.equal(set.present(), expected, where);
          break;
        // The mechanism, not just the verdict: `present` alone is satisfied by an
        // OR-set that ignores removes entirely. This pins that the doc stays open
        // BECAUSE the remove observed only the earlier tag.
        case "reason": {
          const removed = new Set(add.ops.flatMap((op) => op.observed_tags ?? []));
          const survivor = add.ops.find((op) => op.op === "add" && !removed.has(op.tag));
          assert.ok(survivor, where);
          assert.equal(`add_tag_${survivor.tag}_not_observed_by_remove`, expected, where);
          break;
        }
        // A join semilattice: delivery order cannot change the result.
        case "order_independent":
          assert.equal(foldOrSet(add.ops, reverse).present() === set.present(), expected, where);
          break;
        // Re-delivering every op applies nothing new (state-based idempotence).
        case "redeliver_applied_count": {
          const before = `${[...set.adds].sort()}|${[...set.removes].sort()}`;
          const again = foldOrSet([...add.ops, ...add.ops]);
          const after = `${[...again.adds].sort()}|${[...again.removes].sort()}`;
          assert.equal(before === after ? 0 : 1, expected, where);
          break;
        }
        default:
          assert.fail(`open_set_add_wins_over_stale_remove: unknown expectation \`${key}\``);
      }
    });
  }

  const lww = scenario(fx, "lww_alive_highest_stamp_wins");
  const foldLww = (ops) => {
    const reg = new WireLwwRegister(stamp(ops[0].stamp), ops[0].value);
    for (const op of ops.slice(1)) reg.set(stamp(op.stamp), op.value);
    return reg;
  };
  const reg = foldLww(lww.ops);
  for (const key of Object.keys(lww.expect)) {
    assertKeyWith(lww.expect, key, (expected) => {
      const where = `lww_alive_highest_stamp_wins: ${key}`;
      switch (key) {
        case "value":
          assert.equal(reg.value, expected, where);
          break;
        // Which op won, not just what value survived: a register resolving by
        // arrival order lands on the same value whenever the last write happens to
        // carry the highest stamp, and this fixture is built so it does not.
        case "resolution": {
          assert.equal(expected, "max_stamp", where);
          const winner = lww.ops.reduce((best, op) =>
            wireStampGreater(stamp(op.stamp), stamp(best.stamp)) ? op : best,
          );
          assert.equal(reg.value, winner.value, where);
          break;
        }
        case "order_independent":
          assert.equal(foldLww([...lww.ops].reverse()).value === reg.value, expected, where);
          break;
        default:
          assert.fail(`lww_alive_highest_stamp_wins: unknown expectation \`${key}\``);
      }
    });
  }

  const death = scenario(fx, "whole_editor_death_cascades");
  const open = death.open_set
    .filter((e) => e.present)
    .map((e) => {
      const [doc, pid] = e.key.split("/");
      return [doc, Number(pid.replace("pid", ""))];
    });
  const alive = new Map();
  for (const [pid, v] of Object.entries(death.alive_before)) {
    alive.set(
      Number(pid),
      new WireLwwRegister(new WireStamp({ wallTime: 1, logical: 0, peer: 1 }), v),
    );
  }
  const liveDocs = () =>
    [...new Set(open.filter(([, p]) => alive.get(p)?.value === true).map(([doc]) => doc))].sort();
  const liveBefore = liveDocs();
  const op = death.op;
  const pid = Number(op.key.replace("alive/pid", ""));
  alive.get(pid).set(stamp(op.stamp), op.value);
  const live = liveDocs();

  for (const key of Object.keys(death.expect)) {
    assertKeyWith(death.expect, key, (expected) => {
      const where = `whole_editor_death_cascades: ${key}`;
      switch (key) {
        // Checked, not assumed. The "after" set alone does not say the cascade
        // happened — an aggregate that was already {docC} before the death would
        // satisfy it.
        case "live_docs_before":
          assert.deepEqual(liveBefore, [...expected].sort(), where);
          break;
        case "live_docs_after":
          assert.deepEqual(live, [...expected].sort(), where);
          break;
        case "cascade":
          assert.equal(live.length < liveBefore.length, expected, where);
          break;
        case "note":
          // Prose. Carries no assertion, and is consumed here so it cannot hide a
          // key that does.
          assert.equal(typeof expected, "string", where);
          break;
        default:
          assert.fail(`whole_editor_death_cascades: unknown expectation \`${key}\``);
      }
    });
  }

  // This scenario was in the fixture and replayed by nothing: the runner picked
  // its three scenarios by name and the fourth simply never ran, so the derived
  // per-doc aggregate — the property the fixture is FOR — went unchecked.
  const agg = scenario(fx, "derived_live_doc_aggregate_converges_under_retry");
  const foldAggregate = (ops) => {
    const sets = new Map();
    const regs = new Map();
    for (const o of ops) {
      if (o.register_kind === "orset") {
        if (!sets.has(o.key)) sets.set(o.key, new OrSet());
        // The `else` assumed `remove` (#lzscenariobodyskip).
        if (o.op === "add") sets.get(o.key).add(o.tag);
        else if (o.op === "remove") sets.get(o.key).removeObserved(o.observed_tags ?? []);
        else assert.fail(`${agg.name}: unknown OR-set op \`${o.op}\``);
      } else if (o.register_kind === "lww") {
        const existing = regs.get(o.key);
        if (existing) existing.set(stamp(o.stamp), o.value);
        else regs.set(o.key, new WireLwwRegister(stamp(o.stamp), o.value));
      } else {
        assert.fail(`${agg.name}: unknown register_kind \`${o.register_kind}\``);
      }
    }
    const docs = new Set();
    for (const [key, set] of sets) {
      const [doc, pidKey] = key.split("/");
      if (set.present() && regs.get(`alive/${pidKey}`)?.value === true) docs.add(doc);
    }
    return [...docs].sort();
  };
  const aggregate = foldAggregate(agg.ops);
  for (const key of Object.keys(agg.expect)) {
    assertKeyWith(agg.expect, key, (expected) => {
      const where = `${agg.name}: ${key}`;
      switch (key) {
        case "converged_live_docs":
          assert.deepEqual(aggregate, expected, where);
          break;
        case "order_independent":
          assert.equal(
            JSON.stringify(foldAggregate([...agg.ops].reverse())) === JSON.stringify(aggregate),
            expected,
            where,
          );
          break;
        case "redeliver_applied_count":
          assert.equal(
            JSON.stringify(foldAggregate([...agg.ops, ...agg.ops])) === JSON.stringify(aggregate)
              ? 0
              : 1,
            expected,
            where,
          );
          break;
        // Per-doc isolation: dropping one doc's ops removes only that doc.
        case "per_doc_isolation": {
          const isolated = aggregate.every(
            (doc) =>
              JSON.stringify(foldAggregate(agg.ops.filter((o) => !o.key.startsWith(`${doc}/`)))) ===
              JSON.stringify(aggregate.filter((d) => d !== doc)),
          );
          assert.equal(isolated, expected, where);
          break;
        }
        default:
          assert.fail(`${agg.name}: unknown expectation \`${key}\``);
      }
    });
  }
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
  assert.throws(
    () => d.tick(),
    (e) => e instanceof DriverError && e.kind === "Source",
  );
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
