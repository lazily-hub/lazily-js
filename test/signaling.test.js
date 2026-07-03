import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ClientJoin,
  ClientMessage,
  MemorySignalingSocket,
  ServerMessage,
  ServerWelcome,
  SignalingClient,
  SignalingPermissions,
  SignalingRoom,
} from "../src/signaling.js";

const here = dirname(fileURLToPath(import.meta.url));
const localFixtures = join(here, "conformance");
const specFixtures = join(here, "..", "..", "lazily-spec", "conformance");

function loadFixture(name) {
  const specPath = join(specFixtures, name);
  const path = existsSync(specPath) ? specPath : join(localFixtures, name);
  const fixture = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(fixture.protocol_version, 1);
  return fixture;
}

const CLIENT_VARIANTS = new Set(["join", "offer", "answer", "ice", "relay", "leave"]);

function decodeFrame(direction, wire) {
  return direction === "client"
    ? ClientMessage.fromWire(wire)
    : ServerMessage.fromWire(wire);
}

test("signaling frames.json round-trips every variant byte-for-byte", () => {
  const fixture = loadFixture("signaling/frames.json");
  for (const frame of fixture.frames) {
    const message = decodeFrame(frame.direction, frame.wire);
    // Tags are kebab-case exactly as authored on the wire.
    assert.equal(message.type, frame.wire.type, frame.label);
    // Re-encoding reproduces the canonical JSON.
    assert.deepEqual(message.toWire(), frame.wire, frame.label);
  }
});

test("kebab-case tags are used for hyphenated server variants", () => {
  assert.equal(ServerMessage.peerJoined(5).type, "peer-joined");
  assert.equal(ServerMessage.peerLeft(5).type, "peer-left");
});

test("join without capabilities omits the key; with capabilities includes it", () => {
  const bare = ClientMessage.join(1);
  assert.equal(bare.capabilities, null);
  assert.deepEqual(bare.toWire(), { type: "join", peer: 1 });
  assert.equal("capabilities" in bare.toWire(), false);

  const withCaps = ClientMessage.join(7, ["crdt"]);
  assert.deepEqual(withCaps.toWire(), { type: "join", peer: 7, capabilities: ["crdt"] });

  // Decoding a bare join yields null capabilities and re-encodes without the key.
  const decoded = ClientMessage.fromWire({ type: "join", peer: 1 });
  assert.ok(decoded instanceof ClientJoin);
  assert.equal(decoded.capabilities, null);
  assert.deepEqual(decoded.toWire(), { type: "join", peer: 1 });
});

test("assertions metadata on each frame matches the decoded message", () => {
  const fixture = loadFixture("signaling/frames.json");
  for (const frame of fixture.frames) {
    const a = frame.assertions ?? {};
    const message = decodeFrame(frame.direction, frame.wire);
    if ("peer" in a) assert.equal(message.peer, a.peer, frame.label);
    if ("to" in a) assert.equal(message.to, a.to, frame.label);
    if ("from" in a) assert.equal(message.from, a.from, frame.label);
    if ("peers" in a) assert.deepEqual([...message.peers], a.peers, frame.label);
    if ("code" in a) assert.equal(message.code, a.code, frame.label);
    if ("has_capabilities" in a) {
      assert.equal(message.capabilities !== null, a.has_capabilities, frame.label);
    }
    if ("capabilities" in a) {
      assert.deepEqual([...message.capabilities], a.capabilities, frame.label);
    }
    if ("roster_excludes_self" in a) {
      assert.equal([...message.peers].includes(message.peer), false, frame.label);
    }
    assert.ok(
      frame.direction !== "client" || CLIENT_VARIANTS.has(frame.variant),
      frame.label,
    );
  }
});

test("anti_spoof_session.json replays through SignalingRoom", () => {
  const fixture = loadFixture("signaling/anti_spoof_session.json");
  const room = new SignalingRoom({ mode: fixture.mode ?? "open" });

  for (const step of fixture.steps) {
    const message = ClientMessage.fromWire(step.input.recv);
    const emitted = room.receive(step.input.conn, message);

    assert.equal(
      emitted.length,
      step.expect.length,
      `step conn=${step.input.conn} emit count`,
    );
    for (let i = 0; i < emitted.length; i += 1) {
      assert.equal(emitted[i].to, step.expect[i].to, "routed connection id");
      assert.deepEqual(
        emitted[i].message.toWire(),
        step.expect[i].frame,
        `frame ${i} for conn=${step.input.conn}`,
      );
    }
  }
});

