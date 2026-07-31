#!/usr/bin/env node

// NDJSON test adapter for the cross-binding Lazily interoperability suite.
// CRDT ordering/dedup and all IPC parsing stay on the production library paths.

import { createInterface } from "node:readline";
import { CrdtPlaneRuntime } from "../src/distributed.js";
import { CrdtSync, IpcMessage, IpcValue } from "../src/index.js";
import { RevisionBarrier, Timeout, TimeoutOperation, Timer, TimerError } from "../src/stdlib.js";

const PROTOCOL_VERSION = 1;
const decoder = new TextDecoder();
const STDLIB_FEATURES = new Set([
  "stdlib_timer_v1",
  "stdlib_timeout_v1",
  "stdlib_revision_barrier_v1",
]);

function wireU64(value) {
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    return BigInt(value);
  }
  return value;
}

class InteropPeer {
  #peerId = null;
  #runtime = null;
  #stdlib = new Map();

  handle(request) {
    switch (request.cmd) {
      case "hello":
        return this.#hello(request);
      case "local_set":
        return this.#localSet(request);
      case "deliver":
        return this.#deliver(request);
      case "snapshot":
        return this.#snapshot();
      case "feature_reset":
        return this.#featureReset(request);
      case "feature_step":
        return this.#featureStep(request);
      case "feature_observe":
        return this.#featureObserve(request);
      case "bye":
        return { ok: true };
      case "link_open":
      case "link_send":
      case "link_recv":
      case "link_close":
      case "link_stats":
        return {
          ok: false,
          error: "unsupported channel",
          unsupported: true,
        };
      default:
        return { ok: false, error: "unknown command" };
    }
  }

  #hello(request) {
    if (request.protocol_version !== PROTOCOL_VERSION) {
      return { ok: false, error: "unsupported protocol_version" };
    }
    if (!Number.isSafeInteger(request.peer)) {
      return { ok: false, error: "hello requires integer peer" };
    }
    this.#peerId = request.peer;
    this.#runtime = new CrdtPlaneRuntime(request.peer);
    this.#stdlib.clear();
    return {
      ok: true,
      binding: "lazily-js",
      version: "0.29.1",
      protocol_version: PROTOCOL_VERSION,
      features: ["distributed_crdt", ...STDLIB_FEATURES],
      codecs: ["json"],
      channels: [],
      channel_variants: {},
      platform_profile: "portable",
      carve_outs: ["msgpack", "transport_links"],
    };
  }

  #featureReset(request) {
    if (!STDLIB_FEATURES.has(request.feature)) {
      return {
        ok: false,
        error: `unsupported feature ${request.feature}`,
        unsupported: true,
      };
    }
    this.#stdlib.set(request.feature, { last: null });
    return { ok: true, feature: request.feature };
  }

  #featureStep(request) {
    const state = this.#stdlib.get(request.feature);
    if (state === undefined) throw new Error("feature_reset must run first");
    if (request.step === null || typeof request.step !== "object" || Array.isArray(request.step)) {
      throw new TypeError("feature_step requires object step");
    }
    let observation;
    switch (request.feature) {
      case "stdlib_timer_v1":
        observation = this.#timerStep(state, request.step);
        break;
      case "stdlib_timeout_v1":
        observation = this.#timeoutStep(state, request.step);
        break;
      case "stdlib_revision_barrier_v1":
        observation = this.#barrierStep(state, request.step);
        break;
      default:
        throw new Error(`unsupported feature ${request.feature}`);
    }
    state.last = observation;
    return { ok: true, feature: request.feature, observation };
  }

  #featureObserve(request) {
    const state = this.#stdlib.get(request.feature);
    if (state?.last === null || state === undefined) {
      throw new Error("feature has no observation");
    }
    return {
      ok: true,
      feature: request.feature,
      observation: state.last,
    };
  }

  #timerStep(state, step) {
    if (step.op === "start") {
      try {
        state.timer = new Timer(wireU64(step.now), wireU64(step.duration));
      } catch (error) {
        if (!(error instanceof TimerError)) throw error;
        state.timer = null;
        return { outcome: "unavailable", reason: error.reason };
      }
      return { outcome: "pending", deadline: state.timer.deadline };
    }
    if (!(state.timer instanceof Timer)) {
      throw new Error("timer start must succeed before observe");
    }
    return state.timer.observe(wireU64(step.now));
  }

  #timeoutStep(state, step) {
    if (step.op === "start") {
      try {
        state.timeout = new Timeout(wireU64(step.now), wireU64(step.duration));
      } catch (error) {
        if (!(error instanceof TimerError)) throw error;
        state.timeout = null;
        return { outcome: "unavailable", reason: error.reason };
      }
      return { outcome: "pending", deadline: state.timeout.deadline };
    }
    if (!(state.timeout instanceof Timeout)) {
      throw new Error("timeout start must succeed before poll");
    }
    let operationCalls = 0;
    let cancellationCalls = 0;
    const observation = state.timeout.poll(
      wireU64(step.now),
      () => {
        operationCalls += 1;
        if (step.operation === "completed") return TimeoutOperation.completed(step.value ?? "");
        if (step.operation === "unavailable") return TimeoutOperation.unavailable();
        return TimeoutOperation.pending();
      },
      () => {
        cancellationCalls += 1;
        return step.cancellation;
      },
    );
    return {
      ...observation,
      operation_calls: operationCalls,
      cancellation_calls: cancellationCalls,
    };
  }

  #barrierStep(state, step) {
    let cancellationCalls = 0;
    let observation;
    if (step.op === "start") {
      state.barrier = new RevisionBarrier(
        wireU64(step.revision),
        wireU64(step.required_revision),
        step.deadline === null || step.deadline === undefined ? null : wireU64(step.deadline),
      );
      observation = state.barrier.receipt("");
    } else {
      if (!(state.barrier instanceof RevisionBarrier)) {
        throw new Error("barrier start must run first");
      }
      switch (step.op) {
        case "observe":
          observation = state.barrier.observe(wireU64(step.now), step.predicate, () => {
            cancellationCalls += 1;
            return step.cancellation;
          });
          break;
        case "register_recheck":
          observation = state.barrier.registerRecheck(
            wireU64(step.now),
            wireU64(step.observed_revision),
            step.predicate,
          );
          break;
        case "advance":
          observation = state.barrier.advance(wireU64(step.revision), step.predicate);
          break;
        case "dispose":
          observation = state.barrier.dispose();
          break;
        case "receipt":
          observation = state.barrier.receipt(step.key);
          break;
        default:
          throw new Error(`unsupported barrier op ${step.op}`);
      }
    }
    return step.op === "observe"
      ? { ...observation, cancellation_calls: cancellationCalls }
      : observation;
  }

  #localSet(request) {
    const runtime = this.#ready();
    if (!Number.isSafeInteger(request.node) || !Number.isSafeInteger(request.at)) {
      throw new TypeError("local_set requires integer node and at");
    }
    if (request.key !== null && typeof request.key !== "string") {
      throw new TypeError("local_set key must be a string or null");
    }
    runtime.register(request.node, request.key);
    const op = runtime.localUpdate(request.node, request.at, IpcValue.fromWire(request.state));
    if (op === null) {
      throw new Error("production runtime rejected fresh local op");
    }
    const message = IpcMessage.crdtSync(
      new CrdtSync({ frontier: runtime.wireFrontier(), ops: [op] }),
    );
    const frame = JSON.parse(decoder.decode(message.encodeJson()));
    return { ok: true, frame };
  }

  #deliver(request) {
    const runtime = this.#ready();
    const message = IpcMessage.decodeJson(JSON.stringify(request.frame));
    if (!message.isCrdtSync) {
      throw new TypeError("deliver requires CrdtSync");
    }
    return { ok: true, applied: runtime.ingest(message.crdtSync, request.at) };
  }

  #snapshot() {
    const runtime = this.#ready();
    return {
      ok: true,
      cells: runtime.converged().map((entry) => ({
        node: entry.node,
        key: entry.key ?? null,
        state: entry.state,
      })),
    };
  }

  #ready() {
    if (this.#runtime === null || this.#peerId === null) {
      throw new Error("hello must run first");
    }
    return this.#runtime;
  }
}

