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

// A frontier entry is the (peer, WireStamp) tuple lazily-rs carries as
// Vec<(u64, WireStamp)>; serde emits it as a 2-element JSON array [peer, stamp].
function frontierEntryFromWire(value) {
  if (!Array.isArray(value) || value.length !== 2) {
    throw new TypeError("frontier entry must be a [peer, WireStamp] pair");
  }
  return Object.freeze({
    peer: assertInteger(value[0], "frontier peer"),
    stamp: WireStamp.fromWire(value[1]),
  });
}

function frontierEntryOf(entry) {
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    if ("peer" in entry) {
      return Object.freeze({
        peer: assertInteger(entry.peer, "frontier peer"),
        stamp:
          entry.stamp instanceof WireStamp
            ? entry.stamp
            : WireStamp.fromWire(entry.stamp),
      });
    }
  }
  return frontierEntryFromWire(entry);
}

export class WireStamp {
  constructor({ wallTime, logical, peer }) {
    this.wallTime = assertInteger(wallTime, "wallTime");
    this.logical = assertInteger(logical, "logical");
    this.peer = assertInteger(peer, "peer");
    Object.freeze(this);
  }

  toWire() {
    return {
      wall_time: this.wallTime,
      logical: this.logical,
      peer: this.peer,
    };
  }

  static fromWire(value) {
    const object = assertObject(value, "WireStamp");
    return new WireStamp({
      wallTime: object.wall_time,
      logical: object.logical,
      peer: object.peer,
    });
  }
}

export class CrdtOp {
  constructor(node, stamp, state, key = null) {
    this.node = assertInteger(node, "node");
    this.stamp = stamp instanceof WireStamp ? stamp : WireStamp.fromWire(stamp);
    this.state = IpcValue.of(state);
    // CrdtOp mirrors lazily-rs's derived serde (no skip_serializing_if), so a
    // keyless op serializes `key: null` — unlike NodeSnapshot/NodeAdd, which
    // omit the field. normalizeNodeKey still enforces bounds when a key is set.
    this.key = normalizeNodeKey(key);
    Object.freeze(this);
  }

  toWire() {
    return {
      node: this.node,
      key: this.key,
      stamp: this.stamp.toWire(),
      state: this.state.toWire(),
    };
  }

  targetReadable(permissions, peer) {
    return permissions.canRead(peer, this.node);
  }

  static keyed(node, key, stamp, state) {
    return new CrdtOp(node, stamp, state, key);
  }

  static fromWire(value) {
    const object = assertObject(value, "CrdtOp");
    return new CrdtOp(
      object.node,
      WireStamp.fromWire(object.stamp),
      IpcValue.fromWire(object.state),
      object.key ?? null,
    );
  }
}

export class CrdtSync {
  constructor({ frontier = [], ops = [] }) {
    this.frontier = Object.freeze(frontier.map(frontierEntryOf));
    this.ops = Object.freeze([...ops]);
    Object.freeze(this);
  }

  filterReadable(permissions, peer) {
    // The frontier advertisement names peers and stamps, not node content, and
    // the receiver needs the whole frontier to compute a sound watermark — so
    // it is retained in full while ops are omitted (not redacted), like Delta.
    return new CrdtSync({
      frontier: this.frontier,
      ops: this.ops.filter((op) => op.targetReadable(permissions, peer)),
    });
  }

  toWire() {
    return {
      frontier: this.frontier.map((entry) => [
        entry.peer,
        entry.stamp.toWire(),
      ]),
      ops: this.ops.map((op) => op.toWire()),
    };
  }

  static fromWire(value) {
    const object = assertObject(value, "CrdtSync");
    return new CrdtSync({
      frontier: (object.frontier ?? []).map(frontierEntryFromWire),
      ops: (object.ops ?? []).map((op) => CrdtOp.fromWire(op)),
    });
  }
}

export const ReceiptOutcome = Object.freeze({
  Observed: "observed",
  Accepted: "accepted",
  Applied: "applied",
  Rejected: "rejected",
});

export function isTerminalReceiptOutcome(outcome) {
  return outcome === ReceiptOutcome.Applied || outcome === ReceiptOutcome.Rejected;
}

function normalizeReceiptOutcome(outcome) {
  if (Object.values(ReceiptOutcome).includes(outcome)) {
    return outcome;
  }
  throw new TypeError(`unknown receipt outcome: ${outcome}`);
}

