import assert from "node:assert/strict";
import { Context } from "@lazily-hub/lazily-js/reactive";

const ctx = new Context();
const source = ctx.source(1);
const computed = ctx.computed((read) => read.get(source) * 2);
let runs = 0;
const scope = ctx.scope();
scope.effect((read) => {
  assert.equal(read.get(computed), ctx.get(source) * 2);
  runs += 1;
  return null;
});
assert.equal(runs, 1);

ctx.batch(() => {
  ctx.set(source, 2);
  ctx.set(source, 3);
});
assert.equal(ctx.get(computed), 6);
assert.equal(runs, 2, "batched writes must coalesce to one effect rerun");

scope.end();
ctx.set(source, 4);
assert.equal(runs, 2, "a disposed scope must detach its effect");

assert.equal(typeof Context, "function");
assert.notStrictEqual(
  new Context(),
  ctx,
  "typed Context instances must retain distinct identities",
);
console.log("lazily-js Core artifact consumer: ok");
