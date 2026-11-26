/**
 * Graph IR interpreter.
 *
 * Parses a lazily-spec graph document, lowers it onto sources, computeds, and
 * effects, applies edits, and emits canonical-source. Compute, not a Snapshot
 * or Delta. Behavior matches the lazily-rs `graph-ir` reference.
 */

const IR_VERSION = "1";
const I64_MIN = -9223372036854775808n;
const I64_MAX = 9223372036854775807n;
export const DRAIN_BUDGET = 100_000;
const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const UNARY = new Set(["neg", "not", "len"]);
const BINARY = new Set([
  "add",
  "sub",
  "mul",
  "div",
  "mod",
  "min",
  "max",
  "eq",
  "ne",
  "lt",
  "le",
  "gt",
  "ge",
  "concat",
  "get",
  "and",
  "or",
]);
const OPS = new Set([...UNARY, ...BINARY, "if", "array"]);

export class GraphIrError extends Error {
  constructor(message) {
    super(message);
    this.name = "GraphIrError";
  }
}

export const Policy = Object.freeze({
  KeepLatest: "keep-latest",
  Sum: "sum",
  Max: "max",
  Min: "min",
  And: "and",
  Or: "or",
});

export const EdgeKind = Object.freeze({
  Read: "read",
  Write: "write",
});

const POLICY_VALUES = new Set(Object.values(Policy));

export class Edge {
  constructor(from, kind, to) {
    this.from = from;
    this.kind = kind;
    this.to = to;
  }
}

export class EffectRun {
  constructor(id, result) {
    this.id = id;
    this.result = result;
  }
}

function jsonText(value) {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

function freeze(value) {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(freeze);
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) out[key] = freeze(value[key]);
    return out;
  }
  throw new GraphIrError(`value is not JSON: ${String(value)}`);
}

function jsonEq(left, right) {
  if (typeof left === "boolean" || typeof right === "boolean") {
    return typeof left === "boolean" && typeof right === "boolean" && left === right;
  }
  if (typeof left === "number" && typeof right === "number") return left === right;
  if (typeof left === "string" && typeof right === "string") return left === right;
  if (left === null || right === null) return left === null && right === null;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, i) => jsonEq(item, right[i]));
  }
  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key) && jsonEq(left[key], right[key]));
  }
  return false;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asObject(value, what) {
  if (!isObject(value)) throw new GraphIrError(`${what} must be an object`);
  return value;
}

function allow(obj, what, keys) {
  const allowed = new Set(keys);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new GraphIrError(`${what}: unknown field \`${key}\``);
  }
}

function requireField(obj, field, what) {
  if (!Object.hasOwn(obj, field)) throw new GraphIrError(`${what} requires \`${field}\``);
  return obj[field];
}

function requireStr(obj, field, what) {
  const value = requireField(obj, field, what);
  if (typeof value !== "string") {
    throw new GraphIrError(`${what} \`${field}\` must be a string, got ${jsonText(value)}`);
  }
  return value;
}

function parseId(text, what) {
  if (!ID_RE.test(text) || text.length > 128) {
    throw new GraphIrError(`${what} \`${text}\` is not a graph IR id`);
  }
  return text;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new GraphIrError(`graph document is not JSON: ${error.message}`);
  }
}

function requireVersion(obj, what) {
  const version = requireStr(obj, "ir", what);
  if (version !== IR_VERSION) throw new GraphIrError(`unsupported graph IR version \`${version}\``);
}

function optionalId(obj, field, what) {
  if (!Object.hasOwn(obj, field)) return null;
  const value = obj[field];
  if (typeof value !== "string") {
    throw new GraphIrError(`${what} must be a string, got ${jsonText(value)}`);
  }
  return parseId(value, what);
}

function edgeSets(node) {
  const reads = new Set();
  const writes = new Set();
  if (node.kind === "computed") collectExpr(node.expr, reads);
  else if (node.kind === "effect") collectStmt(node.body, reads, writes);
  return [reads, writes];
}

function collectExpr(expr, reads) {
  if (expr.type === "ref") reads.add(expr.id);
  else if (expr.type === "call") for (const arg of expr.args) collectExpr(arg, reads);
  else if (expr.type === "object") for (const item of expr.fields) collectExpr(item.value, reads);
}

function collectStmt(stmt, reads, writes) {
  if (stmt.type === "eval") collectExpr(stmt.expr, reads);
  else if (stmt.type === "set" || stmt.type === "merge") {
    writes.add(stmt.target);
    collectExpr(stmt.expr, reads);
  } else if (stmt.type === "seq") for (const step of stmt.steps) collectStmt(step, reads, writes);
  else if (stmt.type === "when") {
    collectExpr(stmt.cond, reads);
    collectStmt(stmt.then, reads, writes);
    if (stmt.else) collectStmt(stmt.else, reads, writes);
  }
}

function emitExpr(expr) {
  if (expr.type === "lit") return `lit(${jsonText(expr.value)})`;
  if (expr.type === "ref") return `ref(${expr.id})`;
  if (expr.type === "call") return `${expr.op}(${expr.args.map(emitExpr).join(", ")})`;
  const rendered = expr.fields
    .map((item) => `${jsonText(item.key)}: ${emitExpr(item.value)}`)
    .join(", ");
  return `object(${rendered})`;
}

