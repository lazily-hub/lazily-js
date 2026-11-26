import assert from "node:assert/strict";
import test from "node:test";

import {
  EdgeKind,
  GraphEdit,
  GraphIr,
  GraphIrError,
  GraphRuntime,
  Policy,
} from "../src/graph-ir.js";

const COUNTER = `{
  "kind": "graph", "ir": "1", "id": "counter",
  "nodes": [
    {"id": "count", "kind": "source", "init": 1},
    {"id": "doubled", "kind": "computed", "eager": true,
      "expr": {"op": "mul", "args": [{"ref": "count"}, {"lit": 2}]}},
    {"id": "log", "kind": "effect", "body": {"do": "eval", "expr": {"ref": "doubled"}}}
  ]
}`;

const COUNTER_EDIT = `{
  "kind": "edit", "ir": "1",
  "ops": [
    {"op": "replace", "node": {"id": "doubled", "kind": "computed",
      "expr": {"op": "add", "args": [{"ref": "count"}, {"lit": 10}]}}},
    {"op": "add", "node": {"id": "label", "kind": "source", "init": "n"}},
    {"op": "add", "node": {"id": "shown", "kind": "computed",
      "expr": {"op": "concat", "args": [{"ref": "label"}, {"lit": ":"}]}}},
    {"op": "remove", "id": "log"}
  ]
}`;

const COUNTER_SOURCE =
  "graph counter ir 1\n" +
  "source count = 1\n" +
  "computed doubled eager = mul(ref(count), lit(2))\n" +
  "effect log = eval(ref(doubled))\n";

function read(from, to) {
  return { from, kind: EdgeKind.Read, to };
}

function edgesOf(list) {
  return list.map((edge) => read(edge.from, edge.to));
}

test("counter lowers then an edit replaces the graph", () => {
  const doc = GraphIr.fromJsonStr(COUNTER);
  assert.equal(doc.id(), "counter");
  const doubled = doc.node("doubled");
  assert.equal(doubled.eager, true);
  assert.equal(doubled.expr.op, "mul");
  assert.deepEqual(edgesOf(doc.staticEdges()), [read("doubled", "count"), read("log", "doubled")]);
  assert.equal(doc.emitSource(), COUNTER_SOURCE);
  assert.equal(GraphIr.fromJson(doc.toJson()).emitSource(), COUNTER_SOURCE);

  const rt = GraphRuntime.lower(doc);
  assert.equal(rt.get("doubled"), 2);
  assert.equal(rt.effectTrace().length, 1);
  assert.equal(rt.effectTrace()[0].id, "log");
  assert.equal(rt.effectTrace()[0].result, 2);
  assert.deepEqual(rt.observedReads("doubled"), new Set(["count"]));
  assert.deepEqual(rt.observedReads("log"), new Set(["doubled"]));
  assert.equal(rt.isEager("doubled"), true);
  assert.equal(rt.sourcePolicy("count"), Policy.KeepLatest);

  const before = rt.emitSource();
  rt.writeSource("count", 4);
  assert.equal(rt.get("doubled"), 8);
  assert.equal(rt.effectTrace().length, 2);
  assert.equal(rt.effectTrace()[1].result, 8);
  assert.equal(rt.emitSource(), before);

  rt.apply(GraphEdit.fromJsonStr(COUNTER_EDIT));
  assert.equal(rt.get("doubled"), 14);
  assert.equal(rt.get("shown"), "n:");
  assert.equal(rt.contains("log"), false);
  assert.equal(rt.isEager("doubled"), false);
  const traceLen = rt.effectTrace().length;
  rt.writeSource("count", 5);
  assert.equal(rt.get("doubled"), 15);
  assert.equal(rt.effectTrace().length, traceLen);
  const emitted = rt.emitSource();
  assert.equal(
    emitted,
    "graph counter ir 1\n" +
      "source count = 1\n" +
      "computed doubled = add(ref(count), lit(10))\n" +
      'source label = "n"\n' +
      'computed shown = concat(ref(label), lit(":"))\n',
  );
  assert.equal(emitted.includes("mul("), false);
  assert.equal(emitted.includes("effect log"), false);
});

