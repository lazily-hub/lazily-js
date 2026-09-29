import { canonicalBytes, canonicalDigest } from "./replay.js";

export const SimConsumerAdapterKind = Object.freeze({
  InMemory: "in_memory",
  Postgres: "postgres",
  Nats: "nats",
  ExternalProcess: "external_process",
});

export const SimConsumerExternalPortKind = Object.freeze({
  Cli: "cli",
  Filesystem: "filesystem",
  LocalSocket: "local_socket",
  EditorReplica: "editor_replica",
});

export const SimConsumerPortDeterminism = Object.freeze({
  Deterministic: "deterministic",
  Nondeterministic: "nondeterministic",
});

const ADAPTER_KINDS = new Set(Object.values(SimConsumerAdapterKind));
const EXTERNAL_PORTS = new Set(Object.values(SimConsumerExternalPortKind));
const DETERMINISMS = new Set(Object.values(SimConsumerPortDeterminism));
const REAL_KINDS = new Set([
  SimConsumerAdapterKind.Postgres,
  SimConsumerAdapterKind.Nats,
  SimConsumerAdapterKind.ExternalProcess,
]);

export class SimConsumerConformanceError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "SimConsumerConformanceError";
    Object.assign(this, details);
  }
}

export class SimConsumerDivergenceError extends SimConsumerConformanceError {
  constructor({ step, actionId, baselineAdapterId, adapterId, observationId = "", kind }) {
    super(
      `step ${step} action '${actionId}' adapter '${adapterId}' differs from ` +
        `'${baselineAdapterId}': ${kind}${observationId === "" ? "" : ` '${observationId}'`}`,
      { step, actionId, baselineAdapterId, adapterId, observationId, kind },
    );
    this.name = "SimConsumerDivergenceError";
  }
}

/** Narrow deterministic-world evidence for bindings that do not ship a scheduler. */
export class SimConsumerWorldEvidence {
  constructor(identity = Object.freeze({})) {
    if ((typeof identity !== "object" && typeof identity !== "function") || identity === null) {
      throw new TypeError("world identity must be a non-null reference");
    }
    this.identity = identity;
    this.stepCount = 0;
    this.traceEntries = [];
  }

  record(actionId, kind = "action_applied") {
    requireId(actionId, "trace action id");
    requireId(kind, "trace kind");
    if (!kind.startsWith("action_")) {
      throw new TypeError("trace kind must identify action execution with an 'action_' prefix");
    }
    this.stepCount += 1;
    this.traceEntries.push(Object.freeze({ actionId, kind }));
  }
}

function fail(message, details) {
  throw new SimConsumerConformanceError(message, details);
}

function validId(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[a-z][a-z0-9._:-]*$/.test(value)
  );
}

function requireId(value, name) {
  if (!validId(value)) fail(`${name} must be a stable id`);
  return value;
}

function requireFunction(value, name) {
  if (typeof value !== "function") fail(`${name} callback is required`);
}

function cloneValue(value) {
  return structuredClone(value);
}

function cloneAction(action) {
  return {
    id: action.id,
    actorId: action.actorId,
    kind: action.kind,
    version: action.version,
    payload: cloneValue(action.payload),
    ...(action.causeId ? { causeId: action.causeId } : {}),
  };
}

function actionValue(action) {
  return {
    id: action.id,
    actor_id: action.actorId,
    kind: action.kind,
    version: action.version,
    payload: action.payload,
    cause_id: action.causeId ?? "",
  };
}

function scenarioValue(scenario) {
  return {
    generator_name: scenario.generatorName,
    generator_version: scenario.generatorVersion,
    scenario_index: scenario.scenarioIndex ?? 0,
    seed_hex: scenario.seedHex,
    actions: scenario.actions.map((generated) => ({
      command: generated.command,
      action: actionValue(generated.action),
    })),
    coverage_labels: scenario.coverageLabels ?? [],
  };
}

