/**
 * Host-neutral view compute document.
 *
 * Install lowers each signal to a source, each text/hidden/disabled expression
 * to a guarded computed, and the optional chart to one StateChart. Dispatch
 * runs effect trees. The conformance trace records set and send only.
 */

import { createContext } from "./reactive.js";
import { ChartDef, StateChart } from "./statechart.js";

const ROLES = new Set(["text", "button", "field", "list", "region"]);
const FLOWS = new Set(["row", "column", "stack"]);
const ALIGNS = new Set(["start", "center", "end", "stretch"]);
const EVENTS = new Set(["activate", "change", "submit"]);
const EXPR_OPS = new Set(["lit", "ref", "call", "if", "eq", "concat", "trim"]);
const EFFECT_OPS = new Set(["set", "batch", "send"]);
const CALLS = new Set(["event", "not", "add", "len"]);

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function allow(obj, keys, what) {
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key)) fail(`${what} has unknown field \`${key}\``);
  }
}

function req(obj, key, what) {
  if (!Object.hasOwn(obj, key)) fail(`${what} missing \`${key}\``);
  return obj[key];
}

function reqStr(obj, key, what) {
  const value = req(obj, key, what);
  if (typeof value !== "string") fail(`${what} \`${key}\` must be a string`);
  return value;
}

function literal(value) {
  if (value === null) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isInteger(value)) fail(`non-integer number ${value}`);
    return value;
  }
  fail("value must be null, boolean, integer, or string");
}

function stringify(value) {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return value;
}

function validateArg(value, signals, inEffect) {
  if (isObject(value)) validateExpr(value, signals, inEffect);
  else literal(value);
}

function validateCall(args, signals, inEffect) {
  if (args.length === 0) fail("call takes a name");
  if (typeof args[0] !== "string") fail("call name must be a string");
  const name = args[0];
  if (!CALLS.has(name)) fail(`unknown call \`${name}\``);
  const rest = args.slice(1);
  if (name === "event") {
    if (rest.length !== 0) fail("event takes no arguments");
    if (!inEffect) fail("event is illegal outside an effect");
  } else if (name === "not") {
    if (rest.length !== 1) fail("not takes one boolean");
    validateArg(rest[0], signals, inEffect);
  } else if (name === "add") {
    if (rest.length < 2) fail("add takes two or more integers");
    for (const arg of rest) validateArg(arg, signals, inEffect);
  } else if (name === "len") {
    if (rest.length !== 1) fail("len takes one string");
    validateArg(rest[0], signals, inEffect);
  }
}

function validateExpr(expr, signals, inEffect) {
  if (!isObject(expr)) fail("expression must be an object");
  allow(expr, ["op", "args"], "expression");
  const op = reqStr(expr, "op", "expression");
  if (!EXPR_OPS.has(op)) fail(`unknown expression op \`${op}\``);
  const args = req(expr, "args", "expression");
  if (!Array.isArray(args)) fail("expression args must be an array");
  if (op === "lit") {
    if (args.length !== 1) fail("lit takes one literal");
    literal(args[0]);
  } else if (op === "ref") {
    if (args.length !== 1 || typeof args[0] !== "string") fail("ref takes one signal id");
    if (!signals.has(args[0])) fail(`unknown signal \`${args[0]}\``);
  } else if (op === "call") {
    validateCall(args, signals, inEffect);
  } else if (op === "if") {
    if (args.length !== 3) fail("if takes three arguments");
    for (const arg of args) validateArg(arg, signals, inEffect);
  } else if (op === "eq") {
    if (args.length !== 2) fail("eq takes two arguments");
    for (const arg of args) validateArg(arg, signals, inEffect);
  } else if (op === "concat") {
    for (const arg of args) validateArg(arg, signals, inEffect);
  } else if (op === "trim") {
    if (args.length !== 1) fail("trim takes one value");
    validateArg(args[0], signals, inEffect);
  }
}

function validateEffect(effect, signals, hasChart) {
  if (!isObject(effect)) fail("effect must be an object");
  allow(effect, ["op", "args"], "effect");
  const op = reqStr(effect, "op", "effect");
  if (!EFFECT_OPS.has(op)) fail(`unknown effect op \`${op}\``);
  const args = req(effect, "args", "effect");
  if (!Array.isArray(args)) fail("effect args must be an array");
  if (op === "set") {
    if (args.length !== 2 || typeof args[0] !== "string") fail("set takes a signal id and a value");
    if (!signals.has(args[0])) fail(`unknown signal \`${args[0]}\``);
    validateArg(args[1], signals, true);
  } else if (op === "send") {
    if (!hasChart) fail("send requires a chart");
    if ((args.length !== 1 && args.length !== 2) || typeof args[0] !== "string") {
      fail("send takes an event name and an optional payload");
    }
    if (args.length === 2) validateArg(args[1], signals, true);
  } else if (op === "batch") {
    if (args.length === 0) fail("batch takes one or more effects");
    for (const nested of args) validateEffect(nested, signals, hasChart);
  }
}

