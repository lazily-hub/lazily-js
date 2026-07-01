const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function assertObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function assertTagged(value, name) {
  const object = assertObject(value, name);
  const entries = Object.entries(object);
  if (entries.length !== 1) {
    throw new TypeError(`${name} must be externally tagged`);
  }
  return entries[0];
}

function assertInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function bytesFromWire(value) {
  if (!Array.isArray(value)) {
    throw new TypeError("byte payload must be an array");
  }
  return value.map((byte, index) => {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new TypeError(`byte payload[${index}] must be in 0..255`);
    }
    return byte;
  });
}

function bytesOf(value) {
  if (value instanceof Uint8Array) {
    return Array.from(value);
  }
  return bytesFromWire(value);
}

// NodeKey: optional wire-stable "/"-joined keyed address (protocol.md § NodeKey).
// JSON omits the field when absent; a missing field decodes to null.
const NODE_KEY_MAX_BYTES = 1024;
const NODE_KEY_MAX_SEGMENTS = 32;

function normalizeNodeKey(key) {
  if (key === undefined || key === null) {
    return null;
  }
  if (typeof key !== "string") {
    throw new TypeError("NodeKey must be a string");
  }
  if (key === "") {
    throw new TypeError("NodeKey must not be empty");
  }
  if (textEncoder.encode(key).length > NODE_KEY_MAX_BYTES) {
    throw new TypeError(`NodeKey must be <= ${NODE_KEY_MAX_BYTES} bytes`);
  }
  const segments = key.split("/");
  if (segments.length > NODE_KEY_MAX_SEGMENTS) {
    throw new TypeError(`NodeKey must have <= ${NODE_KEY_MAX_SEGMENTS} segments`);
  }
  if (segments.some((segment) => segment === "")) {
    throw new TypeError(
      "NodeKey must not contain empty segments (leading/trailing/double '/')",
    );
  }
  return key;
}

export class ShmBlobRef {
  constructor({ offset, len, generation, epoch, checksum }) {
    this.offset = assertInteger(offset, "offset");
    this.len = assertInteger(len, "len");
    this.generation = assertInteger(generation, "generation");
    this.epoch = assertInteger(epoch, "epoch");
    this.checksum = assertInteger(checksum, "checksum");
    Object.freeze(this);
  }

  toWire() {
    return {
      offset: this.offset,
      len: this.len,
      generation: this.generation,
      epoch: this.epoch,
      checksum: this.checksum,
    };
  }

  static fromWire(value) {
    const object = assertObject(value, "ShmBlobRef");
    return new ShmBlobRef({
      offset: object.offset,
      len: object.len,
      generation: object.generation,
      epoch: object.epoch,
      checksum: object.checksum,
    });
  }
}

export class NodeStatePayload {
  constructor(bytes) {
    this.bytes = Object.freeze(bytesOf(bytes));
    Object.freeze(this);
  }

  toWire() {
    return { Payload: [...this.bytes] };
  }
}

export class NodeStateSharedBlob {
  constructor(blob) {
    this.blob = blob instanceof ShmBlobRef ? blob : ShmBlobRef.fromWire(blob);
    Object.freeze(this);
  }

  toWire() {
    return { SharedBlob: this.blob.toWire() };
  }
}

export class NodeStateOpaque {
  toWire() {
    return "Opaque";
  }
}

export const NodeState = Object.freeze({
  payload(bytes) {
    return new NodeStatePayload(bytes);
  },
  sharedBlob(blob) {
    return new NodeStateSharedBlob(blob);
  },
  opaque() {
    return new NodeStateOpaque();
  },
  fromWire(value) {
    if (typeof value === "string") {
      if (value !== "Opaque") {
        throw new TypeError(`unknown NodeState unit variant: ${value}`);
      }
      return new NodeStateOpaque();
    }

    const [tag, body] = assertTagged(value, "NodeState");
    switch (tag) {
      case "Payload":
        return new NodeStatePayload(body);
      case "SharedBlob":
        return new NodeStateSharedBlob(ShmBlobRef.fromWire(body));
      case "Opaque":
        return new NodeStateOpaque();
      default:
        throw new TypeError(`unknown NodeState variant: ${tag}`);
    }
  },
});