function bytesEqual(left, right) {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function validateAction(action) {
  if (action === null || typeof action !== "object") fail("scenario action must be an object");
  requireId(action.id, "action id");
  requireId(action.actorId, "action actor id");
  requireId(action.kind, "action kind");
  if (typeof action.version !== "string" || action.version === "") {
    fail("action version must be non-empty");
  }
  if (action.causeId) requireId(action.causeId, "action cause id");
  canonicalBytes(actionValue(action));
}

function validateScenario(scenario) {
  if (scenario === null || typeof scenario !== "object") fail("scenario must be an object");
  requireId(scenario.generatorName, "scenario generator name");
  if (typeof scenario.generatorVersion !== "string" || scenario.generatorVersion === "") {
    fail("scenario generator version must be non-empty");
  }
  if (typeof scenario.seedHex !== "string" || !/^[0-9a-f]{64}$/.test(scenario.seedHex)) {
    fail("scenario seed must be exactly 32 bytes of lowercase hexadecimal");
  }
  if (!Array.isArray(scenario.actions) || scenario.actions.length === 0) {
    fail("scenario must contain at least one generated action");
  }
  const seen = new Set();
  for (const generated of scenario.actions) {
    requireId(generated.command, "generator command");
    validateAction(generated.action);
    if (seen.has(generated.action.id)) fail(`duplicate action id '${generated.action.id}'`);
    if (generated.action.causeId && !seen.has(generated.action.causeId)) {
      fail(`action '${generated.action.id}' has unresolved cause '${generated.action.causeId}'`);
    }
    seen.add(generated.action.id);
  }
  return canonicalDigest(scenarioValue(scenario));
}

function portContract(ports) {
  return ports
    .map((port) => `${port.id}\0${port.kind}\0${port.determinism}`)
    .sort()
    .join("\n");
}

function normalizeAdapter(input) {
  const adapter = { ...input, ports: (input.ports ?? []).map((port) => ({ ...port })) };
  requireId(adapter.id, "adapter id");
  if (!ADAPTER_KINDS.has(adapter.kind)) fail(`adapter '${adapter.id}' has unknown kind`);
  requireId(adapter.protocolId, `adapter '${adapter.id}' protocol id`);
  requireId(adapter.reducerId, `adapter '${adapter.id}' reducer id`);
  requireFunction(adapter.reset, `adapter '${adapter.id}' reset`);
  requireFunction(adapter.apply, `adapter '${adapter.id}' apply`);
  requireFunction(adapter.observe, `adapter '${adapter.id}' observe`);
  if (adapter.ports.length === 0) fail(`adapter '${adapter.id}' needs at least one narrow port`);

  const seenPorts = new Set();
  for (const port of adapter.ports) {
    requireId(port.id, `adapter '${adapter.id}' port id`);
    requireId(port.kind, `adapter '${adapter.id}' port kind`);
    if (!DETERMINISMS.has(port.determinism)) {
      fail(`adapter '${adapter.id}' port '${port.id}' must declare determinism`);
    }
    if (seenPorts.has(port.id)) fail(`adapter '${adapter.id}' has duplicate port '${port.id}'`);
    seenPorts.add(port.id);
    if (port.stubbed && port.determinism !== SimConsumerPortDeterminism.Nondeterministic) {
      fail(`adapter '${adapter.id}' stubs deterministic port '${port.id}'`);
    }
    if (REAL_KINDS.has(adapter.kind) && port.stubbed) {
      fail(`real adapter '${adapter.id}' cannot stub port '${port.id}'`);
    }
  }

  if (adapter.kind === SimConsumerAdapterKind.InMemory) {
    requireId(adapter.productionReducerId, `adapter '${adapter.id}' production reducer id`);
    requireFunction(adapter.worldEvidence, `adapter '${adapter.id}' world evidence`);
    if (adapter.serviceId || adapter.probe || adapter.materializedHistory || adapter.externalPort) {
      fail(`in-memory adapter '${adapter.id}' carries real-adapter fields`);
    }
  } else {
    requireId(adapter.serviceId, `adapter '${adapter.id}' service id`);
    requireFunction(adapter.probe, `adapter '${adapter.id}' probe`);
    requireFunction(adapter.materializedHistory, `adapter '${adapter.id}' materialized history`);
    if (adapter.worldEvidence) fail(`real adapter '${adapter.id}' cannot expose world evidence`);
    if (adapter.kind === SimConsumerAdapterKind.ExternalProcess) {
      if (!EXTERNAL_PORTS.has(adapter.externalPort)) {
        fail(`external-process adapter '${adapter.id}' needs a supported port`);
      }
      if (adapter.productionReducerId) {
        fail(`external-process adapter '${adapter.id}' cannot claim a production reducer`);
      }
    } else {
      requireId(adapter.productionReducerId, `adapter '${adapter.id}' production reducer id`);
      if (adapter.reducerId !== adapter.productionReducerId) {
        fail(`adapter '${adapter.id}' reducer evidence differs from its production reducer`);
      }
      if (adapter.externalPort) fail(`adapter '${adapter.id}' cannot claim an external port`);
    }
  }
  return adapter;
}

function freezeObservation(value, adapterId) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`adapter '${adapterId}' observation must be a map`);
  }
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
  if (entries.length === 0) fail(`adapter '${adapterId}' returned no observations`);
  return new Map(entries.map(([key, item]) => [key, cloneValue(item)]));
}