function standingExpr(value, signals) {
  if (typeof value === "string") return { op: "lit", args: [value] };
  if (isObject(value)) {
    validateExpr(value, signals, false);
    return value;
  }
  fail("text must be a string or an expression");
}

function standingFlag(field, value, signals) {
  if (typeof value === "boolean") return { op: "lit", args: [value] };
  if (isObject(value)) {
    validateExpr(value, signals, false);
    return value;
  }
  fail(`${field} must be a boolean or an expression`);
}

function parseChildren(id, value) {
  if (!Array.isArray(value)) fail(`node \`${id}\` children must be an array`);
  const seen = new Set();
  for (const child of value) {
    if (typeof child !== "string" || child.length === 0) {
      fail(`node \`${id}\` children must be non-empty strings`);
    }
    if (seen.has(child)) fail(`node \`${id}\` repeats child \`${child}\``);
    seen.add(child);
  }
  return value.slice();
}

function parseLayout(id, value) {
  if (!isObject(value)) fail(`node \`${id}\` layout must be an object`);
  allow(value, ["flow", "align", "grow"], `node \`${id}\` layout`);
  let flow = null;
  if (Object.hasOwn(value, "flow")) {
    if (typeof value.flow !== "string" || !FLOWS.has(value.flow))
      fail(`unknown flow \`${value.flow}\``);
    flow = value.flow;
  }
  if (Object.hasOwn(value, "align")) {
    if (typeof value.align !== "string" || !ALIGNS.has(value.align)) {
      fail(`unknown align \`${value.align}\``);
    }
  }
  if (Object.hasOwn(value, "grow")) {
    if (typeof value.grow !== "number" || !Number.isInteger(value.grow) || value.grow < 0) {
      fail(`node \`${id}\` layout.grow must be an integer >= 0`);
    }
  }
  return flow;
}

function checkTree(root, nodes) {
  const stack = new Set();
  const done = new Set();
  const walk = (id) => {
    if (stack.has(id)) fail(`children cycle at \`${id}\``);
    if (done.has(id)) fail(`node \`${id}\` has more than one parent`);
    stack.add(id);
    for (const child of nodes[id].children) {
      if (!Object.hasOwn(nodes, child)) fail(`children name unknown node \`${child}\``);
      walk(child);
    }
    stack.delete(id);
    done.add(id);
  };
  walk(root);
  if (done.size !== Object.keys(nodes).length) fail("a node is not reachable from root");
}

function evalArg(value, read, payload, safeIntegers = false) {
  return isObject(value) ? evalExpr(value, read, payload, safeIntegers) : literal(value);
}

function evalCall(args, read, payload, safeIntegers) {
  if (args.length === 0 || typeof args[0] !== "string") fail("call takes a name");
  const rest = args.slice(1);
  if (args[0] === "event") {
    if (rest.length !== 0) fail("event takes no arguments");
    if (payload === undefined) fail("event is illegal outside an effect");
    return payload;
  }
  if (args[0] === "not") {
    if (rest.length !== 1) fail("not takes one boolean");
    const value = evalArg(rest[0], read, payload, safeIntegers);
    if (typeof value !== "boolean") fail("not expects a boolean");
    return !value;
  }
  if (args[0] === "add") {
    if (rest.length < 2) fail("add takes two or more integers");
    let sum = 0;
    for (const arg of rest) {
      const value = evalArg(arg, read, payload, safeIntegers);
      if (typeof value !== "number") fail("add expects integers");
      sum += value;
      if (safeIntegers && !Number.isSafeInteger(sum)) fail("add exceeds safe integer range");
    }
    return sum;
  }
  if (args[0] === "len") {
    if (rest.length !== 1) fail("len takes one string");
    const value = evalArg(rest[0], read, payload, safeIntegers);
    if (typeof value !== "string") fail("len expects a string");
    return [...value].length;
  }
  fail(`unknown call \`${args[0]}\``);
}