test("dynamic if observes only the taken branch", () => {
  const rt = GraphRuntime.loadJson(`{
    "kind":"graph","ir":"1","nodes":[
      {"id":"flag","kind":"source","init":false},
      {"id":"left","kind":"source","init":"L"},
      {"id":"right","kind":"source","init":"R"},
      {"id":"picked","kind":"computed","expr":{"op":"if","args":[{"ref":"flag"},{"ref":"left"},{"ref":"right"}]}}
    ]}`);
  assert.deepEqual(edgesOf(rt.staticEdges()), [
    read("picked", "flag"),
    read("picked", "left"),
    read("picked", "right"),
  ]);
  assert.equal(rt.get("picked"), "R");
  assert.deepEqual(rt.observedReads("picked"), new Set(["flag", "right"]));
  rt.writeSource("flag", true);
  assert.equal(rt.get("picked"), "L");
  assert.deepEqual(rt.observedReads("picked"), new Set(["flag", "left"]));
});

test("sum policy folds on merge and skips an equal write", () => {
  const rt = GraphRuntime.loadJson(`{
    "kind":"graph","ir":"1","nodes":[
      {"id":"tick","kind":"source","init":0},
      {"id":"total","kind":"source","init":0,"policy":"sum"},
      {"id":"bump","kind":"effect","body":{"do":"seq","steps":[
        {"do":"eval","expr":{"ref":"tick"}},
        {"do":"merge","target":"total","expr":{"lit":1}}
      ]}}
    ]}`);
  assert.equal(rt.emitSource().includes("policy sum"), true);
  assert.equal(rt.emitSource().includes("merge(total, lit(1))"), true);
  assert.equal(rt.get("total"), 1);
  assert.equal(rt.effectTrace()[0].id, "bump");
  assert.deepEqual(rt.effectTrace()[0].result, [0, 1]);
  assert.equal(rt.sourcePolicy("total"), Policy.Sum);
  rt.writeSource("tick", 1);
  assert.equal(rt.get("total"), 2);
  assert.equal(rt.effectTrace().length, 2);
  rt.writeSource("tick", 1);
  assert.equal(rt.effectTrace().length, 2);
  assert.equal(rt.get("total"), 2);
});

test("structures read fields length and objects", () => {
  const rt = GraphRuntime.loadJson(`{
    "kind":"graph","ir":"1","nodes":[
      {"id":"row","kind":"source","init":{"name":"ada","n":2}},
      {"id":"name","kind":"computed","expr":{"op":"get","args":[{"ref":"row"},{"lit":"name"}]}},
      {"id":"n","kind":"computed","expr":{"op":"get","args":[{"ref":"row"},{"lit":"n"}]}},
      {"id":"tag","kind":"computed","expr":{"op":"concat","args":[{"ref":"name"},{"lit":"#"}]}},
      {"id":"width","kind":"computed","expr":{"op":"len","args":[{"ref":"name"}]}},
      {"id":"pair","kind":"computed","expr":{"op":"array","args":[{"ref":"name"},{"ref":"n"}]}},
      {"id":"wrapped","kind":"computed","expr":{"object":[{"key":"name","value":{"ref":"name"}}]}}
    ]}`);
  assert.equal(rt.get("name"), "ada");
  assert.equal(rt.get("n"), 2);
  assert.equal(rt.get("tag"), "ada#");
  assert.equal(rt.get("width"), 3);
  assert.deepEqual(rt.get("pair"), ["ada", 2]);
  assert.deepEqual(rt.get("wrapped"), { name: "ada" });
});