export class CausalReceipt {
  constructor({
    receiptId,
    causationId,
    observer,
    generation,
    outcome,
    reason = null,
    payloadHash = null,
  }) {
    this.receiptId = assertString(receiptId, "receiptId");
    this.causationId = assertString(causationId, "causationId");
    this.observer = assertString(observer, "observer");
    this.generation = assertInteger(generation, "generation");
    this.outcome = normalizeReceiptOutcome(outcome);
    this.reason = reason === null ? null : assertString(reason, "reason");
    this.payloadHash = payloadHash === null ? null : assertString(payloadHash, "payloadHash");
    Object.freeze(this);
  }

  get isTerminal() {
    return isTerminalReceiptOutcome(this.outcome);
  }

  toWire() {
    return {
      receipt_id: this.receiptId,
      causation_id: this.causationId,
      observer: this.observer,
      generation: this.generation,
      outcome: this.outcome,
      reason: this.reason,
      payload_hash: this.payloadHash,
    };
  }

  static observed(receiptId, causationId, observer, generation) {
    return new CausalReceipt({
      receiptId,
      causationId,
      observer,
      generation,
      outcome: ReceiptOutcome.Observed,
    });
  }

  static accepted(receiptId, causationId, observer, generation) {
    return new CausalReceipt({
      receiptId,
      causationId,
      observer,
      generation,
      outcome: ReceiptOutcome.Accepted,
    });
  }

  static applied(receiptId, causationId, observer, generation, payloadHash = null) {
    return new CausalReceipt({
      receiptId,
      causationId,
      observer,
      generation,
      outcome: ReceiptOutcome.Applied,
      payloadHash,
    });
  }

  static rejected(receiptId, causationId, observer, generation, reason = null) {
    return new CausalReceipt({
      receiptId,
      causationId,
      observer,
      generation,
      outcome: ReceiptOutcome.Rejected,
      reason,
    });
  }

  static fromWire(value) {
    const object = assertObject(value, "CausalReceipt");
    return new CausalReceipt({
      receiptId: object.receipt_id,
      causationId: object.causation_id,
      observer: object.observer,
      generation: object.generation,
      outcome: object.outcome,
      reason: object.reason ?? null,
      payloadHash: object.payload_hash ?? null,
    });
  }
}

export class CausalReceipts {
  constructor(receipts = []) {
    this.receipts = Object.freeze(receipts.map((receipt) =>
      receipt instanceof CausalReceipt ? receipt : CausalReceipt.fromWire(receipt),
    ));
    Object.freeze(this);
  }

  toWire() {
    return {
      receipts: this.receipts.map((receipt) => receipt.toWire()),
    };
  }

  static fromWire(value) {
    const object = assertObject(value, "CausalReceipts");
    return new CausalReceipts(object.receipts ?? []);
  }
}

export class ReceiptMessage {
  constructor(kind, value) {
    this.kind = kind;
    this.causalReceipts = undefined;
    if (kind === "CausalReceipts") {
      this.causalReceipts =
        value instanceof CausalReceipts ? value : CausalReceipts.fromWire(value);
    } else {
      throw new TypeError(`unknown ReceiptMessage kind: ${kind}`);
    }
    Object.freeze(this);
  }

  toWire() {
    return { CausalReceipts: this.causalReceipts.toWire() };
  }

  encodeJson() {
    return textEncoder.encode(JSON.stringify(this.toWire()));
  }

  static causalReceipts(causalReceipts) {
    return new ReceiptMessage("CausalReceipts", causalReceipts);
  }

  static fromWire(value) {
    const [tag, body] = assertTagged(value, "ReceiptMessage");
    switch (tag) {
      case "CausalReceipts":
        return ReceiptMessage.causalReceipts(CausalReceipts.fromWire(body));
      default:
        throw new TypeError(`unknown ReceiptMessage variant: ${tag}`);
    }
  }

  static decodeJson(data) {
    const text =
      data instanceof Uint8Array ? textDecoder.decode(data) : String(data);
    return ReceiptMessage.fromWire(JSON.parse(text));
  }
}

export const ReceiptApplyStatusKind = Object.freeze({
  Recorded: "recorded",
  Duplicate: "duplicate",
  StaleGeneration: "stale_generation",
  TerminalConflict: "terminal_conflict",
});

export class ReceiptProjection {
  #receiptsById = new Map();
  #latestByCausation = new Map();
  #terminalByCausation = new Map();
  #staleReceiptIds = new Set();

