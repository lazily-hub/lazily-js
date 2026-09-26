#!/usr/bin/env node

// NDJSON test adapter for the cross-binding Lazily interoperability suite.
// CRDT ordering/dedup and all IPC parsing stay on the production library paths.

import { createInterface } from "node:readline";
import { CrdtPlaneRuntime } from "../src/distributed.js";
import { CrdtSync, IpcMessage, IpcValue } from "../src/index.js";
import { RevisionBarrier, Timeout, TimeoutOperation, Timer, TimerError } from "../src/stdlib.js";
import {
  DurableClient,
  DurableProjectionCompleteness,
  DurableProjectionHealth,
  compareDurableProjectionFingerprints,
  durableIngressEnvelope,
} from "../src/durable-client.js";

const PROTOCOL_VERSION = 1;
const decoder = new TextDecoder();
const STDLIB_FEATURES = new Set([
  "stdlib_timer_v1",
  "stdlib_timeout_v1",
  "stdlib_revision_barrier_v1",
]);
const DURABLE_FEATURE = "durable_client_v1";

const durableTransport = Object.freeze({
  publish() {
    return { stream: "INTEROP", sequence: 1, duplicate: false };
  },
  subscribe(subject) {
    return { subject, async next() {}, close() {} };
  },
});

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
      version: "0.33.0",
      protocol_version: PROTOCOL_VERSION,
      features: ["distributed_crdt", ...STDLIB_FEATURES, DURABLE_FEATURE],
      // `msgpack` moves out of `carve_outs` and into `codecs` with
      // #lzmsgpackseven: src/msgpack-codec.js packs the reference value tree as
      // named-field MessagePack maps — the wire the token names, not merely a
      // MessagePack framing — and test/codec.test.js replays
      // codec/frame_roundtrip_msgpack.json through it.
      codecs: ["json", "msgpack"],
      channels: [],
      channel_variants: {},
      platform_profile: "portable",
      carve_outs: ["transport_links"],
    };
  }

  #featureReset(request) {
    if (!STDLIB_FEATURES.has(request.feature) && request.feature !== DURABLE_FEATURE) {
      return {
        ok: false,
        error: `unsupported feature ${request.feature}`,
        unsupported: true,
      };
    }
    this.#stdlib.set(request.feature, {
      last: null,
      durable: request.feature === DURABLE_FEATURE ? new DurableClient(durableTransport) : null,
    });
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
      case DURABLE_FEATURE:
        observation = this.#durableStep(state, request.step);
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

  #durableStep(state, step) {
    const client = state.durable;
    if (!(client instanceof DurableClient)) throw new Error("durable client is not initialized");
    switch (step.operation) {
      case "validate_envelope": {
        try {
          durableIngressEnvelope(step.envelope);
          return {
            accepted: true,
            reason: "accepted",
            payload_decoded: true,
            owner_authority: false,
          };
        } catch (error) {
          return {
            accepted: false,
            reason: error.message,
            payload_decoded: false,
            owner_authority: false,
          };
        }
      }
      case "order_projection": {
        const delivery_classification = step.observed_source_positions.map((position) => {
          const admission = client.observeProjection({
            protocol_version: 1,
            owner_id: "interop-owner",
            generation: 1,
            source_position: position,
            projection_version: position,
            schema_version: 1,
            codec_version: 1,
            completeness: DurableProjectionCompleteness.CompleteHistory,
            entries: [position],
            source_fingerprint: `source-${position}`,
            projection_fingerprint: `projection-${position}`,
            health: DurableProjectionHealth.Healthy,
            may_authorize_transition: false,
          });
          return admission.kind === "buffered"
            ? "buffered"
            : admission.kind === "dropped"
              ? "duplicate"
              : "applied";
        });
        return {
          applied_source_positions: client.appliedSourcePositions("interop-owner"),
          delivery_classification,
          broker_order_authoritative: false,
          may_authorize_transition: false,
        };
      }
      case "classify_dedup":
        return {
          classification: step.deliveries.map((item) => client.observeIngress(item)),
          owner_authority: false,
        };
      case "observe_receipt":
        client.observeHostReceipt(step.receipt);
        return {
          receipt: client.hostReceipt(step.receipt.receipt_id),
          terminal_owner_receipt: true,
          transport_ack_equivalent: false,
          owner_authority: false,
        };
      case "compare_projection_fingerprints":
        return {
          ...compareDurableProjectionFingerprints(step.left, step.right),
          may_authorize_transition: false,
        };
      default:
        throw new Error(`unknown durable client operation ${step.operation}`);
    }
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
  const durableSteps = [
    {
      operation: "validate_envelope",
      envelope: {
        protocol_version: 1,
        message_id: "sample-owner/message-1",
        schema_version: 7,
        codec_version: 11,
        payload: [0, 255],
      },
    },
    { operation: "order_projection", observed_source_positions: [2, 1, 2] },
    {
      operation: "classify_dedup",
      deliveries: [
        {
          protocol_version: 1,
          message_id: "sample-owner/message-1",
          schema_version: 7,
          codec_version: 11,
          payload: [65],
        },
        {
          protocol_version: 1,
          message_id: "sample-owner/message-1",
          schema_version: 7,
          codec_version: 11,
          payload: [65],
        },
      ],
    },
    {
      operation: "observe_receipt",
      receipt: {
        protocol_version: 1,
        receipt_id: "sample-owner/receipt-1",
        message_id: "sample-owner/message-1",
        outcome: "committed",
        owner_position: 1,
      },
    },
    {
      operation: "compare_projection_fingerprints",
      left: {
        projection_id: "orders",
        source_position: 1,
        fingerprint: "aa",
        completeness: "complete_history",
        may_authorize_transition: false,
      },
      right: {
        projection_id: "orders",
        source_position: 1,
        fingerprint: "aa",
        completeness: "latest_state_only",
        may_authorize_transition: false,
      },
    },
  ];
  if (!peer.handle({ cmd: "feature_reset", feature: DURABLE_FEATURE }).ok)
    throw new Error("durable client reset self-check failed");
  for (const step of durableSteps) {
    if (!peer.handle({ cmd: "feature_step", feature: DURABLE_FEATURE, step }).ok)
      throw new Error("durable client step self-check failed");
  }
  if (
    peer.handle({ cmd: "feature_observe", feature: DURABLE_FEATURE }).observation.equivalent !==
    false
  ) {
    throw new Error("durable client observation self-check failed");
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
