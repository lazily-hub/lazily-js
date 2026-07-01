export type NodeId = number;
export type PeerId = number;
export type WireBytes = readonly number[] | Uint8Array;

export class ShmBlobRef {
  constructor(fields: {
    offset: number;
    len: number;
    generation: number;
    epoch: number;
    checksum: number;
  });
  readonly offset: number;
  readonly len: number;
  readonly generation: number;
  readonly epoch: number;
  readonly checksum: number;
  toWire(): ShmBlobRefWire;
  static fromWire(value: ShmBlobRefWire): ShmBlobRef;
}

export type ShmBlobRefWire = {
  offset: number;
  len: number;
  generation: number;
  epoch: number;
  checksum: number;
};

export class NodeStatePayload {
  constructor(bytes: WireBytes);
  readonly bytes: readonly number[];
  toWire(): { Payload: number[] };
}

export class NodeStateSharedBlob {
  constructor(blob: ShmBlobRef | ShmBlobRefWire);
  readonly blob: ShmBlobRef;
  toWire(): { SharedBlob: ShmBlobRefWire };
}

export class NodeStateOpaque {
  toWire(): "Opaque";
}

export type NodeStateValue =
  | NodeStatePayload
  | NodeStateSharedBlob
  | NodeStateOpaque;

export const NodeState: {
  payload(bytes: WireBytes): NodeStatePayload;
  sharedBlob(blob: ShmBlobRef | ShmBlobRefWire): NodeStateSharedBlob;
  opaque(): NodeStateOpaque;
  fromWire(value: unknown): NodeStateValue;
};

export class IpcValueInline {
  constructor(bytes: WireBytes);
  readonly bytes: readonly number[];
  toWire(): { Inline: number[] };
}

export class IpcValueSharedBlob {
  constructor(blob: ShmBlobRef | ShmBlobRefWire);
  readonly blob: ShmBlobRef;
  toWire(): { SharedBlob: ShmBlobRefWire };
}

export type IpcValueValue = IpcValueInline | IpcValueSharedBlob;

export const IpcValue: {
  inline(bytes: WireBytes): IpcValueInline;
  sharedBlob(blob: ShmBlobRef | ShmBlobRefWire): IpcValueSharedBlob;
  of(value: IpcValueValue | ShmBlobRef | ShmBlobRefWire | WireBytes): IpcValueValue;
  fromWire(value: unknown): IpcValueValue;
};

export class NodeSnapshot {
  constructor(node: NodeId, typeTag: string, state: NodeStateValue, key?: string | null);
  readonly node: NodeId;
  readonly typeTag: string;
  readonly state: NodeStateValue;
  readonly key: string | null;
  toWire(): unknown;
  static payload(node: NodeId, typeTag: string, bytes: WireBytes, key?: string | null): NodeSnapshot;
  static sharedBlob(
    node: NodeId,
    typeTag: string,
    blob: ShmBlobRef | ShmBlobRefWire,
    key?: string | null,
  ): NodeSnapshot;
  static opaque(node: NodeId, typeTag: string, key?: string | null): NodeSnapshot;
  static fromWire(value: unknown): NodeSnapshot;
}

export class EdgeSnapshot {
  constructor(dependent: NodeId, dependency: NodeId);
  readonly dependent: NodeId;
  readonly dependency: NodeId;
  toWire(): { dependent: NodeId; dependency: NodeId };
  isReadableBy(permissions: PeerPermissions, peer: PeerId): boolean;
  static fromWire(value: unknown): EdgeSnapshot;
}

export class Snapshot {
  constructor(fields: {
    epoch: number;
    nodes?: readonly NodeSnapshot[];
    edges?: readonly EdgeSnapshot[];
    roots?: readonly NodeId[];
  });
  readonly epoch: number;
  readonly nodes: readonly NodeSnapshot[];
  readonly edges: readonly EdgeSnapshot[];
  readonly roots: readonly NodeId[];
  toWire(): unknown;
  filterReadable(permissions: PeerPermissions, peer: PeerId): Snapshot;
  static fromWire(value: unknown): Snapshot;
}