test("cycle is rejected and a snapshot is not a graph", () => {
  assert.throws(
    () =>
      GraphIr.fromJsonStr(
        '{"kind":"graph","ir":"1","nodes":[{"id":"a","kind":"computed","expr":{"ref":"b"}},{"id":"b","kind":"computed","expr":{"ref":"a"}}]}',
      ),
    (error) => error instanceof GraphIrError && error.message.includes("cycle in read edges"),
  );
  assert.throws(
    () => GraphIr.fromJsonStr('{"Snapshot":{"epoch":0,"nodes":[],"edges":[],"roots":[]}}'),
    (error) => error instanceof GraphIrError && error.message.includes("graph"),
  );
});

test("null init and ordered boolean policies", () => {
  const rt = GraphRuntime.loadJson(`{
    "kind":"graph","ir":"1","nodes":[
      {"id":"empty","kind":"source","init":null},
      {"id":"hi","kind":"source","init":3,"policy":"max"},
      {"id":"lo","kind":"source","init":3,"policy":"min"},
      {"id":"both","kind":"source","init":true,"policy":"and"},
      {"id":"either","kind":"source","init":false,"policy":"or"},
      {"id":"fold","kind":"effect","body":{"do":"seq","steps":[
        {"do":"merge","target":"hi","expr":{"lit":1}},
        {"do":"merge","target":"hi","expr":{"lit":5}},
        {"do":"merge","target":"hi","expr":{"lit":5}},
        {"do":"merge","target":"lo","expr":{"lit":1}},
        {"do":"merge","target":"both","expr":{"lit":false}},
        {"do":"merge","target":"either","expr":{"lit":true}}
      ]}}
    ]}`);
  assert.equal(rt.get("empty"), null);
  assert.equal(rt.get("hi"), 5);
  assert.equal(rt.get("lo"), 1);
  assert.equal(rt.get("both"), false);
  assert.equal(rt.get("either"), true);
  assert.equal(rt.sourcePolicy("hi"), Policy.Max);
  assert.equal(rt.sourcePolicy("both"), Policy.And);
  assert.equal(rt.sourcePolicy("either"), Policy.Or);
});

test("and short-circuits and div by zero faults on get", () => {
  const rt = GraphRuntime.loadJson(`{
    "kind":"graph","ir":"1","nodes":[
      {"id":"flag","kind":"source","init":false},
      {"id":"n","kind":"source","init":1},
      {"id":"bad","kind":"computed","expr":{"op":"div","args":[{"ref":"n"},{"lit":0}]}},
      {"id":"gate","kind":"computed","expr":{"op":"and","args":[{"ref":"flag"},{"ref":"bad"}]}}
    ]}`);
  assert.equal(rt.get("gate"), false);
  assert.deepEqual(rt.observedReads("gate"), new Set(["flag"]));
  assert.throws(
    () => rt.get("bad"),
    (error) => error instanceof GraphIrError && error.message.includes("division by zero"),
  );
});

test("failed edits leave the previous graph", () => {
  const rt = GraphRuntime.loadJson(
    '{"kind":"graph","ir":"1","nodes":[{"id":"a","kind":"source","init":1},{"id":"b","kind":"computed","expr":{"ref":"a"}}]}',
  );
  assert.throws(
    () =>
      rt.apply(GraphEdit.fromJsonStr('{"kind":"edit","ir":"1","ops":[{"op":"remove","id":"a"}]}')),
    (error) => error instanceof GraphIrError && error.message.includes("edit op 0"),
  );
  assert.equal(rt.contains("a") && rt.contains("b"), true);
  assert.equal(rt.get("b"), 1);

  const empty = GraphRuntime.loadJson('{"kind":"graph","ir":"1","nodes":[]}');
  assert.throws(
    () =>
      empty.apply(
        GraphEdit.fromJsonStr(
          '{"kind":"edit","ir":"1","ops":[{"op":"add","node":{"id":"a","kind":"computed","expr":{"ref":"b"}}},{"op":"add","node":{"id":"b","kind":"source","init":1}}]}',
        ),
      ),
    (error) => error instanceof GraphIrError && error.message.includes("edit op 0"),
  );
  assert.equal(empty.contains("a") || empty.contains("b"), false);
  assert.equal(empty.emitSource(), "graph ir 1\n");
});