function emitStmt(stmt) {
  if (stmt.type === "eval") return `eval(${emitExpr(stmt.expr)})`;
  if (stmt.type === "set") return `set(${stmt.target}, ${emitExpr(stmt.expr)})`;
  if (stmt.type === "merge") return `merge(${stmt.target}, ${emitExpr(stmt.expr)})`;
  if (stmt.type === "seq") return `seq(${stmt.steps.map(emitStmt).join(", ")})`;
  if (!stmt.else) return `when(${emitExpr(stmt.cond)}, ${emitStmt(stmt.then)})`;
  return `when(${emitExpr(stmt.cond)}, ${emitStmt(stmt.then)}, ${emitStmt(stmt.else)})`;
}

function emitNode(node) {
  if (node.kind === "source") {
    let line = `source ${node.id} = ${jsonText(node.init)}`;
    if (node.policy !== Policy.KeepLatest) line += ` policy ${node.policy}`;
    return line;
  }
  if (node.kind === "computed") {
    const head = node.eager ? `computed ${node.id} eager` : `computed ${node.id}`;
    return `${head} = ${emitExpr(node.expr)}`;
  }
  return `effect ${node.id} = ${emitStmt(node.body)}`;
}

function exprJson(expr) {
  if (expr.type === "lit") return { lit: freeze(expr.value) };
  if (expr.type === "ref") return { ref: expr.id };
  if (expr.type === "call") return { op: expr.op, args: expr.args.map(exprJson) };
  return { object: expr.fields.map((item) => ({ key: item.key, value: exprJson(item.value) })) };
}

function stmtJson(stmt) {
  if (stmt.type === "eval") return { do: "eval", expr: exprJson(stmt.expr) };
  if (stmt.type === "set") return { do: "set", target: stmt.target, expr: exprJson(stmt.expr) };
  if (stmt.type === "merge") return { do: "merge", target: stmt.target, expr: exprJson(stmt.expr) };
  if (stmt.type === "seq") return { do: "seq", steps: stmt.steps.map(stmtJson) };
  const obj = { do: "when", cond: exprJson(stmt.cond), then: stmtJson(stmt.then) };
  if (stmt.else) obj.else = stmtJson(stmt.else);
  return obj;
}

function nodeJson(node) {
  if (node.kind === "source") {
    const obj = { id: node.id, kind: "source", init: freeze(node.init) };
    if (node.policy !== Policy.KeepLatest) obj.policy = node.policy;
    return obj;
  }
  if (node.kind === "computed") {
    const obj = { id: node.id, kind: "computed" };
    if (node.eager) obj.eager = true;
    obj.expr = exprJson(node.expr);
    return obj;
  }
  return { id: node.id, kind: "effect", body: stmtJson(node.body) };
}

function parsePolicy(obj, nodeId) {
  if (!Object.hasOwn(obj, "policy")) return Policy.KeepLatest;
  const value = obj.policy;
  if (typeof value !== "string") {
    throw new GraphIrError(`source \`${nodeId}\` policy must be a string, got ${jsonText(value)}`);
  }
  if (!POLICY_VALUES.has(value)) throw new GraphIrError(`unknown source policy \`${value}\``);
  return value;
}

function parseEager(obj, nodeId) {
  if (!Object.hasOwn(obj, "eager")) return false;
  if (typeof obj.eager === "boolean") return obj.eager;
  throw new GraphIrError(
    `computed \`${nodeId}\` eager must be a boolean, got ${jsonText(obj.eager)}`,
  );
}

function checkArity(op, length) {
  const ok = UNARY.has(op)
    ? length === 1
    : op === "if"
      ? length === 3
      : op === "array"
        ? true
        : length === 2;
  if (!ok) throw new GraphIrError(`op \`${op}\` has the wrong number of arguments`);
}

function parseExpr(value) {
  const obj = asObject(value, "expression");
  allow(obj, "expression", ["lit", "ref", "op", "args", "object"]);
  const forms = ["lit", "ref", "op", "object"].filter((key) => Object.hasOwn(obj, key));
  if (forms.length !== 1) {
    throw new GraphIrError("expression must be exactly one of lit, ref, op, or object");
  }
  if (Object.hasOwn(obj, "args") && !Object.hasOwn(obj, "op")) {
    throw new GraphIrError("args is only valid on an op expression");
  }
  if (Object.hasOwn(obj, "lit")) return { type: "lit", value: freeze(obj.lit) };
  if (Object.hasOwn(obj, "ref"))
    return { type: "ref", id: parseId(requireStr(obj, "ref", "expression"), "ref") };
  if (Object.hasOwn(obj, "object")) return parseObjectExpr(obj.object);
  const op = requireStr(obj, "op", "expression");
  if (!OPS.has(op)) throw new GraphIrError(`unknown op \`${op}\``);
  const rawArgs = requireField(obj, "args", "op expression");
  if (!Array.isArray(rawArgs)) throw new GraphIrError("op args must be an array");
  checkArity(op, rawArgs.length);
  return { type: "call", op, args: rawArgs.map(parseExpr) };
}