export class IpcValueInline {
  constructor(bytes) {
    this.bytes = Object.freeze(bytesOf(bytes));
    Object.freeze(this);
  }

  toWire() {
    return { Inline: [...this.bytes] };
  }
}

export class IpcValueSharedBlob {
  constructor(blob) {
    this.blob = blob instanceof ShmBlobRef ? blob : ShmBlobRef.fromWire(blob);
    Object.freeze(this);
  }

  toWire() {
    return { SharedBlob: this.blob.toWire() };
  }
}

export const IpcValue = Object.freeze({
  inline(bytes) {
    return new IpcValueInline(bytes);
  },
  sharedBlob(blob) {
    return new IpcValueSharedBlob(blob);
  },
  of(value) {
    if (value instanceof IpcValueInline || value instanceof IpcValueSharedBlob) {
      return value;
    }
    if (value instanceof ShmBlobRef) {
      return new IpcValueSharedBlob(value);
    }
    return new IpcValueInline(value);
  },
  fromWire(value) {
    const [tag, body] = assertTagged(value, "IpcValue");
    switch (tag) {
      case "Inline":
        return new IpcValueInline(body);
      case "SharedBlob":
        return new IpcValueSharedBlob(ShmBlobRef.fromWire(body));
      default:
        throw new TypeError(`unknown IpcValue variant: ${tag}`);
    }
  },
});

export class NodeSnapshot {
  constructor(node, typeTag, state, key = null) {
    this.node = assertInteger(node, "node");
    this.typeTag = String(typeTag);
    this.state = state;
    this.key = normalizeNodeKey(key);
    Object.freeze(this);
  }

  toWire() {
    const wire = {
      node: this.node,
      type_tag: this.typeTag,
      state: this.state.toWire(),
    };
    if (this.key !== null) {
      wire.key = this.key;
    }
    return wire;
  }

  static payload(node, typeTag, bytes, key) {
    return new NodeSnapshot(node, typeTag, NodeState.payload(bytes), key);
  }

  static sharedBlob(node, typeTag, blob, key) {
    return new NodeSnapshot(node, typeTag, NodeState.sharedBlob(blob), key);
  }

  static opaque(node, typeTag, key) {
    return new NodeSnapshot(node, typeTag, NodeState.opaque(), key);
  }

  static fromWire(value) {
    const object = assertObject(value, "NodeSnapshot");
    return new NodeSnapshot(
      object.node,
      object.type_tag,
      NodeState.fromWire(object.state),
      object.key ?? null,
    );
  }
}

export class EdgeSnapshot {
  constructor(dependent, dependency) {
    this.dependent = assertInteger(dependent, "dependent");
    this.dependency = assertInteger(dependency, "dependency");
    Object.freeze(this);
  }

  toWire() {
    return {
      dependent: this.dependent,
      dependency: this.dependency,
    };
  }

  isReadableBy(permissions, peer) {
    return (
      permissions.canRead(peer, this.dependent) &&
      permissions.canRead(peer, this.dependency)
    );
  }

  static fromWire(value) {
    const object = assertObject(value, "EdgeSnapshot");
    return new EdgeSnapshot(object.dependent, object.dependency);
  }
}

export class Snapshot {
  constructor({ epoch, nodes = [], edges = [], roots = [] }) {
    this.epoch = assertInteger(epoch, "epoch");
    this.nodes = Object.freeze([...nodes]);
    this.edges = Object.freeze([...edges]);
    this.roots = Object.freeze(roots.map((node) => assertInteger(node, "root")));
    Object.freeze(this);
  }

  toWire() {
    return {
      epoch: this.epoch,
      nodes: this.nodes.map((node) => node.toWire()),
      edges: this.edges.map((edge) => edge.toWire()),
      roots: [...this.roots],
    };
  }

  filterReadable(permissions, peer) {
    return new Snapshot({
      epoch: this.epoch,
      nodes: this.nodes.filter((node) => permissions.canRead(peer, node.node)),
      edges: this.edges.filter((edge) => edge.isReadableBy(permissions, peer)),
      roots: permissions.filterReadable(peer, this.roots),
    });
  }

