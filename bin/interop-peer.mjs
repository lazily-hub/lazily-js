#!/usr/bin/env node

// NDJSON test adapter for the cross-binding Lazily interoperability suite.
// CRDT ordering/dedup and all IPC parsing stay on the production library paths.

import { createInterface } from "node:readline";
import { CrdtPlaneRuntime } from "../src/distributed.js";
import { CrdtSync, IpcMessage, IpcValue } from "../src/index.js";

const PROTOCOL_VERSION = 1;
const decoder = new TextDecoder();

class InteropPeer {
  #peerId = null;
  #runtime = null;

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
    return {
      ok: true,
      binding: "lazily-js",
      version: "0.29.1",
      protocol_version: PROTOCOL_VERSION,
      features: ["distributed_crdt"],
      codecs: ["json"],
      channels: [],
      channel_variants: {},
      platform_profile: "portable",
      carve_outs: ["msgpack", "transport_links"],
    };
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
    const op = runtime.localUpdate(
      request.node,
      request.at,
      IpcValue.fromWire(request.state),
    );
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
  if (!peer.handle({ cmd: "hello", peer: 1, protocol_version: 1 }).ok) {
    throw new Error("hello self-check failed");
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
    process.stdout.write(`${JSON.stringify(response)}\n`);
    if (request?.cmd === "bye") {
      lines.close();
      process.stdin.destroy();
      break;
    }
  }
}