function parseObjectExpr(value) {
  if (!Array.isArray(value)) throw new GraphIrError("object expression must be an array");
  const fields = [];
  const seen = new Set();
  for (const field of value) {
    const obj = asObject(field, "object field");
    allow(obj, "object field", ["key", "value"]);
    const key = requireStr(obj, "key", "object field");
    if (seen.has(key)) throw new GraphIrError(`duplicate object key \`${key}\``);
    seen.add(key);
    fields.push({ key, value: parseExpr(requireField(obj, "value", "object field")) });
  }
  return { type: "object", fields };
}

function parseStmt(value) {
  const obj = asObject(value, "statement");
  const verb = requireStr(obj, "do", "statement");
  if (verb === "eval") {
    allow(obj, "eval", ["do", "expr"]);
    return { type: "eval", expr: parseExpr(requireField(obj, "expr", "eval")) };
  }
  if (verb === "set" || verb === "merge") {
    allow(obj, verb, ["do", "target", "expr"]);
    return {
      type: verb,
      target: parseId(requireStr(obj, "target", verb), "write target"),
      expr: parseExpr(requireField(obj, "expr", verb)),
    };
  }
  if (verb === "seq") {
    allow(obj, "seq", ["do", "steps"]);
    const raw = requireField(obj, "steps", "seq");
    if (!Array.isArray(raw)) throw new GraphIrError("seq steps must be an array");
    if (raw.length === 0) throw new GraphIrError("seq steps must not be empty");
    return { type: "seq", steps: raw.map(parseStmt) };
  }
  if (verb === "when") {
    allow(obj, "when", ["do", "cond", "then", "else"]);
    return {
      type: "when",
      cond: parseExpr(requireField(obj, "cond", "when")),
      then: parseStmt(requireField(obj, "then", "when")),
      else: Object.hasOwn(obj, "else") ? parseStmt(obj.else) : null,
    };
  }
  throw new GraphIrError(`unknown statement \`${verb}\``);
}

function parseNode(value) {
  const obj = asObject(value, "node");
  const kind = requireStr(obj, "kind", "node");
  if (kind === "source") {
    allow(obj, "source", ["id", "kind", "init", "policy"]);
    const id = parseId(requireStr(obj, "id", "source"), "source id");
    if (!Object.hasOwn(obj, "init")) throw new GraphIrError("source requires `init`");
    return { kind, id, init: freeze(obj.init), policy: parsePolicy(obj, id) };
  }
  if (kind === "computed") {
    allow(obj, "computed", ["id", "kind", "expr", "eager"]);
    const id = parseId(requireStr(obj, "id", "computed"), "computed id");
    return {
      kind,
      id,
      eager: parseEager(obj, id),
      expr: parseExpr(requireField(obj, "expr", "computed")),
    };
  }
  if (kind === "effect") {
    allow(obj, "effect", ["id", "kind", "body"]);
    const id = parseId(requireStr(obj, "id", "effect"), "effect id");
    return { kind, id, body: parseStmt(requireField(obj, "body", "effect")) };
  }
  throw new GraphIrError(`unknown node kind \`${kind}\``);
}

function parseEditOp(value) {
  const obj = asObject(value, "edit op");
  const op = requireStr(obj, "op", "edit op");
  if (op === "add" || op === "replace") {
    allow(obj, op, ["op", "node"]);
    const node = parseNode(requireField(obj, "node", op));
    return { op, node };
  }
  if (op === "remove") {
    allow(obj, "remove", ["op", "id"]);
    return { op, id: parseId(requireStr(obj, "id", "remove"), "remove id") };
  }
  throw new GraphIrError(`unknown edit op \`${op}\``);
}

function expectBool(value) {
  if (typeof value !== "boolean")
    throw new GraphIrError(`expected a boolean, got ${jsonText(value)}`);
  return value;
}

function expectStr(value) {
  if (typeof value !== "string")
    throw new GraphIrError(`expected a string, got ${jsonText(value)}`);
  return value;
}

function asNum(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GraphIrError(`expected a number, got ${jsonText(value)}`);
  }
  if (Number.isSafeInteger(value)) return { kind: "int", value: BigInt(value) };
  return { kind: "float", value };
}

function checkPolicyInit(policy, init) {
  if (policy === Policy.Sum || policy === Policy.Max || policy === Policy.Min) asNum(init);
  else if (policy === Policy.And || policy === Policy.Or) expectBool(init);
}

function canonicalF64(number) {
  if (!Number.isFinite(number)) throw new GraphIrError("non-finite number");
  if (
    Number.isInteger(number) &&
    number >= Number.MIN_SAFE_INTEGER &&
    number <= Number.MAX_SAFE_INTEGER
  ) {
    return number;
  }
  return number;
}

function checked(value) {
  if (value < I64_MIN || value > I64_MAX) throw new GraphIrError("integer overflow");
  return Number(value);
}