export type DeltaOpValue =
  | DeltaOpCellSet
  | DeltaOpSlotValue
  | DeltaOpInvalidate
  | DeltaOpNodeAdd
  | DeltaOpNodeRemove
  | DeltaOpEdgeAdd
  | DeltaOpEdgeRemove;

export class DeltaOpCellSet {
  constructor(node: NodeId, payload: IpcValueValue | ShmBlobRef | WireBytes);
  readonly node: NodeId;
  readonly payload: IpcValueValue;
  toWire(): unknown;
  targetReadable(permissions: PeerPermissions, peer: PeerId): boolean;
}

export class DeltaOpSlotValue {
  constructor(node: NodeId, payload: IpcValueValue | ShmBlobRef | WireBytes);
  readonly node: NodeId;
  readonly payload: IpcValueValue;
  toWire(): unknown;
  targetReadable(permissions: PeerPermissions, peer: PeerId): boolean;
}

export class DeltaOpInvalidate {
  constructor(node: NodeId);
  readonly node: NodeId;
  toWire(): unknown;
  targetReadable(permissions: PeerPermissions, peer: PeerId): boolean;
}

export class DeltaOpNodeAdd {
  constructor(node: NodeId, typeTag: string, state: NodeStateValue, key?: string | null);
  readonly node: NodeId;
  readonly typeTag: string;
  readonly state: NodeStateValue;
  readonly key: string | null;
  toWire(): unknown;
  targetReadable(permissions: PeerPermissions, peer: PeerId): boolean;
}

export class DeltaOpNodeRemove {
  constructor(node: NodeId);
  readonly node: NodeId;
  toWire(): unknown;
  targetReadable(permissions: PeerPermissions, peer: PeerId): boolean;
}

export class DeltaOpEdgeAdd {
  constructor(dependent: NodeId, dependency: NodeId);
  readonly dependent: NodeId;
  readonly dependency: NodeId;
  toWire(): unknown;
  targetReadable(permissions: PeerPermissions, peer: PeerId): boolean;
}

export class DeltaOpEdgeRemove {
  constructor(dependent: NodeId, dependency: NodeId);
  readonly dependent: NodeId;
  readonly dependency: NodeId;
  toWire(): unknown;
  targetReadable(permissions: PeerPermissions, peer: PeerId): boolean;
}

export const DeltaOp: {
  cellSet(node: NodeId, payload: IpcValueValue | ShmBlobRef | WireBytes): DeltaOpCellSet;
  slotValue(node: NodeId, payload: IpcValueValue | ShmBlobRef | WireBytes): DeltaOpSlotValue;
  invalidate(node: NodeId): DeltaOpInvalidate;
  nodeAdd(node: NodeId, typeTag: string, state: NodeStateValue, key?: string | null): DeltaOpNodeAdd;
  nodeRemove(node: NodeId): DeltaOpNodeRemove;
  edgeAdd(dependent: NodeId, dependency: NodeId): DeltaOpEdgeAdd;
  edgeRemove(dependent: NodeId, dependency: NodeId): DeltaOpEdgeRemove;
  fromWire(value: unknown): DeltaOpValue;
};

export const DeltaApplyStatusKind: {
  readonly Apply: "apply";
  readonly ResyncRequired: "resync_required";
};

export class DeltaApplyStatus {
  readonly kind: "apply" | "resync_required";
  readonly lastEpoch?: number;
  readonly baseEpoch?: number;
  readonly epoch?: number;
  readonly isApply: boolean;
  readonly isResyncRequired: boolean;
  static apply(): DeltaApplyStatus;
  static resyncRequired(lastEpoch: number, baseEpoch: number, epoch: number): DeltaApplyStatus;
}