  observe(currentGeneration, receipt) {
    const next = receipt instanceof CausalReceipt ? receipt : CausalReceipt.fromWire(receipt);
    if (this.#receiptsById.has(next.receiptId) || this.#staleReceiptIds.has(next.receiptId)) {
      return { kind: ReceiptApplyStatusKind.Duplicate };
    }

    if (currentGeneration !== null && currentGeneration !== undefined) {
      const expected = assertInteger(currentGeneration, "currentGeneration");
      if (next.generation !== expected) {
        this.#staleReceiptIds.add(next.receiptId);
        return {
          kind: ReceiptApplyStatusKind.StaleGeneration,
          expected,
          actual: next.generation,
        };
      }
    }

    if (next.isTerminal) {
      const existing = this.#terminalByCausation.get(next.causationId);
      if (existing && existing.outcome !== next.outcome) {
        return {
          kind: ReceiptApplyStatusKind.TerminalConflict,
          causationId: next.causationId,
          existing: existing.outcome,
          incoming: next.outcome,
        };
      }
      if (!existing) {
        this.#terminalByCausation.set(next.causationId, next);
      }
    }

    this.#latestByCausation.set(next.causationId, next);
    this.#receiptsById.set(next.receiptId, next);
    return { kind: ReceiptApplyStatusKind.Recorded };
  }

  latestFor(causationId) {
    return this.#latestByCausation.get(causationId) ?? null;
  }

  terminalFor(causationId) {
    return this.#terminalByCausation.get(causationId) ?? null;
  }

  containsReceipt(receiptId) {
    return this.#receiptsById.has(receiptId) || this.#staleReceiptIds.has(receiptId);
  }

