import assert from "node:assert/strict";
import test from "node:test";

import {
  SimConsumerAdapterKind,
  SimConsumerConformanceError,
  SimConsumerDivergenceError,
  SimConsumerTestkit,
  SimConsumerWorldEvidence,
} from "../src/sim-consumer-testkit.js";
import { loadFixture } from "./spec-corpus.cjs";
import { assertKey } from "./support/assert-key.js";
import { recordScenario, scenarios } from "./support/scenario.js";

const fixture = loadFixture("simulation", "consumer_testkit.json");

function actionOf(action) {
  return {
    id: action.id,
    actorId: action.actor_id,
    kind: action.kind,
    version: action.version,
    payload: action.payload,
    ...(action.cause_id ? { causeId: action.cause_id } : {}),
  };
}

function generatedScenario() {
  return {
    generatorName: "consumer.scenario",
    generatorVersion: fixture.generator.version,
    seedHex: fixture.seed,
    actions: fixture.actions.map((action) => ({ command: "increment", action: actionOf(action) })),
  };
}

function portsFor(config) {
  return fixture.ports.map((port) => ({
    id: port.id,
    kind: port.kind,
    determinism: port.determinism,
    stubbed: port.id === "logical.clock" && config.clock_stub === "stubbed",
  }));
}

function buildAdapter(config, states) {
  const state = { value: 0, probes: 0, observations: [], history: [], world: null };
  states.set(config.id, state);
  const adapter = {
    id: config.id,
    kind: config.kind,
    serviceId: config.service_id,
    reducerId: config.reducer_id,
    productionReducerId: config.production_reducer_id,
    protocolId: config.protocol_id,
    externalPort: config.external_port,
    ports: portsFor(config),
    reset() {
      state.value = 0;
      state.history = [];
      state.observations = [];
      if (config.kind === SimConsumerAdapterKind.InMemory) {
        state.world = new SimConsumerWorldEvidence();
      }
    },
    apply(action) {
      if (config.execution_mode === "bypass") return;
      state.value += action.payload + config.delta_bias;
      if (config.execution_mode === "sim_world") state.world.record(action.id);
      if (config.history_mode === "exact") state.history.push(structuredClone(action));
    },
    observe() {
      state.observations.push(state.value);
      return { "consumer.value": state.value };
    },
  };
  if (config.kind === SimConsumerAdapterKind.InMemory) {
    adapter.worldEvidence = () => state.world;
    delete adapter.serviceId;
    delete adapter.externalPort;
  } else {
    adapter.probe = () => {
      state.probes += 1;
    };
    adapter.materializedHistory = () => structuredClone(state.history);
  }
  return adapter;
}

function kitFor(scenario, states) {
  return new SimConsumerTestkit({
    simulationAdapterId: scenario.simulation_adapter_id,
    requiredRealAdapters: scenario.required_real_adapters,
    requiredExternalProcesses: scenario.required_external_processes.map((selection) => ({
      adapterId: selection.adapter_id,
      port: selection.port,
    })),
    adapters: scenario.adapters.map((adapter) => buildAdapter(adapter, states)),
  });
}