function compareObservations(step, actionId, baselineId, adapterId, baseline, actual) {
  if (baseline.size !== actual.size) {
    throw new SimConsumerDivergenceError({
      step,
      actionId,
      baselineAdapterId: baselineId,
      adapterId,
      kind: "observation count",
    });
  }
  for (const [key, expected] of baseline) {
    if (!actual.has(key)) {
      throw new SimConsumerDivergenceError({
        step,
        actionId,
        baselineAdapterId: baselineId,
        adapterId,
        observationId: key,
        kind: "missing observation",
      });
    }
    if (!bytesEqual(canonicalBytes(expected), canonicalBytes(actual.get(key)))) {
      throw new SimConsumerDivergenceError({
        step,
        actionId,
        baselineAdapterId: baselineId,
        adapterId,
        observationId: key,
        kind: "value mismatch",
      });
    }
  }
}

function validateHistory(adapter, expected, details = {}) {
  const history = adapter.materializedHistory();
  if (!Array.isArray(history))
    fail(`adapter '${adapter.id}' materialized history must be an array`);
  if (history.length !== expected.length) {
    fail(
      `adapter '${adapter.id}' materialized history has ${history.length} actions, ` +
        `want exact prefix of ${expected.length}`,
      {
        ...details,
        adapterId: adapter.id,
        expectedPrefixLength: expected.length,
        actualPrefixLength: history.length,
      },
    );
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (
      !bytesEqual(
        canonicalBytes(actionValue(history[index])),
        canonicalBytes(actionValue(expected[index])),
      )
    ) {
      fail(`adapter '${adapter.id}' materialized action ${index} differs`, {
        ...details,
        adapterId: adapter.id,
        expectedPrefixLength: expected.length,
        actualPrefixLength: history.length,
      });
    }
  }
}

export class SimConsumerTestkit {
  constructor(spec) {
    if (spec === null || typeof spec !== "object") fail("testkit spec must be an object");
    requireId(spec.simulationAdapterId, "simulation adapter id");
    const requiredReal = [...(spec.requiredRealAdapters ?? [])];
    const requiredExternal = [...(spec.requiredExternalProcesses ?? [])];
    if (requiredReal.length === 0 && requiredExternal.length === 0) {
      fail("select at least one real adapter or external process");
    }
    if (new Set(requiredReal).size !== requiredReal.length)
      fail("duplicate required real adapter kind");
    for (const kind of requiredReal) {
      if (kind !== SimConsumerAdapterKind.Postgres && kind !== SimConsumerAdapterKind.Nats) {
        fail(`required adapter kind '${kind}' is not selectable by kind`);
      }
    }
    const externalSelections = new Map();
    for (const selection of requiredExternal) {
      requireId(selection.adapterId, "external-process selection adapter id");
      if (!EXTERNAL_PORTS.has(selection.port))
        fail("external-process selection has unsupported port");
      if (externalSelections.has(selection.adapterId)) fail("duplicate external-process selection");
      externalSelections.set(selection.adapterId, selection.port);
    }

    const adapters = (spec.adapters ?? [])
      .map(normalizeAdapter)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (adapters.length < 2)
      fail("testkit needs an in-memory adapter and at least one real adapter");
    const ids = new Set();
    const presentKinds = new Set();
    let protocolId = null;
    let productionReducerId = null;
    let contract = null;
    for (const adapter of adapters) {
      if (ids.has(adapter.id)) fail(`duplicate adapter id '${adapter.id}'`);
      ids.add(adapter.id);
      presentKinds.add(adapter.kind);
      if (protocolId === null) protocolId = adapter.protocolId;
      else if (adapter.protocolId !== protocolId)
        fail(`adapter '${adapter.id}' has protocol drift`);
      if (adapter.kind !== SimConsumerAdapterKind.ExternalProcess) {
        if (productionReducerId === null) productionReducerId = adapter.productionReducerId;
        else if (adapter.productionReducerId !== productionReducerId) {
          fail(`adapter '${adapter.id}' has production reducer drift`);
        }
      }
      const nextContract = portContract(adapter.ports);
      if (contract === null) contract = nextContract;
      else if (nextContract !== contract)
        fail(`adapter '${adapter.id}' has narrow-port contract drift`);

      if (
        adapter.kind === SimConsumerAdapterKind.Postgres ||
        adapter.kind === SimConsumerAdapterKind.Nats
      ) {
        if (!requiredReal.includes(adapter.kind))
          fail(`real adapter '${adapter.id}' was not selected`);
      } else if (adapter.kind === SimConsumerAdapterKind.ExternalProcess) {
        if (!externalSelections.has(adapter.id))
          fail(`external-process adapter '${adapter.id}' was not selected`);
        if (externalSelections.get(adapter.id) !== adapter.externalPort) {
          fail(`external-process adapter '${adapter.id}' selection port mismatch`);
        }
      }
    }
    for (const kind of requiredReal) {
      if (!presentKinds.has(kind)) fail(`required real adapter kind '${kind}' is missing`);
    }
    for (const id of externalSelections.keys()) {
      const adapter = adapters.find((candidate) => candidate.id === id);
      if (!adapter) fail(`required external-process adapter '${id}' is missing`);
      if (adapter.kind !== SimConsumerAdapterKind.ExternalProcess) {
        fail(`external-process selection '${id}' resolves to '${adapter.kind}'`);
      }
    }
    const baselineIndex = adapters.findIndex((adapter) => adapter.id === spec.simulationAdapterId);
    if (baselineIndex < 0) fail(`simulation adapter '${spec.simulationAdapterId}' is missing`);
    if (adapters[baselineIndex].kind !== SimConsumerAdapterKind.InMemory) {
      fail(`simulation adapter '${spec.simulationAdapterId}' must be in_memory`);
    }
    this.adapters = adapters;
    this.baselineIndex = baselineIndex;
  }