function ordering(left, right) {
  const a = asNum(left);
  const b = asNum(right);
  if (a.kind === "int" && b.kind === "int") {
    if (a.value < b.value) return -1;
    if (a.value > b.value) return 1;
    return 0;
  }
  const lf = Number(a.value);
  const rf = Number(b.value);
  if (Number.isNaN(lf) || Number.isNaN(rf)) throw new GraphIrError("non-finite number");
  if (lf < rf) return -1;
  if (lf > rf) return 1;
  return 0;
}

function numBin(op, left, right) {
  const a = asNum(left);
  const b = asNum(right);
  if (op !== "div" && a.kind === "int" && b.kind === "int") {
    if (op === "add") return checked(a.value + b.value);
    if (op === "sub") return checked(a.value - b.value);
    if (op === "mul") return checked(a.value * b.value);
    throw new GraphIrError(`op \`${op}\` is not an integer operator`);
  }
  const lf = Number(a.value);
  const rf = Number(b.value);
  if (op === "div" && rf === 0) throw new GraphIrError("division by zero");
  let value;
  if (op === "add") value = lf + rf;
  else if (op === "sub") value = lf - rf;
  else if (op === "mul") value = lf * rf;
  else if (op === "div") value = lf / rf;
  else throw new GraphIrError(`op \`${op}\` is not a numeric operator`);
  return canonicalF64(value);
}

function lenValue(value) {
  let length;
  if (typeof value === "string") length = [...value].length;
  else if (Array.isArray(value) || isObject(value)) length = Object.keys(value).length;
  else throw new GraphIrError(`len requires a string, array, or object, got ${jsonText(value)}`);
  return length;
}

function evalGet(target, key) {
  if (Array.isArray(target)) {
    const num = asNum(key);
    if (num.kind !== "int") throw new GraphIrError("array index must be an integer");
    const index = Number(num.value);
    if (index < 0) throw new GraphIrError("array index must be >= 0");
    if (index >= target.length) throw new GraphIrError(`index ${index} out of range`);
    return freeze(target[index]);
  }
  if (isObject(target)) {
    const name = expectStr(key);
    if (!Object.hasOwn(target, name)) throw new GraphIrError(`missing key \`${name}\``);
    return freeze(target[name]);
  }
  throw new GraphIrError(`get requires an array or object, got ${jsonText(target)}`);
}

function evalValues(op, values) {
  const one = (name) => {
    if (values.length !== 1)
      throw new GraphIrError(`op \`${name}\` has the wrong number of arguments`);
    return values[0];
  };
  const pair = (name) => {
    if (values.length !== 2)
      throw new GraphIrError(`op \`${name}\` has the wrong number of arguments`);
    return values;
  };
  if (op === "neg") {
    const num = asNum(one("neg"));
    if (num.kind === "int") {
      if (num.value === I64_MIN) throw new GraphIrError("integer overflow");
      return checked(-num.value);
    }
    return canonicalF64(-Number(num.value));
  }
  if (op === "not") return !expectBool(one("not"));
  if (op === "len") return lenValue(one("len"));
  if (op === "add" || op === "sub" || op === "mul" || op === "div") {
    const [left, right] = pair(op);
    return numBin(op, left, right);
  }
  if (op === "mod") {
    const [left, right] = pair("mod");
    const a = asNum(left);
    const b = asNum(right);
    if (a.kind !== "int" || b.kind !== "int") throw new GraphIrError("mod requires integers");
    if (b.value === 0n) throw new GraphIrError("division by zero");
    return checked(a.value % b.value);
  }
  if (op === "min" || op === "max") {
    const [left, right] = pair(op);
    const order = ordering(left, right);
    if (op === "max") return order >= 0 ? left : right;
    return order <= 0 ? left : right;
  }
  if (op === "eq") {
    const [left, right] = pair("eq");
    return jsonEq(left, right);
  }
  if (op === "ne") {
    const [left, right] = pair("ne");
    return !jsonEq(left, right);
  }
  if (op === "lt" || op === "le" || op === "gt" || op === "ge") {
    const [left, right] = pair(op);
    const order = ordering(left, right);
    if (op === "lt") return order < 0;
    if (op === "le") return order <= 0;
    if (op === "gt") return order > 0;
    return order >= 0;
  }
  if (op === "concat") {
    const [left, right] = pair("concat");
    return expectStr(left) + expectStr(right);
  }
  if (op === "get") {
    const [target, key] = pair("get");
    return evalGet(target, key);
  }
  throw new GraphIrError(`op \`${op}\` is not an eager operator`);
}

function fold(policy, old, op) {
  if (policy === Policy.KeepLatest) return freeze(op);
  if (policy === Policy.Sum) return numBin("add", old, op);
  if (policy === Policy.Max) return freeze(ordering(old, op) >= 0 ? old : op);
  if (policy === Policy.Min) return freeze(ordering(old, op) <= 0 ? old : op);
  if (policy === Policy.And) return expectBool(old) && expectBool(op);
  if (policy === Policy.Or) return expectBool(old) || expectBool(op);
  throw new GraphIrError(`unknown source policy \`${policy}\``);
}