export class Delta {
  constructor(fields: {
    baseEpoch: number;
    epoch: number;
    ops?: readonly DeltaOpValue[];
  });
  readonly baseEpoch: number;
  readonly epoch: number;
  readonly ops: readonly DeltaOpValue[];
  isNextAfter(lastEpoch: number): boolean;
  applyStatus(lastEpoch: number): DeltaApplyStatus;
  filterReadable(permissions: PeerPermissions, peer: PeerId): Delta;
  toWire(): unknown;
  static next(baseEpoch: number, ops?: readonly DeltaOpValue[]): Delta;
  static fromWire(value: unknown): Delta;
}

export class WireStamp {
  constructor(fields: { wallTime: number; logical: number; peer: number });
  readonly wallTime: number;
  readonly logical: number;
  readonly peer: number;
  toWire(): WireStampWire;
  static fromWire(value: WireStampWire): WireStamp;
}

export type WireStampWire = {
  wall_time: number;
  logical: number;
  peer: number;
};

export type FrontierEntry = { peer: NodeId; stamp: WireStamp };

export class CrdtOp {
  constructor(
    node: NodeId,
    stamp: WireStamp | WireStampWire,
    state: IpcValueValue | ShmBlobRef | WireBytes,
    key?: string | null,
  );
  readonly node: NodeId;
  readonly stamp: WireStamp;
  readonly state: IpcValueValue;
  readonly key: string | null;
  toWire(): unknown;
  targetReadable(permissions: PeerPermissions, peer: PeerId): boolean;
  static keyed(
    node: NodeId,
    key: string | null,
    stamp: WireStamp | WireStampWire,
    state: IpcValueValue | ShmBlobRef | WireBytes,
  ): CrdtOp;
  static fromWire(value: unknown): CrdtOp;
}

export class CrdtSync {
  constructor(fields: {
    frontier?: ReadonlyArray<FrontierEntry | [NodeId, WireStamp | WireStampWire]>;
    ops?: ReadonlyArray<CrdtOp>;
  });
  readonly frontier: ReadonlyArray<FrontierEntry>;
  readonly ops: ReadonlyArray<CrdtOp>;
  filterReadable(permissions: PeerPermissions, peer: PeerId): CrdtSync;
  toWire(): unknown;
  static fromWire(value: unknown): CrdtSync;
}

export class IpcMessage {
  readonly kind: "Snapshot" | "Delta" | "CrdtSync";
  readonly snapshot?: Snapshot;
  readonly delta?: Delta;
  readonly crdtSync?: CrdtSync;
  readonly isSnapshot: boolean;
  readonly isDelta: boolean;
  readonly isCrdtSync: boolean;
  toWire(): unknown;
  encodeJson(): Uint8Array;
  static snapshot(snapshot: Snapshot): IpcMessage;
  static delta(delta: Delta): IpcMessage;
  static crdtSync(crdtSync: CrdtSync): IpcMessage;
  static fromWire(value: unknown): IpcMessage;
  static decodeJson(data: Uint8Array | string): IpcMessage;
}

export const OpKind: {
  readonly Read: "read";
  readonly Write: "write";
  readonly TriggerEffect: "trigger_effect";
};

export class RemoteOp {
  constructor(kind: string, node: NodeId);
  readonly kind: string;
  readonly node: NodeId;
  static read(node: NodeId): RemoteOp;
  static write(node: NodeId): RemoteOp;
  static triggerEffect(node: NodeId): RemoteOp;
}

export class PermissionDenied extends Error {
  readonly peer: PeerId;
  readonly op: RemoteOp;
}

export class PeerPermissions {
  allow(peer: PeerId, op: RemoteOp): boolean;
  allowMany(peer: PeerId, kind: string, nodes: Iterable<NodeId>): void;
  revoke(peer: PeerId, op: RemoteOp): boolean;
  revokePeer(peer: PeerId): boolean;
  isAllowed(peer: PeerId, op: RemoteOp): boolean;
  canRead(peer: PeerId, node: NodeId): boolean;
  check(peer: PeerId, op: RemoteOp): void;
  filterReadable(peer: PeerId, nodes: Iterable<NodeId>): NodeId[];
  peerCount(): number;
}