test("consumer simulation testkit replays every canonical scenario", () => {
  assert.equal(fixture.kind, "ConsumerSimulationTestkit");
  assert.equal(fixture.model, "CounterReducerV1");
  let executed = 0;
  for (const scenario of scenarios(fixture)) {
    recordScenario(scenario);
    const states = new Map();
    const kit = kitFor(scenario, states);
    const expected = scenario.expected;
    let result = null;
    let error = null;
    try {
      result = kit.run(generatedScenario());
    } catch (cause) {
      error = cause;
    }

    if (expected.outcome === "success") {
      assert.equal(error, null, scenario.id);
      assertKey(expected, "outcome", "success", scenario.id);
      assertKey(expected, "adapter_ids", result.adapterIds, scenario.id);
      assertKey(
        expected,
        "checkpoint_steps",
        result.checkpoints.map((checkpoint) => checkpoint.step),
        scenario.id,
      );
      if ("checkpoint_action_ids" in expected) {
        assertKey(
          expected,
          "checkpoint_action_ids",
          result.checkpoints.map((checkpoint) => checkpoint.actionId),
          scenario.id,
        );
      }
      assertKey(expected, "checkpoint_values", states.get("memory").observations, scenario.id);
      if ("observation_relation" in expected) {
        const allEqual = result.checkpoints.every((checkpoint) => {
          const digests = Object.values(checkpoint.observationDigests);
          return digests.every((digest) => digest === digests[0]);
        });
        assertKey(
          expected,
          "observation_relation",
          allEqual ? "all_equal_at_every_checkpoint" : "diverged",
          scenario.id,
        );
        assertKey(
          expected,
          "materialized_history_relation",
          "exact_prefix_at_every_checkpoint",
          scenario.id,
        );
        const probed = scenario.adapters
          .filter((adapter) => adapter.kind !== SimConsumerAdapterKind.InMemory)
          .every((adapter) => states.get(adapter.id).probes === 1);
        assertKey(
          expected,
          "probe_relation",
          probed ? "every_real_adapter_once" : "wrong",
          scenario.id,
        );
      } else {
        const evidence = result.adapterEvidence.find(
          (item) => item.adapterId === expected.external_adapter_id,
        );
        assertKey(expected, "external_adapter_id", evidence.adapterId, scenario.id);
        assertKey(expected, "external_port", evidence.externalPort, scenario.id);
        assertKey(expected, "external_protocol_id", evidence.protocolId, scenario.id);
        assertKey(expected, "external_reducer_id", evidence.reducerId, scenario.id);
        assertKey(
          expected,
          "external_production_reducer_id",
          evidence.productionReducerId,
          scenario.id,
        );
      }
    } else {
      assert(error instanceof SimConsumerConformanceError, scenario.id);
      assertKey(expected, "outcome", expected.outcome, scenario.id);
      assertKey(expected, "step", error.step, scenario.id);
      assertKey(expected, "action_id", error.actionId, scenario.id);
      assertKey(expected, "adapter_id", error.adapterId, scenario.id);
      if (expected.outcome === "observation_divergence") {
        assert(error instanceof SimConsumerDivergenceError, scenario.id);
        assertKey(expected, "observation_id", error.observationId, scenario.id);
      } else if (expected.outcome === "materialized_history_mismatch") {
        assertKey(expected, "expected_prefix_length", error.expectedPrefixLength, scenario.id);
        assertKey(expected, "actual_prefix_length", error.actualPrefixLength, scenario.id);
      }
    }
    executed += 1;
  }
  assert.equal(executed, fixture.scenarios.length, "every loaded scenario executed");
});

function validPair() {
  const configs = [
    {
      id: "memory",
      kind: "in_memory",
      service_id: "",
      reducer_id: fixture.production_reducer_id,
      production_reducer_id: fixture.production_reducer_id,
      protocol_id: fixture.protocol_id,
      clock_stub: "stubbed",
      delta_bias: 0,
      history_mode: "none",
      execution_mode: "sim_world",
    },
    {
      id: "postgres.integration",
      kind: "postgres",
      service_id: "postgres.integration.service",
      reducer_id: fixture.production_reducer_id,
      production_reducer_id: fixture.production_reducer_id,
      protocol_id: fixture.protocol_id,
      clock_stub: "none",
      delta_bias: 0,
      history_mode: "exact",
      execution_mode: "real",
    },
  ];
  const states = new Map();
  return {
    simulationAdapterId: "memory",
    requiredRealAdapters: ["postgres"],
    adapters: configs.map((config) => buildAdapter(config, states)),
  };
}

test("consumer simulation testkit rejects invalid topology before callbacks", () => {
  const missingSelection = validPair();
  missingSelection.requiredRealAdapters = [];
  assert.throws(() => new SimConsumerTestkit(missingSelection), SimConsumerConformanceError);

  const deterministicStub = validPair();
  deterministicStub.adapters[0].ports[0].stubbed = true;
  assert.throws(() => new SimConsumerTestkit(deterministicStub), SimConsumerConformanceError);

  const missingObserve = validPair();
  delete missingObserve.adapters[1].observe;
  assert.throws(() => new SimConsumerTestkit(missingObserve), SimConsumerConformanceError);

  const protocolDrift = validPair();
  protocolDrift.adapters[1].protocolId = "other.protocol.v1";
  assert.throws(() => new SimConsumerTestkit(protocolDrift), SimConsumerConformanceError);
});

test("consumer simulation testkit rejects invalid scenarios at run boundary", () => {
  const kit = new SimConsumerTestkit(validPair());
  const invalidSeed = generatedScenario();
  invalidSeed.seedHex = "ABC";
  assert.throws(() => kit.run(invalidSeed), SimConsumerConformanceError);

  const duplicate = generatedScenario();
  duplicate.actions[1].action.id = duplicate.actions[0].action.id;
  assert.throws(() => kit.run(duplicate), SimConsumerConformanceError);
});