function evalExpr(expr, read, payload, safeIntegers) {
  const args = expr.args;
  if (expr.op === "lit") return literal(args[0]);
  if (expr.op === "ref") return read(args[0]);
  if (expr.op === "call") return evalCall(args, read, payload, safeIntegers);
  if (expr.op === "if") {
    const cond = evalArg(args[0], read, payload, safeIntegers);
    if (typeof cond !== "boolean") fail("if condition must be a boolean");
    return evalArg(args[cond ? 1 : 2], read, payload, safeIntegers);
  }
  if (expr.op === "eq") {
    return Object.is(
      evalArg(args[0], read, payload, safeIntegers),
      evalArg(args[1], read, payload, safeIntegers),
    );
  }
  if (expr.op === "concat") {
    return args.map((arg) => stringify(evalArg(arg, read, payload, safeIntegers))).join("");
  }
  if (expr.op === "trim") return stringify(evalArg(args[0], read, payload, safeIntegers)).trim();
  fail(`unknown expression op \`${expr.op}\``);
}

export class View {
  /** @param {ReturnType<typeof createContext>} ctx */
  constructor(ctx, doc, values) {
    if (!isObject(doc)) fail("view must be a JSON object");
    allow(doc, ["id", "root", "signals", "nodes", "chart"], "view");
    const id = reqStr(doc, "id", "view");
    if (id.length === 0) fail("view id must be a non-empty string");
    const root = reqStr(doc, "root", "view");
    if (root.length === 0) fail("view root must be a non-empty string");

    const signalsDoc = req(doc, "signals", "view");
    if (!isObject(signalsDoc)) fail("view `signals` must be an object");
    const signalIds = new Set();
    const initials = new Map();
    for (const [sid, raw] of Object.entries(signalsDoc)) {
      if (sid.length === 0) fail("signal id must be a non-empty string");
      if (!isObject(raw)) fail(`signal \`${sid}\` must be an object`);
      allow(raw, ["initial"], `signal \`${sid}\``);
      signalIds.add(sid);
      initials.set(sid, literal(req(raw, "initial", `signal \`${sid}\``)));
    }

    const hasChart = Object.hasOwn(doc, "chart");
    let chart = null;
    if (hasChart) {
      if (!isObject(doc.chart)) fail("chart must be a statechart document");
      chart = new StateChart(ChartDef.fromChart(doc.chart));
    }

    const nodesDoc = req(doc, "nodes", "view");
    if (!isObject(nodesDoc) || Object.keys(nodesDoc).length === 0) {
      fail("view nodes must contain at least one node");
    }
    const nodes = Object.create(null);
    const effects = Object.create(null);
    const exprDocs = [];
    for (const [nid, raw] of Object.entries(nodesDoc)) {
      if (nid.length === 0) fail("node id must be a non-empty string");
      if (!isObject(raw)) fail(`node \`${nid}\` must be an object`);
      allow(
        raw,
        ["role", "children", "layout", "text", "bind", "hidden", "disabled", "effects"],
        `node \`${nid}\``,
      );
      const role = reqStr(raw, "role", `node \`${nid}\``);
      if (!ROLES.has(role)) fail(`unknown role \`${role}\``);
      const children = Object.hasOwn(raw, "children") ? parseChildren(nid, raw.children) : [];
      const flow = Object.hasOwn(raw, "layout") ? parseLayout(nid, raw.layout) : null;
      if (Object.hasOwn(raw, "bind")) {
        if (typeof raw.bind !== "string" || raw.bind.length === 0) {
          fail(`node \`${nid}\` bind must be a non-empty string`);
        }
        if (!signalIds.has(raw.bind)) fail(`bind names unknown signal \`${raw.bind}\``);
      }
      if (Object.hasOwn(raw, "text"))
        exprDocs.push([`${nid}.text`, standingExpr(raw.text, signalIds)]);
      if (Object.hasOwn(raw, "hidden")) {
        exprDocs.push([`${nid}.hidden`, standingFlag("hidden", raw.hidden, signalIds)]);
      }
      if (Object.hasOwn(raw, "disabled")) {
        exprDocs.push([`${nid}.disabled`, standingFlag("disabled", raw.disabled, signalIds)]);
      }
      if (Object.hasOwn(raw, "effects")) {
        if (!isObject(raw.effects)) fail(`node \`${nid}\` effects must be an object`);
        allow(raw.effects, ["activate", "change", "submit"], `node \`${nid}\` effects`);
        const stored = {};
        for (const [event, effect] of Object.entries(raw.effects)) {
          validateEffect(effect, signalIds, hasChart);
          stored[event] = effect;
        }
        if (Object.keys(stored).length > 0) effects[nid] = stored;
      }
      nodes[nid] = { role, children, flow };
    }
    if (!Object.hasOwn(nodes, root)) fail(`root \`${root}\` is not a node`);
    checkTree(root, nodes);

    this.ctx = ctx;
    this.root = root;
    this.nodes = nodes;
    this.effects = effects;
    this.chart = chart;
    this.payload = undefined;
    this.signals = Object.create(null);
    for (const [sid, initial] of initials) {
      this.signals[sid] = ctx.source(values?.has(sid) ? literal(values.get(sid)) : initial);
    }
    const read = (sid) => {
      const source = this.signals[sid];
      if (source === undefined) fail(`unknown signal \`${sid}\``);
      return source.get();
    };
    for (const [key, expr] of exprDocs) {
      try {
        evalExpr(expr, read, undefined, values !== undefined);
      } catch (error) {
        fail(`${key}: ${error.message}`);
      }
    }
    this.exprs = Object.create(null);
    for (const [key, expr] of exprDocs) {
      const signals = this.signals;
      this.exprs[key] = ctx.computed((cx) =>
        evalExpr(
          expr,
          (sid) => {
            const source = signals[sid];
            if (source === undefined) fail(`unknown signal \`${sid}\``);
            return source.get(cx);
          },
          undefined,
          values !== undefined,
        ),
      );
    }
    const exprHandles = Object.values(this.exprs);
    const signalHandles = Object.values(this.signals);
    const watched = exprHandles.length > 0 ? exprHandles : signalHandles;
    this.host = ctx.effect((cx) => {
      for (const handle of watched) handle.get(cx);
    });
  }