  static fromWire(value) {
    const object = assertObject(value, "Snapshot");
    return new Snapshot({
      epoch: object.epoch,
      nodes: (object.nodes ?? []).map((node) => NodeSnapshot.fromWire(node)),
      edges: (object.edges ?? []).map((edge) => EdgeSnapshot.fromWire(edge)),
      roots: object.roots ?? [],
    });
  }
}

class DeltaOpBase {
  targetReadable() {
    throw new Error("DeltaOp.targetReadable must be implemented by subclasses");
  }
}

export class DeltaOpCellSet extends DeltaOpBase {
  constructor(node, payload) {
    super();
    this.node = assertInteger(node, "node");
    this.payload = IpcValue.of(payload);
    Object.freeze(this);
  }

  toWire() {
    return { CellSet: { node: this.node, payload: this.payload.toWire() } };
  }

  targetReadable(permissions, peer) {
    return permissions.canRead(peer, this.node);
  }
}

export class DeltaOpSlotValue extends DeltaOpBase {
  constructor(node, payload) {
    super();
    this.node = assertInteger(node, "node");
    this.payload = IpcValue.of(payload);
    Object.freeze(this);
  }

  toWire() {
    return { SlotValue: { node: this.node, payload: this.payload.toWire() } };
  }

  targetReadable(permissions, peer) {
    return permissions.canRead(peer, this.node);
  }
}

export class DeltaOpInvalidate extends DeltaOpBase {
  constructor(node) {
    super();
    this.node = assertInteger(node, "node");
    Object.freeze(this);
  }

  toWire() {
    return { Invalidate: { node: this.node } };
  }

  targetReadable(permissions, peer) {
    return permissions.canRead(peer, this.node);
  }
}

export class DeltaOpNodeAdd extends DeltaOpBase {
  constructor(node, typeTag, state, key = null) {
    super();
    this.node = assertInteger(node, "node");
    this.typeTag = String(typeTag);
    this.state = state;
    this.key = normalizeNodeKey(key);
    Object.freeze(this);
  }

  toWire() {
    const wire = {
      node: this.node,
      type_tag: this.typeTag,
      state: this.state.toWire(),
    };
    if (this.key !== null) {
      wire.key = this.key;
    }
    return { NodeAdd: wire };
  }

  targetReadable(permissions, peer) {
    return permissions.canRead(peer, this.node);
  }
}

export class DeltaOpNodeRemove extends DeltaOpBase {
  constructor(node) {
    super();
    this.node = assertInteger(node, "node");
    Object.freeze(this);
  }

  toWire() {
    return { NodeRemove: { node: this.node } };
  }

  targetReadable(permissions, peer) {
    return permissions.canRead(peer, this.node);
  }
}

export class DeltaOpEdgeAdd extends DeltaOpBase {
  constructor(dependent, dependency) {
    super();
    this.dependent = assertInteger(dependent, "dependent");
    this.dependency = assertInteger(dependency, "dependency");
    Object.freeze(this);
  }

  toWire() {
    return { EdgeAdd: { dependent: this.dependent, dependency: this.dependency } };
  }

  targetReadable(permissions, peer) {
    return (
      permissions.canRead(peer, this.dependent) &&
      permissions.canRead(peer, this.dependency)
    );
  }
}

export class DeltaOpEdgeRemove extends DeltaOpBase {
  constructor(dependent, dependency) {
    super();
    this.dependent = assertInteger(dependent, "dependent");
    this.dependency = assertInteger(dependency, "dependency");
    Object.freeze(this);
  }

  toWire() {
    return {
      EdgeRemove: { dependent: this.dependent, dependency: this.dependency },
    };
  }

  targetReadable(permissions, peer) {
    return (
      permissions.canRead(peer, this.dependent) &&
      permissions.canRead(peer, this.dependency)
    );
  }
}