export class GraphIr {
  constructor(id, nodes) {
    this._id = id;
    this._nodes = nodes;
    this._index = new Map();
    this.#reindex();
  }

  static fromJsonStr(text) {
    return GraphIr.fromJson(parseJson(text));
  }

  static fromJson(value) {
    const obj = asObject(value, "graph document");
    allow(obj, "graph document", ["kind", "ir", "id", "nodes"]);
    const kind = requireStr(obj, "kind", "graph document");
    if (kind !== "graph")
      throw new GraphIrError(`graph document kind must be "graph", got \`${kind}\``);
    requireVersion(obj, "graph document");
    const id = optionalId(obj, "id", "graph id");
    const rawNodes = requireField(obj, "nodes", "graph document");
    if (!Array.isArray(rawNodes)) throw new GraphIrError("graph nodes must be an array");
    const nodes = [];
    const seen = new Set();
    for (const raw of rawNodes) {
      const node = parseNode(raw);
      if (seen.has(node.id)) throw new GraphIrError(`duplicate node id \`${node.id}\``);
      seen.add(node.id);
      nodes.push(node);
    }
    const document = new GraphIr(id, nodes);
    document.check();
    return document;
  }

  toJson() {
    const obj = { kind: "graph", ir: IR_VERSION };
    if (this._id !== null) obj.id = this._id;
    obj.nodes = this._nodes.map(nodeJson);
    return obj;
  }

  id() {
    return this._id;
  }

  nodes() {
    return this._nodes.slice();
  }

  node(id) {
    const slot = this._index.get(id);
    return slot === undefined ? null : this._nodes[slot];
  }

  staticEdges() {
    const edges = [];
    for (const node of this._nodes) {
      const [reads, writes] = edgeSets(node);
      for (const to of reads) edges.push(new Edge(node.id, EdgeKind.Read, to));
      for (const to of writes) edges.push(new Edge(node.id, EdgeKind.Write, to));
    }
    edges.sort((a, b) =>
      a.from === b.from
        ? a.kind === b.kind
          ? a.to < b.to
            ? -1
            : a.to > b.to
              ? 1
              : 0
          : a.kind < b.kind
            ? -1
            : 1
        : a.from < b.from
          ? -1
          : 1,
    );
    return edges;
  }

  emitSource() {
    let out =
      this._id === null ? `graph ir ${IR_VERSION}\n` : `graph ${this._id} ir ${IR_VERSION}\n`;
    for (const node of this._nodes) out += `${emitNode(node)}\n`;
    return out;
  }

  check() {
    this.#checkRefs();
    this.#checkInits();
    this.#checkCycles();
  }

  clone() {
    return new GraphIr(this._id, this._nodes.slice());
  }

  applyEditOp(op) {
    if (op.op === "add") {
      if (this._index.has(op.node.id)) {
        throw new GraphIrError(`add requires a new id, \`${op.node.id}\` already exists`);
      }
      this._nodes.push(op.node);
    } else if (op.op === "replace") {
      const slot = this._index.get(op.node.id);
      if (slot === undefined)
        throw new GraphIrError(`replace requires an existing node \`${op.node.id}\``);
      this._nodes[slot] = op.node;
    } else {
      const slot = this._index.get(op.id);
      if (slot === undefined)
        throw new GraphIrError(`remove requires an existing node \`${op.id}\``);
      this._nodes.splice(slot, 1);
    }
    this.#reindex();
    this.check();
  }

  #reindex() {
    this._index = new Map();
    this._nodes.forEach((node, slot) => {
      if (this._index.has(node.id)) throw new GraphIrError(`duplicate node id \`${node.id}\``);
      this._index.set(node.id, slot);
    });
  }

  #checkRefs() {
    for (const node of this._nodes) {
      const [reads, writes] = edgeSets(node);
      for (const to of reads) {
        const target = this.node(to);
        if (target && target.kind === "effect") {
          throw new GraphIrError(`node \`${node.id}\` reads effect \`${to}\`, which has no value`);
        }
        if (!target) throw new GraphIrError(`node \`${node.id}\` reads unknown node \`${to}\``);
      }
      for (const to of writes) {
        const target = this.node(to);
        if (!target) throw new GraphIrError(`node \`${node.id}\` writes unknown node \`${to}\``);
        if (target.kind !== "source")
          throw new GraphIrError(`node \`${node.id}\` writes non-source \`${to}\``);
      }
    }
  }

  #checkInits() {
    for (const node of this._nodes) {
      if (node.kind !== "source") continue;
      try {
        checkPolicyInit(node.policy, node.init);
      } catch (error) {
        if (error instanceof GraphIrError)
          throw new GraphIrError(`source \`${node.id}\`: ${error.message}`);
        throw error;
      }
    }
  }

  #checkCycles() {
    const color = new Map();
    const stack = [];
    const visit = (nodeId) => {
      const state = color.get(nodeId) ?? 0;
      if (state === 1) {
        const start = stack.indexOf(nodeId);
        const cycle = [...stack.slice(start < 0 ? 0 : start), nodeId];
        throw new GraphIrError(`cycle in read edges: ${cycle.join(" -> ")}`);
      }
      if (state === 2) return;
      color.set(nodeId, 1);
      stack.push(nodeId);
      const target = this.node(nodeId);
      if (target) {
        const [reads] = edgeSets(target);
        for (const dep of [...reads].sort()) if (this.node(dep)) visit(dep);
      }
      stack.pop();
      color.set(nodeId, 2);
    };
    for (const node of this._nodes) visit(node.id);
  }
}