  static install(doc, values) {
    return new View(createContext(), doc, values);
  }

  signalsJson() {
    return Object.fromEntries(
      Object.entries(this.signals).map(([id, source]) => [id, source.get()]),
    );
  }

  expressionsJson() {
    const out = {};
    for (const [id, computed] of Object.entries(this.exprs)) out[id] = computed.get();
    return out;
  }

  layoutJson() {
    const out = [];
    const walk = (id) => {
      const node = this.nodes[id];
      out.push({ id, role: node.role, children: node.children, flow: node.flow });
      for (const child of node.children) walk(child);
    };
    walk(this.root);
    return out;
  }

  chartJson() {
    return this.chart === null ? null : this.chart.activeLeaves();
  }

  dispatch(node, event, value = null) {
    if (!EVENTS.has(event)) fail(`unknown event \`${event}\``);
    if (!Object.hasOwn(this.nodes, node)) fail(`unknown node \`${node}\``);
    const effect = this.effects[node]?.[event];
    if (effect === undefined) return [];
    this.payload = literal(value);
    const trace = [];
    try {
      this.#exec(effect, trace);
    } finally {
      this.payload = undefined;
    }
    return trace;
  }

  #read(id) {
    const source = this.signals[id];
    if (source === undefined) fail(`unknown signal \`${id}\``);
    return source.get();
  }

  #eval(value) {
    return evalArg(value, (id) => this.#read(id), this.payload);
  }

  #exec(effect, trace) {
    if (!isObject(effect)) fail("effect must be an object");
    const { op, args } = effect;
    if (op === "set") {
      if (!Array.isArray(args) || args.length !== 2 || typeof args[0] !== "string") {
        fail("set takes a signal id and a value");
      }
      const source = this.signals[args[0]];
      if (source === undefined) fail(`unknown signal \`${args[0]}\``);
      const next = this.#eval(args[1]);
      source.set(next);
      trace.push({ op: "set", signal: args[0], value: next });
      return;
    }
    if (op === "send") {
      if (!this.chart) fail("send requires a chart");
      if (
        !Array.isArray(args) ||
        (args.length !== 1 && args.length !== 2) ||
        typeof args[0] !== "string"
      ) {
        fail("send takes an event name and an optional payload");
      }
      const record = { op: "send", event: args[0] };
      if (args.length === 2) record.payload = this.#eval(args[1]);
      this.chart.send(args[0], {});
      trace.push(record);
      return;
    }
    if (op === "batch") {
      if (!Array.isArray(args) || args.length === 0) fail("batch takes one or more effects");
      for (const nested of args) this.#exec(nested, trace);
      return;
    }
    fail(`unknown effect op \`${op}\``);
  }
}