test("SignalingRoom stamps forwarded `from` from the sender's registered peer", () => {
  const room = new SignalingRoom();
  room.receive("a", ClientMessage.join(1));
  room.receive("b", ClientMessage.join(2));

  // A spoofing client cannot set `from`; it only supplies `to`.
  const routed = room.receive("a", ClientMessage.offer(2, "SDP"));
  assert.equal(routed.length, 1);
  assert.equal(routed[0].to, "b");
  assert.deepEqual(routed[0].message.toWire(), { type: "offer", from: 1, sdp: "SDP" });
});

test("SignalingRoom welcome roster excludes self and is sorted ascending", () => {
  const room = new SignalingRoom();
  room.receive("a", ClientMessage.join(5));
  room.receive("b", ClientMessage.join(2));
  const routed = room.receive("c", ClientMessage.join(9));
  const welcome = routed.find((r) => r.message instanceof ServerWelcome).message;
  assert.deepEqual([...welcome.peers], [2, 5]);
  assert.equal([...welcome.peers].includes(9), false);
});

test("SignalingRoom reports unknown_target for an absent peer", () => {
  const room = new SignalingRoom();
  room.receive("a", ClientMessage.join(1));
  const routed = room.receive("a", ClientMessage.offer(42, "SDP"));
  assert.equal(routed.length, 1);
  assert.deepEqual(routed[0].message.toWire(), {
    type: "error",
    code: "unknown_target",
    message: "peer 42 is not in this session",
  });
});

test("SignalingRoom rejects duplicate peer, unknown-before-join, already-joined", () => {
  const room = new SignalingRoom();
  room.receive("a", ClientMessage.join(1));

  const dup = room.receive("b", ClientMessage.join(1));
  assert.equal(dup[0].message.code, "duplicate_peer");

  const notJoined = room.receive("z", ClientMessage.offer(1, "x"));
  assert.equal(notJoined[0].message.code, "not_joined");

  const already = room.receive("a", ClientMessage.join(3));
  assert.equal(already[0].message.code, "already_joined");
});

test("SignalingRoom allowlist mode is default-deny", () => {
  const permissions = new SignalingPermissions("allowlist");
  permissions.allowJoin(1);
  const room = new SignalingRoom({ permissions });

  const denied = room.receive("b", ClientMessage.join(2));
  assert.equal(denied[0].message.code, "permission_denied");

  const ok = room.receive("a", ClientMessage.join(1));
  assert.ok(ok.find((r) => r.message instanceof ServerWelcome));
});

test("SignalingClient over the in-memory socket pair: join, offer, relay, leave", async () => {
  const [clientSocket, serverSocket] = MemorySignalingSocket.pair();
  const client = SignalingClient.connect(clientSocket, 1, { capabilities: ["crdt"] });
  assert.equal(client.peer, 1);

  // The join handshake is auto-sent and the server reads it verbatim.
  const join = JSON.parse(await serverSocket.recv());
  assert.deepEqual(join, { type: "join", peer: 1, capabilities: ["crdt"] });

  client.offer(2, "SDP-A");
  assert.deepEqual(JSON.parse(await serverSocket.recv()), {
    type: "offer",
    to: 2,
    sdp: "SDP-A",
  });

  client.relay(2, { hello: true });
  assert.deepEqual(JSON.parse(await serverSocket.recv()), {
    type: "relay",
    to: 2,
    payload: { hello: true },
  });

  // The client decodes forwarded server frames.
  serverSocket.send(JSON.stringify(ServerMessage.welcome(1, [2]).toWire()));
  const welcome = await client.recv();
  assert.ok(welcome instanceof ServerWelcome);
  assert.deepEqual([...welcome.peers], [2]);

  client.leave();
  assert.deepEqual(JSON.parse(await serverSocket.recv()), { type: "leave" });
  // After leave the socket is closed; recv resolves to null.
  assert.equal(await serverSocket.recv(), null);
});

test("SignalingClient.onMessage delivers frames until unsubscribed", async () => {
  const [clientSocket, serverSocket] = MemorySignalingSocket.pair();
  const client = SignalingClient.connect(clientSocket, 1);
  await serverSocket.recv(); // drain join

  const seen = [];
  const unsub = client.onMessage((m) => seen.push(m.type));
  serverSocket.send(JSON.stringify(ServerMessage.peerJoined(2).toWire()));
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, ["peer-joined"]);
  unsub();
  serverSocket.close();
});