export class GraphEdit {
  constructor(ops) {
    this._ops = ops;
  }

  static fromJsonStr(text) {
    return GraphEdit.fromJson(parseJson(text));
  }

  static fromJson(value) {
    const obj = asObject(value, "graph edit");
    allow(obj, "graph edit", ["kind", "ir", "ops"]);
    const kind = requireStr(obj, "kind", "graph edit");
    if (kind !== "edit") throw new GraphIrError(`graph edit kind must be "edit", got \`${kind}\``);
    requireVersion(obj, "graph edit");
    const raw = requireField(obj, "ops", "graph edit");
    if (!Array.isArray(raw)) throw new GraphIrError("graph edit ops must be an array");
    if (raw.length === 0) throw new GraphIrError("graph edit ops must not be empty");
    return new GraphEdit(raw.map(parseEditOp));
  }

  ops() {
    return this._ops.slice();
  }
}

export class GraphRuntime {
  constructor(doc) {
    this._doc = doc;
    this._sources = new Map();
    this._computeds = new Map();
    this._effects = new Map();
    this._deps = new Map();
    this._subs = new Map();
    this._observed = new Map();
    this._trace = [];
    this._frames = [];
    this._stack = [];
    this._current = null;
    this._computing = new Set();
    this._scheduled = [];
    this._scheduledSet = new Set();
    this._draining = false;
    this._fault = null;
    this.drainBudget = DRAIN_BUDGET;
    this.lastDrainExhaustion = null;
  }

  static loadJson(text) {
    return GraphRuntime.lower(GraphIr.fromJsonStr(text));
  }

  static lower(doc, drainBudget = DRAIN_BUDGET) {
    doc.check();
    const runtime = new GraphRuntime(doc.clone());
    runtime.drainBudget = drainBudget;
    runtime.#installDocument();
    return runtime;
  }

  document() {
    return this._doc;
  }

  contains(id) {
    return this._doc.node(id) !== null;
  }

  isEager(id) {
    const node = this._doc.node(id);
    if (node && node.kind === "computed") return node.eager;
    if (!node) throw new GraphIrError(`unknown node \`${id}\``);
    throw new GraphIrError(`\`${id}\` is not a computed`);
  }

  sourcePolicy(id) {
    const node = this._doc.node(id);
    if (node && node.kind === "source") return node.policy;
    if (!node) throw new GraphIrError(`unknown node \`${id}\``);
    throw new GraphIrError(`\`${id}\` is not a source`);
  }

  staticEdges() {
    return this._doc.staticEdges();
  }

  emitSource() {
    return this._doc.emitSource();
  }

  observedReads(id) {
    return new Set(this._observed.get(id) ?? []);
  }

  effectTrace() {
    return this._trace.slice();
  }

  get(id) {
    if (this._effects.has(id) && !this._sources.has(id) && !this._computeds.has(id)) {
      throw new GraphIrError(`\`${id}\` is an effect and has no value`);
    }
    if (this._sources.has(id)) return freeze(this._sources.get(id).value);
    if (this._computeds.has(id)) {
      const state = this._computeds.get(id);
      if (state.dirty || !state.hasValue) this.#recompute(id);
      return freeze(this._computeds.get(id).cache);
    }
    throw new GraphIrError(`unknown node \`${id}\``);
  }

  writeSource(id, value) {
    this.#setSource(id, freeze(value));
    this.#drain();
    this.#raiseFault();
  }

  apply(edit) {
    edit.ops().forEach((op, index) => {
      const next = this._doc.clone();
      try {
        next.applyEditOp(op);
      } catch (error) {
        if (error instanceof GraphIrError)
          throw new GraphIrError(`edit op ${index}: ${error.message}`);
        throw error;
      }
      try {
        this.#installOp(op);
      } catch (error) {
        if (error instanceof GraphIrError)
          throw new GraphIrError(`edit op ${index}: ${error.message}`);
        throw error;
      }
      this._doc = next;
    });
  }

