import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CallStateKind,
  CausalReceipt,
  CommandApplyStatusKind,
  CommandEvent,
  CommandEventKind,
  CommandEvents,
  CommandMessage,
  CommandPolicy,
  CommandProjection,
  CommandProjectionImage,
  CommandRpcClient,
  CommandStatus,
  CommandSubmit,
  DedupePolicy,
  IpcValue,
  ReceiptMessage,
  isTerminalCommandStatus,
} from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "..", "lazily-spec", "conformance", "message-passing");

function fixturesPresent() {
  return existsSync(fixtureDir);
}

function load(name) {
  return JSON.parse(readFileSync(join(fixtureDir, name), "utf8"));
}

function foldFrame(projection, frame) {
  if (frame.schema === "message-passing") {
    return projection.applyMessage(CommandMessage.fromWire(frame.wire));
  }
  if (frame.schema === "receipts") {
    const message = ReceiptMessage.fromWire(frame.wire);
    let last = { kind: CommandApplyStatusKind.Unknown };
    for (const receipt of message.causalReceipts.receipts) {
      last = projection.observeReceipt(receipt);
    }
    return last;
  }
  throw new Error(`unknown frame schema: ${frame.schema}`);
}

function assertProjection(projection, expect) {
  const want = CommandProjectionImage.fromWire(expect.projection);
  assert.deepEqual(projection.toImage().toWire(), want.toWire());
}

function submitFixture(commandId, generation) {
  return new CommandSubmit({
    commandId,
    causationId: commandId,
    source: "vscode-plugin",
    target: "project-controller",
    namespace: "agent-doc",
    name: "editor_route",
    authorityGeneration: generation,
    idempotencyKey: "project-root:plan.md:run",
    deadlineMs: 120000,
    policy: new CommandPolicy({
      dedupe: DedupePolicy.SameIdempotencyKey,
      supersede: false,
      cancelOnPreempt: true,
    }),
    payloadType: "agent-doc.editor_route.v1",
    payloadHash: "sha256:deadbeef",
    payload: IpcValue.inline([1, 2, 3]),
    requiredFeatures: ["causal-receipts"],
  });
}

// --- unit tests mirroring the Rust/Kotlin reducer ---

test("command status terminality is explicit", () => {
  assert.equal(isTerminalCommandStatus(CommandStatus.Submitted), false);
  assert.equal(isTerminalCommandStatus(CommandStatus.Accepted), false);
  assert.equal(isTerminalCommandStatus(CommandStatus.Running), false);
  assert.equal(isTerminalCommandStatus(CommandStatus.Applied), true);
  assert.equal(isTerminalCommandStatus(CommandStatus.Cancelled), true);
  assert.equal(isTerminalCommandStatus(CommandStatus.TimedOut), true);
});

test("command message round trips through JSON", () => {
  const message = CommandMessage.ofSubmit(submitFixture("cmd-1", 42));
  const decoded = CommandMessage.decodeJson(message.encodeJson());
  assert.deepEqual(decoded.toWire(), message.toWire());
});

test("accepted progress is not terminal", () => {
  const p = new CommandProjection();
  p.submit(submitFixture("cmd-1", 42));
  p.event(
    new CommandEvent({
      eventId: "ev-1",
      commandId: "cmd-1",
      kind: CommandEventKind.Accepted,
      generation: 42,
      detail: "queued",
    }),
  );
  const entry = p.entry("cmd-1");
  assert.equal(entry.terminal, false);
  assert.equal(entry.status, CommandStatus.Accepted);
  assert.equal(p.terminalFor("cmd-1"), null);
});

test("duplicate submit is idempotent", () => {
  const p = new CommandProjection();
  assert.equal(p.submit(submitFixture("cmd-1", 42)).kind, CommandApplyStatusKind.Recorded);
  assert.equal(p.submit(submitFixture("cmd-1", 99)).kind, CommandApplyStatusKind.Duplicate);
  assert.equal(p.entry("cmd-1").generation, 42);
});

test("conflicting terminal receipts fail closed", () => {
  const p = new CommandProjection();
  p.submit(submitFixture("cmd-1", 42));
  p.observeReceipt(CausalReceipt.applied("rcpt-applied", "cmd-1", "project-controller", 42));
  const status = p.observeReceipt(
    CausalReceipt.rejected("rcpt-rejected", "cmd-1", "project-controller", 42, "conflict"),
  );
  assert.equal(status.kind, CommandApplyStatusKind.TerminalConflict);
  assert.equal(p.hasConflict("cmd-1"), true);
  assert.equal(p.entry("cmd-1").status, CommandStatus.Applied);
});