  staleReceiptIds() {
    return [...this.#staleReceiptIds];
  }
}

export class IpcMessage {
  constructor(kind, value) {
    this.kind = kind;
    this.snapshot = undefined;
    this.delta = undefined;
    this.crdtSync = undefined;
    if (kind === "Snapshot") {
      this.snapshot = value;
    } else if (kind === "Delta") {
      this.delta = value;
    } else if (kind === "CrdtSync") {
      this.crdtSync = value;
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

  get isCrdtSync() {
    return this.kind === "CrdtSync";
  }

  toWire() {
    if (this.kind === "Snapshot") {
      return { Snapshot: this.snapshot.toWire() };
    }
    if (this.kind === "Delta") {
      return { Delta: this.delta.toWire() };
    }
    return { CrdtSync: this.crdtSync.toWire() };
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

  static crdtSync(crdtSync) {
    return new IpcMessage("CrdtSync", crdtSync);
  }

  static fromWire(value) {
    const [tag, body] = assertTagged(value, "IpcMessage");
    switch (tag) {
      case "Snapshot":
        return IpcMessage.snapshot(Snapshot.fromWire(body));
      case "Delta":
        return IpcMessage.delta(Delta.fromWire(body));
      case "CrdtSync":
        return IpcMessage.crdtSync(CrdtSync.fromWire(body));
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

// Capability negotiation (protocol.md § Capability Negotiation). Every
// non-local session starts with this compatibility handshake, exchanged before
// any `Snapshot` or `Delta` flows. If peers disagree on `protocol_major_version`,
// `codec`, `ordered_reliable`, or required features, they fail closed.
export const PROTOCOL_ID = "lazily-ipc";
export const PROTOCOL_MAJOR_VERSION = 1;

export const Codec = Object.freeze({
  Json: "json",
  Bincode: "bincode",
  Postcard: "postcard",
});

// FFI message-kind discriminant (schemas/ffi.json § LazilyFfiMessageKind). The
// JSON representation is normative; CrdtSync = 3 is required of the discriminant.
export const LazilyFfiMessageKind = Object.freeze({
  Unknown: 0,
  Snapshot: 1,
  Delta: 2,
  CrdtSync: 3,
});

// The FFI status codes mirror schemas/ffi.json § LazilyFfiStatus.
export const LazilyFfiStatus = Object.freeze({
  Ok: 0,
  Empty: 1,
  NullPointer: 2,
  InvalidMessage: 3,
  EncodeFailed: 4,
  Panic: 5,
});

function assertString(value, name) {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
  return value;
}

function assertBoolean(value, name) {
  if (typeof value !== "boolean") {
    throw new TypeError(`${name} must be a boolean`);
  }
  return value;
}

function assertStringArray(value, name) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array of strings`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new TypeError(`${name}[${index}] must be a string`);
    }
    return item;
  });
}

export class SessionHandshake {
  constructor(fields) {
    const obj = assertObject(fields, "SessionHandshake");
    this.protocolId = assertString(obj.protocol_id, "protocol_id");
    this.protocolMajorVersion = assertInteger(
      obj.protocol_major_version,
      "protocol_major_version",
    );
    this.codec = assertString(obj.codec, "codec");
    this.maxFrameSize = assertInteger(obj.max_frame_size, "max_frame_size");
    this.fragmentationSupported = assertBoolean(
      obj.fragmentation_supported,
      "fragmentation_supported",
    );
    this.orderedReliable = assertBoolean(obj.ordered_reliable, "ordered_reliable");
    this.peerId = assertInteger(obj.peer_id, "peer_id");
    this.sessionId = assertString(obj.session_id, "session_id");
    this.features = Object.freeze(assertStringArray(obj.features ?? [], "features"));
    Object.freeze(this);
  }

  toWire() {
    return {
      protocol_id: this.protocolId,
      protocol_major_version: this.protocolMajorVersion,
      codec: this.codec,
      max_frame_size: this.maxFrameSize,
      fragmentation_supported: this.fragmentationSupported,
      ordered_reliable: this.orderedReliable,
      peer_id: this.peerId,
      session_id: this.sessionId,
      features: [...this.features],
    };
  }

  encodeJson() {
    return textEncoder.encode(JSON.stringify(this.toWire()));
  }

  // Fail-closed compatibility check (protocol.md § Capability Negotiation).
  // Peers are compatible only when they agree on `protocol_id`,
  // `protocol_major_version`, `codec`, and `ordered_reliable`, and `other`
  // offers every feature this side requires.
  checkCompatible(other, requiredFeatures = []) {
    if (this.protocolId !== PROTOCOL_ID) {
      return { ok: false, field: "protocol_id", reason: `expected "${PROTOCOL_ID}"` };
    }
    if (other.protocolId !== PROTOCOL_ID) {
      return { ok: false, field: "protocol_id", reason: `peer is not ${PROTOCOL_ID}` };
    }
    if (this.protocolMajorVersion !== other.protocolMajorVersion) {
      return {
        ok: false,
        field: "protocol_major_version",
        reason: `${this.protocolMajorVersion} != ${other.protocolMajorVersion}`,
      };
    }
    if (this.codec !== other.codec) {
      return { ok: false, field: "codec", reason: `${this.codec} != ${other.codec}` };
    }
    if (this.orderedReliable !== other.orderedReliable) {
      return {
        ok: false,
        field: "ordered_reliable",
        reason: `${this.orderedReliable} != ${other.orderedReliable}`,
      };
    }
    const offered = new Set(other.features);
    for (const required of requiredFeatures) {
      if (!offered.has(required)) {
        return {
          ok: false,
          field: "features",
          reason: `peer does not offer required feature "${required}"`,
        };
      }
    }
    return { ok: true };
  }

  static fromWire(value) {
    return new SessionHandshake(assertObject(value, "SessionHandshake"));
  }

  static decodeJson(data) {
    const text =
      data instanceof Uint8Array ? textDecoder.decode(data) : String(data);
    return SessionHandshake.fromWire(JSON.parse(text));
  }
}

// lazily-js binding-level conformance declaration. The conformance matrix lists
// each layer as MUST; a binding that structurally cannot host a layer MUST
// advertise the omission (capability negotiation / fail-closed) rather than stay
// silent. lazily-js runs on browser/Worker JS — a platform with no shared
// in-process address space — so it declares the C-ABI FFI carve-out
// (`ffi = none`) per protocol.md § "C-ABI FFI is required". Every other MUST
// layer is shipped: the reactive core, keyed collections, the semantic tree,
// the sequence + text CRDTs, IPC, state machine, state charts, permissions, and
// capability negotiation.
export const FfiCapability = Object.freeze({
  Host: "host",
  None: "none",
});

export const BINDING_CAPABILITIES = Object.freeze({
  binding: "lazily-js",
  // C-ABI FFI: carve-out — browser/Worker JS cannot host a native in-process ABI.
  // Must NOT be advertised as embeddable; still exposes the full state plane
  // (incl. CrdtSync) over IPC/WebSocket/WebRTC.
  ffi: FfiCapability.None,
  // Reactive core (Cell/Slot/Effect/Signal): shipped.
  reactive_core: true,
  // Async reactive context: shipped (./reactive-async — Promise-driven derivations
  // with revision-guarded stale-completion discard, in-flight dedup, cancellation).
  async_context: true,
  // Shipped MUST surfaces:
  ipc: true,
  crdt: true,
  collections: { cellmap: true, celltree: true, reconcile: true },
  sem_tree: true,
  seq_crdt: true,
  text_crdt: true,
  stable_id: true,
  state_machine: true,
  state_charts: true,
  permissions: true,
  capability_negotiation: true,
  causal_receipts: true,
  // Optional (MAY) transports — bridged by this binding (./signaling,
  // ./distributed): the kebab-tagged signaling wire protocol + room routing and
  // the WebRTC DataChannel IPC transport + CRDT anti-entropy runtime. Real
  // WebRTC is reached through a browser platform adapter (no npm dependency).
  signaling: true,
  webrtc: true,
});

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