test("replace source resets the live value and when records null", () => {
  const rt = GraphRuntime.loadJson(
    '{"kind":"graph","ir":"1","id":"g","nodes":[{"id":"count","kind":"source","init":1}]}',
  );
  rt.writeSource("count", 9);
  assert.equal(rt.get("count"), 9);
  assert.equal(rt.emitSource(), "graph g ir 1\nsource count = 1\n");
  rt.apply(
    GraphEdit.fromJsonStr(
      '{"kind":"edit","ir":"1","ops":[{"op":"replace","node":{"id":"count","kind":"source","init":0}}]}',
    ),
  );
  assert.equal(rt.get("count"), 0);
  assert.equal(rt.emitSource(), "graph g ir 1\nsource count = 0\n");

  const on = GraphRuntime.loadJson(
    '{"kind":"graph","ir":"1","nodes":[{"id":"on","kind":"source","init":true},{"id":"value","kind":"source","init":0},{"id":"apply","kind":"effect","body":{"do":"when","cond":{"ref":"on"},"then":{"do":"set","target":"value","expr":{"lit":7}}}}]}',
  );
  assert.equal(on.get("value"), 7);
  assert.equal(on.effectTrace()[0].result, 7);
  const off = GraphRuntime.loadJson(
    '{"kind":"graph","ir":"1","nodes":[{"id":"on","kind":"source","init":false},{"id":"value","kind":"source","init":0},{"id":"apply","kind":"effect","body":{"do":"when","cond":{"ref":"on"},"then":{"do":"set","target":"value","expr":{"lit":7}}}}]}',
  );
  assert.equal(off.get("value"), 0);
  assert.equal(off.effectTrace()[0].result, null);
});

test("empty graph accepts an add and rejections fail closed", () => {
  const rt = GraphRuntime.loadJson('{"kind":"graph","ir":"1","nodes":[]}');
  rt.apply(
    GraphEdit.fromJsonStr(
      '{"kind":"edit","ir":"1","ops":[{"op":"add","node":{"id":"x","kind":"source","init":1}}]}',
    ),
  );
  assert.equal(rt.get("x"), 1);
  assert.equal(rt.emitSource(), "graph ir 1\nsource x = 1\n");
  for (const text of [
    '{"kind":"graph","ir":"2","nodes":[]}',
    '{"kind":"graph","ir":"1","nodes":[{"id":"1count","kind":"source","init":0}]}',
    '{"kind":"graph","ir":"1","nodes":[{"id":"c","kind":"computed","expr":{"op":"pow","args":[{"lit":2},{"lit":3}]}}]}',
    '{"kind":"graph","ir":"1","nodes":[{"id":"e","kind":"effect","body":"log"}]}',
    '{"kind":"edit","ir":"1","ops":[]}',
  ]) {
    assert.throws(() => {
      if (text.includes('"kind":"edit"')) GraphEdit.fromJsonStr(text);
      else GraphIr.fromJsonStr(text);
    }, GraphIrError);
  }
});

test("feedback stops at the drain budget", () => {
  const doc = GraphIr.fromJsonStr(
    '{"kind":"graph","ir":"1","nodes":[{"id":"n","kind":"source","init":0},{"id":"loop","kind":"effect","body":{"do":"set","target":"n","expr":{"op":"add","args":[{"ref":"n"},{"lit":1}]}}}]}',
  );
  const rt = GraphRuntime.lower(doc, 4);
  assert.equal(rt.lastDrainExhaustion, 4);
  assert.equal(rt.get("n"), 4);
});
