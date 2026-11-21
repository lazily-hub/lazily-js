import { Computed, Context, Effect, Source, TeardownScope } from "../src/core.js";

const context: Context = Context();
const source: Source<number> = context.source(1);
const computed: Computed<number> = context.computed((compute) => compute.get(source) + 1);
const effect: Effect = context.effect((compute) => {
  compute.get(computed);
  return undefined;
});
// #lzeffectvoid: core-v1 (amended) lets an effect body return `void`, so a
// bare statement body or a call to a `void` function needs no `return undefined`.
const observe = (_value: number): void => {};
const voidEffect: Effect = context.effect((compute) => observe(compute.get(computed)));
const statementEffect: Effect = context.effect((compute) => {
  observe(compute.get(computed));
});

context.batch(() => source.set(2));
const scope: TeardownScope = context.scope();
scope.adopt(effect);
scope.adopt(voidEffect);
scope.adopt(statementEffect);
scope.end();
