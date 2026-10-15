import { Computed, Context, Effect, Source, TeardownScope } from "../src/core.js";

const context: Context = Context();
const source: Source<number> = context.source(1);
const computed: Computed<number> = context.computed((compute) => compute.get(source) + 1);
const effect: Effect = context.effect((compute) => {
  compute.get(computed);
  return undefined;
});

context.batch(() => source.set(2));
const scope: TeardownScope = context.scope();
scope.adopt(effect);
scope.end();