test("rpc facade resolves only on terminal receipt", () => {
  const sent = [];
  const client = new CommandRpcClient((message) => sent.push(message));
  const id = client.submit(submitFixture("cmd-1", 42));
  client.ingestCommand(
    CommandMessage.ofEvents(
      new CommandEvents([
        new CommandEvent({ eventId: "ev-1", commandId: id, kind: CommandEventKind.Accepted, generation: 42, detail: "queued" }),
        new CommandEvent({ eventId: "ev-2", commandId: id, kind: CommandEventKind.Started, generation: 42 }),
      ]),
    ),
  );
  assert.equal(client.pollCall(id).kind, CallStateKind.Pending);
  client.ingestReceipt(CausalReceipt.applied("rcpt-1", id, "project-controller", 42));
  const state = client.pollCall(id);
  assert.equal(state.kind, CallStateKind.Resolved);
  assert.equal(state.entry.status, CommandStatus.Applied);
  assert.equal(sent.length, 1);
});

// --- fixture replay ---

test("editor_route submit is nonterminal", () => {
  if (!fixturesPresent()) return;
  const fx = load("editor_route_submit.json");
  const p = new CommandProjection();
  for (const frame of fx.frames) foldFrame(p, frame);
  assertProjection(p, fx.expect);
  assert.equal(p.terminalFor("cmd-run-1"), null);
});

test("sync tmux layout submit shared blob", () => {
  if (!fixturesPresent()) return;
  const fx = load("sync_tmux_layout_submit.json");
  const p = new CommandProjection();
  for (const frame of fx.frames) foldFrame(p, frame);
  assertProjection(p, fx.expect);
});

test("accepted then applied receipt is terminal only at receipt", () => {
  if (!fixturesPresent()) return;
  const fx = load("accepted_then_applied_receipt.json");
  const terminalAt = fx.expect.terminal_after_frame_index;
  const p = new CommandProjection();
  fx.frames.forEach((frame, i) => {
    foldFrame(p, frame);
    const isTerminal = p.terminalFor("cmd-run-1") !== null;
    if (i < terminalAt) assert.equal(isTerminal, false, `frame ${i} must be non-terminal`);
    else assert.equal(isTerminal, true, `frame ${i} must be terminal`);
  });
  assertProjection(p, fx.expect);
});

test("stale generation events and receipts are ignored", () => {
  if (!fixturesPresent()) return;
  const fx = load("stale_generation_ignored.json");
  const ignored = fx.expect.ignored_frame_indices;
  const p = new CommandProjection();
  fx.frames.forEach((frame, i) => {
    const status = foldFrame(p, frame);
    if (ignored.includes(i)) {
      assert.equal(status.kind, CommandApplyStatusKind.StaleGeneration, `frame ${i} must be stale`);
    }
  });
  assertProjection(p, fx.expect);
});

test("terminal conflict fails closed fixture", () => {
  if (!fixturesPresent()) return;
  const fx = load("terminal_conflict_fail_closed.json");
  const conflictAt = fx.expect.conflict_after_frame_index;
  const commandId = fx.expect.conflict_command_id;
  const p = new CommandProjection();
  fx.frames.forEach((frame, i) => {
    const status = foldFrame(p, frame);
    if (i === conflictAt) {
      assert.equal(status.kind, CommandApplyStatusKind.TerminalConflict);
    }
  });
  assert.equal(p.hasConflict(commandId), true);
  const before = CommandProjectionImage.fromWire(fx.expect.projection_before_conflict);
  assert.deepEqual(p.toImage().toWire(), before.toWire());
});

test("cancel preempts nonterminal scenarios", () => {
  if (!fixturesPresent()) return;
  const fx = load("cancel_preempts_nonterminal.json");
  for (const scenario of fx.scenarios) {
    const p = new CommandProjection();
    for (const frame of scenario.frames) foldFrame(p, frame);
    assertProjection(p, scenario.expect);
  }
});

test("reconnect command projection resyncs", () => {
  if (!fixturesPresent()) return;
  const fx = load("reconnect_command_projection.json");
  const p = new CommandProjection();
  for (const frame of fx.frames) foldFrame(p, frame);
  assertProjection(p, fx.expect);
});

test("rpc call waits for terminal", () => {
  if (!fixturesPresent()) return;
  const fx = load("rpc_call_waits_for_terminal.json");
  const rpc = fx.expect.rpc;
  const commandId = rpc.command_id;
  const resolvesAt = rpc.resolves_after_frame_index;
  const unresolved = rpc.unresolved_after_frame_indices;
  const p = new CommandProjection();
  fx.frames.forEach((frame, i) => {
    foldFrame(p, frame);
    const resolved = p.terminalFor(commandId) !== null;
    if (unresolved.includes(i)) assert.equal(resolved, false, `frame ${i} must not resolve`);
    if (i === resolvesAt) assert.equal(resolved, true, `frame ${i} must resolve`);
  });
  assertProjection(p, fx.expect);
});

test("every message-passing fixture is present", () => {
  if (!fixturesPresent()) return;
  const files = readdirSync(fixtureDir).filter((n) => n.endsWith(".json"));
  assert.ok(files.length >= 8, `expected >=8 fixtures, found ${files.length}`);
});