  run(scenario) {
    const scenarioDigest = validateScenario(scenario);
    for (const adapter of this.adapters) {
      if (REAL_KINDS.has(adapter.kind)) adapter.probe();
      adapter.reset();
      if (adapter.kind === SimConsumerAdapterKind.InMemory) {
        const world = adapter.worldEvidence();
        if (!(world instanceof SimConsumerWorldEvidence)) {
          fail(`in-memory adapter '${adapter.id}' did not expose SimConsumerWorldEvidence`);
        }
      } else {
        validateHistory(adapter, []);
      }
    }

    const result = {
      scenarioDigest,
      adapterIds: this.adapters.map((adapter) => adapter.id),
      adapterEvidence: this.adapters.map((adapter) => ({
        adapterId: adapter.id,
        kind: adapter.kind,
        serviceId: adapter.serviceId ?? "",
        externalPort: adapter.externalPort ?? "",
        protocolId: adapter.protocolId,
        reducerId: adapter.reducerId,
        productionReducerId: adapter.productionReducerId ?? "",
      })),
      checkpoints: [],
    };

    const expectedHistory = [];
    for (let index = 0; index < scenario.actions.length; index += 1) {
      const generated = scenario.actions[index];
      const step = index + 1;
      const observations = [];
      const observationDigests = {};
      for (const adapter of this.adapters) {
        let world = null;
        let identity = null;
        let stepsBefore = 0;
        let traceBefore = 0;
        if (adapter.kind === SimConsumerAdapterKind.InMemory) {
          world = adapter.worldEvidence();
          identity = world.identity;
          stepsBefore = world.stepCount;
          traceBefore = world.traceEntries.length;
        }
        adapter.apply(cloneAction(generated.action));
        if (adapter.kind === SimConsumerAdapterKind.InMemory) {
          const after = adapter.worldEvidence();
          const executed = after.traceEntries
            .slice(traceBefore)
            .some(
              (entry) => entry.actionId === generated.action.id && entry.kind.startsWith("action_"),
            );
          if (
            after !== world ||
            after.identity !== identity ||
            after.stepCount <= stepsBefore ||
            !executed
          ) {
            fail(`adapter '${adapter.id}' bypassed its simulation world`, {
              step,
              actionId: generated.action.id,
              adapterId: adapter.id,
            });
          }
        } else {
          validateHistory(adapter, [...expectedHistory, generated.action], {
            step,
            actionId: generated.action.id,
          });
        }
        const observed = freezeObservation(adapter.observe(), adapter.id);
        observations.push(observed);
        observationDigests[adapter.id] = canonicalDigest(observed);
      }
      expectedHistory.push(cloneAction(generated.action));
      const baseline = observations[this.baselineIndex];
      const baselineId = this.adapters[this.baselineIndex].id;
      for (let adapterIndex = 0; adapterIndex < this.adapters.length; adapterIndex += 1) {
        if (adapterIndex === this.baselineIndex) continue;
        compareObservations(
          step,
          generated.action.id,
          baselineId,
          this.adapters[adapterIndex].id,
          baseline,
          observations[adapterIndex],
        );
      }
      result.checkpoints.push({
        step,
        actionId: generated.action.id,
        observationDigests,
      });
    }
    return result;
  }
}