export const DeltaOp = Object.freeze({
  cellSet(node, payload) {
    return new DeltaOpCellSet(node, payload);
  },
  slotValue(node, payload) {
    return new DeltaOpSlotValue(node, payload);
  },
  invalidate(node) {
    return new DeltaOpInvalidate(node);
  },
  nodeAdd(node, typeTag, state, key) {
    return new DeltaOpNodeAdd(node, typeTag, state, key);
  },
  nodeRemove(node) {
    return new DeltaOpNodeRemove(node);
  },
  edgeAdd(dependent, dependency) {
    return new DeltaOpEdgeAdd(dependent, dependency);
  },
  edgeRemove(dependent, dependency) {
    return new DeltaOpEdgeRemove(dependent, dependency);
  },
  fromWire(value) {
    const [tag, body] = assertTagged(value, "DeltaOp");
    const object = assertObject(body, tag);
    switch (tag) {
      case "CellSet":
        return new DeltaOpCellSet(object.node, IpcValue.fromWire(object.payload));
      case "SlotValue":
        return new DeltaOpSlotValue(object.node, IpcValue.fromWire(object.payload));
      case "Invalidate":
        return new DeltaOpInvalidate(object.node);
      case "NodeAdd":
        return new DeltaOpNodeAdd(
          object.node,
          object.type_tag,
          NodeState.fromWire(object.state),
          object.key ?? null,
        );
      case "NodeRemove":
        return new DeltaOpNodeRemove(object.node);
      case "EdgeAdd":
        return new DeltaOpEdgeAdd(object.dependent, object.dependency);
      case "EdgeRemove":
        return new DeltaOpEdgeRemove(object.dependent, object.dependency);
      default:
        throw new TypeError(`unknown DeltaOp variant: ${tag}`);
    }
  },
});

export const DeltaApplyStatusKind = Object.freeze({
  Apply: "apply",
  ResyncRequired: "resync_required",
});

export class DeltaApplyStatus {
  constructor(kind, fields = {}) {
    this.kind = kind;
    Object.assign(this, fields);
    Object.freeze(this);
  }

  get isApply() {
    return this.kind === DeltaApplyStatusKind.Apply;
  }

  get isResyncRequired() {
    return this.kind === DeltaApplyStatusKind.ResyncRequired;
  }

  static apply() {
    return new DeltaApplyStatus(DeltaApplyStatusKind.Apply);
  }

  static resyncRequired(lastEpoch, baseEpoch, epoch) {
    return new DeltaApplyStatus(DeltaApplyStatusKind.ResyncRequired, {
      lastEpoch,
      baseEpoch,
      epoch,
    });
  }
}

export class Delta {
  constructor({ baseEpoch, epoch, ops = [] }) {
    this.baseEpoch = assertInteger(baseEpoch, "baseEpoch");
    this.epoch = assertInteger(epoch, "epoch");
    this.ops = Object.freeze([...ops]);
    Object.freeze(this);
  }

  isNextAfter(lastEpoch) {
    return this.baseEpoch === lastEpoch && this.epoch === this.baseEpoch + 1;
  }

  applyStatus(lastEpoch) {
    if (this.isNextAfter(lastEpoch)) {
      return DeltaApplyStatus.apply();
    }
    return DeltaApplyStatus.resyncRequired(lastEpoch, this.baseEpoch, this.epoch);
  }

  filterReadable(permissions, peer) {
    return new Delta({
      baseEpoch: this.baseEpoch,
      epoch: this.epoch,
      ops: this.ops.filter((op) => op.targetReadable(permissions, peer)),
    });
  }

  toWire() {
    return {
      base_epoch: this.baseEpoch,
      epoch: this.epoch,
      ops: this.ops.map((op) => op.toWire()),
    };
  }

  static next(baseEpoch, ops = []) {
    return new Delta({ baseEpoch, epoch: baseEpoch + 1, ops });
  }

  static fromWire(value) {
    const object = assertObject(value, "Delta");
    return new Delta({
      baseEpoch: object.base_epoch,
      epoch: object.epoch,
      ops: (object.ops ?? []).map((op) => DeltaOp.fromWire(op)),
    });
  }
}

