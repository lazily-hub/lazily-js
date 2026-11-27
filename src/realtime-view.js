import { GraphView } from "./graph-view.js";
import { Delta, ResyncAction, ResyncCoordinator, Snapshot } from "./index.js";
import { View } from "./view.js";

const eventTypes = ["activate", "change", "submit"];
const scalarTypeTag = "lazily.view.scalar.v1";
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function shape(value, fields, label) {
  if (
    !isObject(value) ||
    Object.keys(value).length !== fields.length ||
    !fields.every((field) => Object.hasOwn(value, field))
  ) {
    throw new TypeError(`Invalid ${label} fields`);
  }
}

function id(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`Invalid ${label}`);
}

function counter(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new TypeError("Invalid realtime View counter");
}

function scalar(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (Number.isSafeInteger(value)) return value === 0 ? 0 : value;
  throw new TypeError("Invalid realtime View scalar");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return scalar(value);
}

function revision(frame) {
  shape(
    frame,
    ["version", "view_instance", "revision", "definition", "bindings", "actions"],
    "View revision",
  );
  if (frame.version !== 1) throw new TypeError("Unsupported realtime View version");
  id(frame.view_instance, "view_instance");
  counter(frame.revision, 1);
  const copy = canonicalJson(frame);
  const { definition, bindings, actions } = copy;
  if (
    !isObject(definition) ||
    !isObject(definition.signals) ||
    !isObject(definition.nodes) ||
    !isObject(bindings) ||
    !isObject(actions)
  ) {
    throw new TypeError("Invalid realtime View definition, bindings, or actions");
  }
  for (const [signal, node] of Object.entries(bindings)) {
    if (!Object.hasOwn(definition.signals, signal))
      throw new TypeError(`Unknown View signal ${signal}`);
    counter(node);
  }
  for (const [node, entries] of Object.entries(actions)) {
    if (!Object.hasOwn(definition.nodes, node) || !isObject(entries)) {
      throw new TypeError(`Invalid View actions for ${node}`);
    }
    for (const [event, action] of Object.entries(entries)) {
      if (!eventTypes.includes(event)) throw new TypeError(`Unknown View event ${event}`);
      id(action, "action ID");
    }
  }
  return copy;
}

function eventFrame(frame) {
  shape(
    frame,
    ["version", "view_instance", "displayed_revision", "node_id", "event_id", "event", "payload"],
    "View event",
  );
  if (frame.version !== 1 || !eventTypes.includes(frame.event))
    throw new TypeError("Invalid realtime View event");
  id(frame.view_instance, "view_instance");
  id(frame.node_id, "node_id");
  id(frame.event_id, "event_id");
  counter(frame.displayed_revision, 1);
  if (frame.event === "activate" && frame.payload !== null)
    throw new TypeError("activate requires a null payload");
  return Object.freeze({ ...frame, payload: scalar(frame.payload) });
}

function projection(frame, graph, previous) {
  const values = new Map();
  for (const [signal, nodeId] of Object.entries(frame.bindings)) {
    const node = graph.node(nodeId);
    if (node?.typeTag !== scalarTypeTag || node.payload === null) {
      throw new TypeError(`Missing scalar payload for View signal ${signal}`);
    }
    values.set(signal, scalar(JSON.parse(decoder.decode(Uint8Array.from(node.payload)))));
  }
  const view = View.install(frame.definition, values);
  const expressions = view.expressionsJson();
  const nodes = new Map();
  for (const row of view.layoutJson()) {
    const binding = frame.definition.nodes[row.id].bind ?? null;
    const old = previous.get(row.id);
    const identity =
      old?.role === row.role && old.binding === binding ? old.identity : Object.freeze({});
    const hiddenKey = `${row.id}.hidden`;
    const hidden = Object.hasOwn(expressions, hiddenKey) ? expressions[hiddenKey] : false;
    const disabledKey = `${row.id}.disabled`;
    const disabled = Object.hasOwn(expressions, disabledKey) ? expressions[disabledKey] : false;
    if (typeof hidden !== "boolean" || typeof disabled !== "boolean") {
      throw new TypeError(`View node ${row.id} has a non-boolean flag`);
    }
    nodes.set(
      row.id,
      Object.freeze({
        ...row,
        children: Object.freeze([...row.children]),
        binding,
        identity,
        text: scalar(expressions[`${row.id}.text`] ?? null),
        hidden,
        disabled,
      }),
    );
  }
  return { nodes, signals: Object.freeze(view.signalsJson()) };
}

