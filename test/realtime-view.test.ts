import assert from "node:assert/strict";
import test from "node:test";
import { Delta, Snapshot } from "@lazily-hub/lazily-js";
import { RealtimeView } from "@lazily-hub/lazily-js/realtime-view";
import type { ViewEvent, ViewRevision } from "@lazily-hub/lazily-js/realtime-view";
import { View } from "@lazily-hub/lazily-js/view";
import { loadFixture } from "./spec-corpus.cjs";

type Step = {
  operation: "attach" | "replace" | "delta" | "event";
  status: string;
  revision?: string;
  snapshot?: string;
  delta?: string;
  frame?: ViewEvent;
  deny?: boolean;
  action?: string;
  current_revision?: number | null;
  epoch?: number | null;
  rows?: string[];
  identities?: Record<string, number>;
  message?: string;
};

const stable = loadFixture("view", "field_change.json");
const fixture = stable.realtime as
  | undefined
  | {
      instance: string;
      revisions: Record<string, ViewRevision>;
      snapshots: Record<string, { Snapshot: Parameters<typeof Snapshot.fromWire>[0] }>;
      deltas: Record<string, { Delta: Parameters<typeof Delta.fromWire>[0] }>;
      steps: Step[];
    };

test("published View package entry point interprets the stable field-change fixture", () => {
  const view = View.install(stable.view);
  assert.deepEqual(view.signalsJson(), stable.signals);
  assert.deepEqual(view.layoutJson(), stable.layout);
});

const requireRealtimeFixture = process.env.LAZILY_REQUIRE_REALTIME_VIEW_FIXTURE === "1";
test(
  "realtime View shared TypeScript fixture",
  { skip: !fixture && !requireRealtimeFixture },
  () => {
    assert.ok(
      fixture,
      "Pinned lazily-spec field_change.json must contain the realtime View fixture",
    );
    const receiver = new RealtimeView(fixture.instance);
    const identities = new Map<string, { token: object; generation: number }>();
    const replay = (step: Step) => {
      switch (step.operation) {
        case "attach":
          return receiver.attach(
            fixture.revisions[step.revision!],
            Snapshot.fromWire(fixture.snapshots[step.snapshot!].Snapshot),
          );
        case "replace":
          return receiver.replace(fixture.revisions[step.revision!]);
        case "delta":
          return receiver.applyDelta(Delta.fromWire(fixture.deltas[step.delta!].Delta));
        case "event": {
          const result = receiver.routeEvent(step.frame!, () => step.deny !== true);
          assert.equal(result.status === "accepted" ? result.action : undefined, step.action);
          return result.status;
        }
      }
    };

    for (const [index, step] of fixture.steps.entries()) {
      const label = `step ${index + 1} ${step.operation}`;
      if (step.status === "invalid") assert.throws(() => replay(step), label);
      else assert.equal(replay(step), step.status, label);

      if ("current_revision" in step) assert.equal(receiver.revision, step.current_revision, label);
      if ("epoch" in step) assert.equal(receiver.epoch, step.epoch, label);
      if (step.rows)
        assert.deepEqual(
          receiver.nodes.find((node) => node.id === "results")?.children,
          step.rows,
          label,
        );
      if (step.message) {
        assert.equal(receiver.signals.message, step.message, label);
        assert.equal(
          receiver.nodes.find((node) => node.id === "message")?.text,
          step.message,
          label,
        );
      }
      for (const node of receiver.nodes) {
        const previous = identities.get(node.id);
        identities.set(node.id, {
          token: node.identity,
          generation: (previous?.generation ?? 0) + Number(previous?.token !== node.identity),
        });
      }
      for (const [id, generation] of Object.entries(step.identities ?? {})) {
        assert.equal(identities.get(id)?.generation, generation, `${label} ${id}`);
      }
    }
    const badSum = structuredClone(fixture.revisions["new-identity"]);
    badSum.revision++;
    const definition = badSum.definition as { nodes: { message: { text: object } } };
    definition.nodes.message.text = {
      op: "call",
      args: ["add", Number.MAX_SAFE_INTEGER, 2, -Number.MAX_SAFE_INTEGER],
    };
    assert.throws(() => receiver.replace(badSum), /safe integer/);
    assert.equal(receiver.revision, badSum.revision - 1);
  },
);