function selfCheck() {
  const peer = new InteropPeer();
  const hello = peer.handle({ cmd: "hello", peer: 1, protocol_version: 1 });
  if (!hello.ok) {
    throw new Error("hello self-check failed");
  }
  for (const feature of STDLIB_FEATURES) {
    if (!hello.features.includes(feature)) {
      throw new Error(`${feature} advertisement self-check failed`);
    }
  }
  const local = peer.handle({
    cmd: "local_set",
    node: 7,
    key: null,
    state: { Inline: [65] },
    at: 10,
  });
  if (local.frame.CrdtSync.ops[0].key !== null) {
    throw new Error("null key self-check failed");
  }
  const duplicate = peer.handle({
    cmd: "deliver",
    frame: local.frame,
    at: 11,
  });
  if (duplicate.applied !== 0) {
    throw new Error("duplicate self-check failed");
  }
  if (peer.handle({ cmd: "snapshot" }).cells[0].state.Inline[0] !== 65) {
    throw new Error("snapshot self-check failed");
  }
  const featureScenarios = new Map([
    [
      "stdlib_timer_v1",
      [
        { op: "start", now: 0, duration: 1 },
        { op: "observe", now: 1 },
      ],
    ],
    [
      "stdlib_timeout_v1",
      [
        { op: "start", now: 0, duration: 1 },
        {
          op: "poll",
          now: 1,
          operation: "pending",
          cancellation: "pending",
        },
      ],
    ],
    [
      "stdlib_revision_barrier_v1",
      [
        {
          op: "start",
          revision: 0,
          required_revision: 1,
          deadline: null,
        },
        { op: "advance", revision: 1, predicate: true },
      ],
    ],
  ]);
  for (const [feature, steps] of featureScenarios) {
    if (!peer.handle({ cmd: "feature_reset", feature }).ok) {
      throw new Error(`${feature} reset self-check failed`);
    }
    let last;
    for (const step of steps) {
      last = peer.handle({ cmd: "feature_step", feature, step }).observation;
    }
    const observed = peer.handle({ cmd: "feature_observe", feature }).observation;
    if (JSON.stringify(observed) !== JSON.stringify(last)) {
      throw new Error(`${feature} observe self-check failed`);
    }
  }
}

if (process.argv.includes("--self-check")) {
  selfCheck();
  console.error("lazily-js interop peer self-check: ok");
} else {
  const peer = new InteropPeer();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    let request = null;
    let response;
    try {
      request = JSON.parse(line);
      response = peer.handle(request);
    } catch (error) {
      response = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    process.stdout.write(
      `${JSON.stringify(response, (_, value) =>
        typeof value === "bigint" ? value.toString() : value,
      )}\n`,
    );
    if (request?.cmd === "bye") {
      lines.close();
      process.stdin.destroy();
      break;
    }
  }
}