/** Receiver state for one realtime View instance. Outward dispatch belongs to the host. */
export class RealtimeView {
  #frame = null;
  #graph = new GraphView();
  #sync = new ResyncCoordinator();
  #nodes = new Map();
  #signals = Object.freeze({});
  #accepted = new Map();

  constructor(instance) {
    id(instance, "view_instance");
    Object.defineProperty(this, "instance", { value: instance, enumerable: true });
  }

  get revision() {
    return this.#frame?.revision ?? null;
  }
  get epoch() {
    return this.#graph.isInitialized ? this.#graph.epoch : null;
  }
  get nodes() {
    return [...this.#nodes.values()];
  }
  get signals() {
    return this.#signals;
  }

  #checkRevision(raw) {
    const frame = revision(raw);
    if (frame.view_instance !== this.instance) throw new TypeError("Wrong View instance");
    if (this.#frame && frame.revision < this.#frame.revision) return null;
    if (this.#frame && frame.definition.id !== this.#frame.definition.id) {
      throw new TypeError("View document ID changed");
    }
    if (
      frame.revision === this.#frame?.revision &&
      JSON.stringify(frame) !== JSON.stringify(this.#frame)
    ) {
      throw new TypeError("Conflicting View revision");
    }
    return frame;
  }

  #publish(frame, graph, next) {
    this.#frame = frame;
    this.#graph = graph;
    this.#nodes = next.nodes;
    this.#signals = next.signals;
  }

  attach(raw, snapshot) {
    const frame = this.#checkRevision(raw);
    if (!(snapshot instanceof Snapshot)) throw new TypeError("Expected a graph Snapshot");
    counter(snapshot.epoch);
    if (frame === null || (this.epoch !== null && snapshot.epoch < this.epoch)) return "ignored";
    const graph = new GraphView();
    graph.applySnapshot(snapshot);
    this.#publish(frame, graph, projection(frame, graph, this.#nodes));
    this.#sync.ingestSnapshot(snapshot.epoch);
    return "applied";
  }

  replace(raw) {
    if (!this.#frame) throw new TypeError("Attach a View Snapshot first");
    const frame = this.#checkRevision(raw);
    if (frame === null || frame.revision === this.#frame.revision) return "ignored";
    this.#publish(frame, this.#graph, projection(frame, this.#graph, this.#nodes));
    return "applied";
  }

  applyDelta(delta) {
    if (!this.#frame) throw new TypeError("Attach a View Snapshot first");
    if (!(delta instanceof Delta)) throw new TypeError("Expected a graph Delta");
    counter(delta.baseEpoch);
    counter(delta.epoch);
    if (delta.epoch <= delta.baseEpoch) throw new TypeError("Invalid graph Delta span");
    if (delta.baseEpoch !== this.#graph.epoch) {
      return this.#sync.ingestDelta(delta).action === ResyncAction.RequestSnapshot
        ? "snapshot-required"
        : "ignored";
    }
    const graph = this.#graph.fork();
    graph.applyDelta(delta);
    this.#publish(this.#frame, graph, projection(this.#frame, graph, this.#nodes));
    this.#sync.ingestDelta(delta);
    return "applied";
  }

  routeEvent(raw, authorize) {
    const frame = eventFrame(raw);
    if (frame.view_instance !== this.instance) return { status: "wrong-instance" };
    const previous = this.#accepted.get(frame.event_id);
    const fingerprint = JSON.stringify(canonicalJson(frame));
    if (previous !== undefined)
      return { status: previous === fingerprint ? "duplicate" : "conflict" };
    if (frame.displayed_revision !== this.revision) return { status: "stale" };
    const node = this.#nodes.get(frame.node_id);
    const actions = this.#frame.actions;
    const action = Object.hasOwn(actions, frame.node_id)
      ? actions[frame.node_id][frame.event]
      : undefined;
    if (!node || node.hidden || node.disabled || action === undefined)
      return { status: "unavailable" };
    if (authorize(action, frame) !== true) return { status: "denied" };
    this.#accepted.set(frame.event_id, fingerprint);
    return { status: "accepted", action };
  }
}