export class IpcMessage {
  constructor(kind, value) {
    this.kind = kind;
    if (kind === "Snapshot") {
      this.snapshot = value;
      this.delta = undefined;
    } else if (kind === "Delta") {
      this.snapshot = undefined;
      this.delta = value;
    } else {
      throw new TypeError(`unknown IpcMessage kind: ${kind}`);
    }
    Object.freeze(this);
  }

  get isSnapshot() {
    return this.kind === "Snapshot";
  }

  get isDelta() {
    return this.kind === "Delta";
  }

  toWire() {
    if (this.kind === "Snapshot") {
      return { Snapshot: this.snapshot.toWire() };
    }
    return { Delta: this.delta.toWire() };
  }

  encodeJson() {
    return textEncoder.encode(JSON.stringify(this.toWire()));
  }

  static snapshot(snapshot) {
    return new IpcMessage("Snapshot", snapshot);
  }

  static delta(delta) {
    return new IpcMessage("Delta", delta);
  }

  static fromWire(value) {
    const [tag, body] = assertTagged(value, "IpcMessage");
    switch (tag) {
      case "Snapshot":
        return IpcMessage.snapshot(Snapshot.fromWire(body));
      case "Delta":
        return IpcMessage.delta(Delta.fromWire(body));
      default:
        throw new TypeError(`unknown IpcMessage variant: ${tag}`);
    }
  }

  static decodeJson(data) {
    const text =
      data instanceof Uint8Array ? textDecoder.decode(data) : String(data);
    return IpcMessage.fromWire(JSON.parse(text));
  }
}

export const OpKind = Object.freeze({
  Read: "read",
  Write: "write",
  TriggerEffect: "trigger_effect",
});

export class RemoteOp {
  constructor(kind, node) {
    this.kind = kind;
    this.node = assertInteger(node, "node");
    Object.freeze(this);
  }

  static read(node) {
    return new RemoteOp(OpKind.Read, node);
  }

  static write(node) {
    return new RemoteOp(OpKind.Write, node);
  }

  static triggerEffect(node) {
    return new RemoteOp(OpKind.TriggerEffect, node);
  }
}

export class PermissionDenied extends Error {
  constructor(peer, op) {
    super(`peer ${peer} denied ${op.kind} on node ${op.node}`);
    this.name = "PermissionDenied";
    this.peer = peer;
    this.op = op;
  }
}

export class PeerPermissions {
  #peers = new Map();

  allow(peer, op) {
    const peerId = assertInteger(peer, "peer");
    let peerPerms = this.#peers.get(peerId);
    if (!peerPerms) {
      peerPerms = new Map();
      this.#peers.set(peerId, peerPerms);
    }
    let nodes = peerPerms.get(op.kind);
    if (!nodes) {
      nodes = new Set();
      peerPerms.set(op.kind, nodes);
    }
    const had = nodes.has(op.node);
    nodes.add(op.node);
    return !had;
  }

  allowMany(peer, kind, nodes) {
    for (const node of nodes) {
      this.allow(peer, new RemoteOp(kind, node));
    }
  }

  revoke(peer, op) {
    const peerPerms = this.#peers.get(peer);
    const nodes = peerPerms?.get(op.kind);
    if (!nodes?.delete(op.node)) {
      return false;
    }
    this.#prune(peer);
    return true;
  }

  revokePeer(peer) {
    return this.#peers.delete(peer);
  }

  isAllowed(peer, op) {
    return this.#peers.get(peer)?.get(op.kind)?.has(op.node) === true;
  }

  canRead(peer, node) {
    return this.isAllowed(peer, RemoteOp.read(node));
  }

  check(peer, op) {
    if (!this.isAllowed(peer, op)) {
      throw new PermissionDenied(peer, op);
    }
  }

  filterReadable(peer, nodes) {
    return [...nodes].filter((node) => this.canRead(peer, node));
  }

  peerCount() {
    return this.#peers.size;
  }

  #prune(peer) {
    const peerPerms = this.#peers.get(peer);
    if (!peerPerms) {
      return;
    }
    for (const [kind, nodes] of peerPerms.entries()) {
      if (nodes.size === 0) {
        peerPerms.delete(kind);
      }
    }
    if (peerPerms.size === 0) {
      this.#peers.delete(peer);
    }
  }
}