  #installDocument() {
    for (const node of this._doc.nodes()) if (node.kind === "source") this.#insertSource(node);
    for (const node of this._doc.nodes()) if (node.kind === "computed") this.#insertComputed(node);
    for (const node of this._doc.nodes())
      if (node.kind === "computed" && node.eager) this.#recompute(node.id);
    for (const node of this._doc.nodes()) if (node.kind === "effect") this.#insertEffect(node);
  }

  #installOp(op) {
    if (op.op === "add") this.#addNode(op.node);
    else if (op.op === "replace") this.#replaceNode(op.node);
    else this.#removeNode(op.id);
    this.#drain();
    this.#raiseFault();
  }

  #addNode(node) {
    if (node.kind === "source") this.#insertSource(node);
    else if (node.kind === "computed") {
      this.#insertComputed(node);
      if (node.eager) {
        try {
          this.#recompute(node.id);
        } catch (error) {
          this.#dropBinding(node.id);
          throw error;
        }
      }
    } else this.#insertEffect(node);
  }

  #replaceNode(node) {
    const snap = this.#snapshot(node.id);
    this.#dropBinding(node.id);
    try {
      this.#addNode(node);
    } catch (error) {
      this.#dropBinding(node.id);
      this.#restore(node.id, snap);
      throw error;
    }
    this.#notify(node.id);
  }

  #removeNode(id) {
    if (!this._sources.has(id) && !this._computeds.has(id) && !this._effects.has(id)) {
      throw new GraphIrError(`unknown node \`${id}\``);
    }
    this.#dropBinding(id);
    this._subs.delete(id);
  }

  #insertSource(node) {
    checkPolicyInit(node.policy, node.init);
    this._sources.set(node.id, { value: freeze(node.init), policy: node.policy });
  }

  #insertComputed(node) {
    this._computeds.set(node.id, {
      expr: node.expr,
      eager: node.eager,
      cache: null,
      hasValue: false,
      dirty: true,
    });
    this._deps.set(node.id, new Set());
  }

  #insertEffect(node) {
    this._effects.set(node.id, { body: node.body });
    this._deps.set(node.id, new Set());
    try {
      this.#runEffect(node.id);
    } catch (error) {
      this.#dropBinding(node.id);
      throw error;
    }
  }

  #snapshot(id) {
    if (this._sources.has(id)) {
      const state = this._sources.get(id);
      return { kind: "source", source: { value: freeze(state.value), policy: state.policy } };
    }
    if (this._computeds.has(id)) {
      const state = this._computeds.get(id);
      return {
        kind: "computed",
        computed: {
          expr: state.expr,
          eager: state.eager,
          cache: state.hasValue ? freeze(state.cache) : null,
          hasValue: state.hasValue,
          dirty: state.dirty,
        },
        deps: new Set(this._deps.get(id) ?? []),
      };
    }
    if (this._effects.has(id)) {
      return {
        kind: "effect",
        effect: { body: this._effects.get(id).body },
        deps: new Set(this._deps.get(id) ?? []),
      };
    }
    return null;
  }

  #restore(id, snap) {
    if (!snap) return;
    if (snap.kind === "source") this._sources.set(id, snap.source);
    else if (snap.kind === "computed") {
      this._computeds.set(id, snap.computed);
      this._deps.set(id, new Set());
      for (const dep of snap.deps) {
        if (!this._subs.has(dep)) this._subs.set(dep, new Set());
        this._subs.get(dep).add(id);
        this._deps.get(id).add(dep);
      }
    } else if (snap.kind === "effect") {
      this._effects.set(id, snap.effect);
      this._deps.set(id, new Set());
      for (const dep of snap.deps) {
        if (!this._subs.has(dep)) this._subs.set(dep, new Set());
        this._subs.get(dep).add(id);
        this._deps.get(id).add(dep);
      }
    }
  }

  #dropBinding(id) {
    this._sources.delete(id);
    this._computeds.delete(id);
    this._effects.delete(id);
    for (const dep of this._deps.get(id) ?? []) this._subs.get(dep)?.delete(id);
    this._deps.delete(id);
    this._observed.delete(id);
    this._scheduledSet.delete(id);
  }

  #setSource(id, value) {
    const state = this._sources.get(id);
    if (!state) {
      if (this._computeds.has(id) || this._effects.has(id))
        throw new GraphIrError(`\`${id}\` is not a source`);
      throw new GraphIrError(`unknown node \`${id}\``);
    }
    const changed = !jsonEq(state.value, value);
    state.value = freeze(value);
    if (changed) this.#notify(id);
    return freeze(state.value);
  }

  #mergeSource(id, value) {
    const state = this._sources.get(id);
    if (!state) {
      if (this._computeds.has(id) || this._effects.has(id))
        throw new GraphIrError(`\`${id}\` is not a source`);
      throw new GraphIrError(`unknown node \`${id}\``);
    }
    return this.#setSource(id, fold(state.policy, state.value, value));
  }

  #notify(id) {
    for (const dep of [...(this._subs.get(id) ?? [])]) {
      if (this._computeds.has(dep)) {
        const state = this._computeds.get(dep);
        if (state.eager || (this._subs.get(dep)?.size ?? 0) > 0) {
          if (this._computing.has(dep)) state.dirty = true;
          else this.#recompute(dep);
        } else state.dirty = true;
      } else if (this._effects.has(dep)) this.#schedule(dep);
    }
  }

  #schedule(id) {
    if (this._effects.has(id) && !this._scheduledSet.has(id)) {
      this._scheduledSet.add(id);
      this._scheduled.push(id);
    }
  }

  #drain() {
    if (this._draining) return;
    this._draining = true;
    let iterations = 0;
    try {
      while (this._scheduled.length > 0) {
        iterations += 1;
        if (iterations >= this.drainBudget) {
          this.lastDrainExhaustion = iterations;
          return;
        }
        const id = this._scheduled.shift();
        this._scheduledSet.delete(id);
        if (!this._effects.has(id)) continue;
        try {
          this.#runEffect(id);
        } catch (error) {
          if (error instanceof GraphIrError) {
            this._fault = error.message;
            return;
          }
          throw error;
        }
      }
    } finally {
      this._draining = false;
    }
  }

  #raiseFault() {
    if (this._fault !== null) {
      const message = this._fault;
      this._fault = null;
      throw new GraphIrError(message);
    }
  }

  #runEffect(id) {
    const state = this._effects.get(id);
    this.#begin(id);
    let result;
    try {
      result = this.#evalStmt(state.body);
    } catch (error) {
      this.#end(id);
      throw error;
    }
    this.#end(id);
    this._trace.push(new EffectRun(id, freeze(result)));
    this.#drain();
  }

  #recompute(id) {
    const state = this._computeds.get(id);
    if (this._computing.has(id)) throw new GraphIrError(`cycle in read edges: ${id}`);
    this._computing.add(id);
    this.#begin(id);
    let value;
    try {
      value = this.#evalExpr(state.expr);
    } catch (error) {
      this.#end(id);
      this._computing.delete(id);
      state.dirty = true;
      state.hasValue = false;
      state.cache = null;
      throw error;
    }
    this.#end(id);
    this._computing.delete(id);
    const changed = !state.hasValue || !jsonEq(state.cache, value);
    state.cache = freeze(value);
    state.hasValue = true;
    state.dirty = false;
    if (changed) this.#notify(id);
    return state.cache;
  }

  #begin(id) {
    for (const dep of this._deps.get(id) ?? []) this._subs.get(dep)?.delete(id);
    this._deps.set(id, new Set());
    this._frames.push(new Set());
    this._stack.push(this._current);
    this._current = id;
  }

  #end(id) {
    const frame = this._frames.pop();
    this._observed.set(id, new Set(frame));
    this._current = this._stack.pop();
  }

  #note(id) {
    if (this._frames.length === 0 || this._current === null) {
      throw new GraphIrError("read outside a node evaluation");
    }
    this._frames.at(-1).add(id);
    if (!this._subs.has(id)) this._subs.set(id, new Set());
    this._subs.get(id).add(this._current);
    this._deps.get(this._current).add(id);
  }

  #readRef(id) {
    this.#note(id);
    if (this._sources.has(id)) return freeze(this._sources.get(id).value);
    if (this._computeds.has(id)) {
      const state = this._computeds.get(id);
      if (state.dirty || !state.hasValue) return freeze(this.#recompute(id));
      return freeze(state.cache);
    }
    if (this._effects.has(id)) throw new GraphIrError(`\`${id}\` is an effect and has no value`);
    throw new GraphIrError(`unknown node \`${id}\``);
  }

  #evalExpr(expr) {
    if (expr.type === "lit") return freeze(expr.value);
    if (expr.type === "ref") return this.#readRef(expr.id);
    if (expr.type === "object") {
      const obj = {};
      for (const item of expr.fields) {
        if (Object.hasOwn(obj, item.key))
          throw new GraphIrError(`duplicate object key \`${item.key}\``);
        obj[item.key] = this.#evalExpr(item.value);
      }
      return obj;
    }
    if (expr.op === "and") return this.#evalAnd(expr.args);
    if (expr.op === "or") return this.#evalOr(expr.args);
    if (expr.op === "if") return this.#evalIf(expr.args);
    if (expr.op === "array") return expr.args.map((arg) => this.#evalExpr(arg));
    return evalValues(
      expr.op,
      expr.args.map((arg) => this.#evalExpr(arg)),
    );
  }

  #evalAnd(args) {
    if (args.length !== 2) throw new GraphIrError("op `and` has the wrong number of arguments");
    if (!expectBool(this.#evalExpr(args[0]))) return false;
    return expectBool(this.#evalExpr(args[1]));
  }

  #evalOr(args) {
    if (args.length !== 2) throw new GraphIrError("op `or` has the wrong number of arguments");
    if (expectBool(this.#evalExpr(args[0]))) return true;
    return expectBool(this.#evalExpr(args[1]));
  }

  #evalIf(args) {
    if (args.length !== 3) throw new GraphIrError("op `if` has the wrong number of arguments");
    if (expectBool(this.#evalExpr(args[0]))) return this.#evalExpr(args[1]);
    return this.#evalExpr(args[2]);
  }

  #evalStmt(stmt) {
    if (stmt.type === "eval") return this.#evalExpr(stmt.expr);
    if (stmt.type === "set") return this.#setSource(stmt.target, this.#evalExpr(stmt.expr));
    if (stmt.type === "merge") return this.#mergeSource(stmt.target, this.#evalExpr(stmt.expr));
    if (stmt.type === "seq") return stmt.steps.map((step) => this.#evalStmt(step));
    const cond = expectBool(this.#evalExpr(stmt.cond));
    if (cond) return this.#evalStmt(stmt.then);
    if (stmt.else) return this.#evalStmt(stmt.else);
    return null;
  }
}
