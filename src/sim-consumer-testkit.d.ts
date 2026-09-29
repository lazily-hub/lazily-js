export type SimConsumerAdapterKindValue = "in_memory" | "postgres" | "nats" | "external_process";
export type SimConsumerExternalPortKindValue =
  "cli" | "filesystem" | "local_socket" | "editor_replica";
export type SimConsumerPortDeterminismValue = "deterministic" | "nondeterministic";

export const SimConsumerAdapterKind: {
  readonly InMemory: "in_memory";
  readonly Postgres: "postgres";
  readonly Nats: "nats";
  readonly ExternalProcess: "external_process";
};
export const SimConsumerExternalPortKind: {
  readonly Cli: "cli";
  readonly Filesystem: "filesystem";
  readonly LocalSocket: "local_socket";
  readonly EditorReplica: "editor_replica";
};
export const SimConsumerPortDeterminism: {
  readonly Deterministic: "deterministic";
  readonly Nondeterministic: "nondeterministic";
};

export interface SimAction {
  id: string;
  actorId: string;
  kind: string;
  version: string;
  payload: unknown;
  causeId?: string;
}

export interface SimGeneratedAction {
  command: string;
  action: SimAction;
}

export interface SimGeneratedScenario {
  generatorName: string;
  generatorVersion: string;
  scenarioIndex?: number;
  seedHex: string;
  actions: readonly SimGeneratedAction[];
  coverageLabels?: readonly string[];
}

export interface SimConsumerPort {
  id: string;
  kind: string;
  determinism: SimConsumerPortDeterminismValue;
  stubbed?: boolean;
}

export interface SimConsumerTraceEntry {
  readonly actionId: string;
  readonly kind: string;
}

export class SimConsumerWorldEvidence {
  constructor(identity?: object | Function);
  readonly identity: object | Function;
  stepCount: number;
  readonly traceEntries: SimConsumerTraceEntry[];
  record(actionId: string, kind?: string): void;
}

export interface SimConsumerAdapter {
  id: string;
  kind: SimConsumerAdapterKindValue;
  productionReducerId?: string;
  protocolId: string;
  reducerId: string;
  serviceId?: string;
  externalPort?: SimConsumerExternalPortKindValue;
  ports: readonly SimConsumerPort[];
  probe?: () => void;
  worldEvidence?: () => SimConsumerWorldEvidence;
  reset: () => void;
  apply: (action: SimAction) => void;
  observe: () => ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>;
  materializedHistory?: () => SimAction[];
}

export interface SimConsumerExternalProcessSelection {
  adapterId: string;
  port: SimConsumerExternalPortKindValue;
}

export interface SimConsumerTestkitSpec {
  simulationAdapterId: string;
  requiredRealAdapters?: readonly SimConsumerAdapterKindValue[];
  requiredExternalProcesses?: readonly SimConsumerExternalProcessSelection[];
  adapters: readonly SimConsumerAdapter[];
}

export interface SimConsumerAdapterEvidence {
  adapterId: string;
  kind: SimConsumerAdapterKindValue;
  serviceId: string;
  externalPort: SimConsumerExternalPortKindValue | "";
  protocolId: string;
  reducerId: string;
  productionReducerId: string;
}

export interface SimConsumerCheckpoint {
  step: number;
  actionId: string;
  observationDigests: Record<string, string>;
}

export interface SimConsumerRunResult {
  scenarioDigest: string;
  adapterIds: string[];
  adapterEvidence: SimConsumerAdapterEvidence[];
  checkpoints: SimConsumerCheckpoint[];
}

export class SimConsumerConformanceError extends Error {
  constructor(message: string, details?: Record<string, unknown>);
  readonly step?: number;
  readonly actionId?: string;
  readonly adapterId?: string;
  readonly expectedPrefixLength?: number;
  readonly actualPrefixLength?: number;
}

export class SimConsumerDivergenceError extends SimConsumerConformanceError {
  readonly step: number;
  readonly actionId: string;
  readonly baselineAdapterId: string;
  readonly adapterId: string;
  readonly observationId: string;
  readonly kind: string;
}

export class SimConsumerTestkit {
  constructor(spec: SimConsumerTestkitSpec);
  run(scenario: SimGeneratedScenario): SimConsumerRunResult;
}
