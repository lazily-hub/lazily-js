// Execution-model adapters for the reactive-graph conformance runner
// (`#lzspecconf`).
//
// The fixtures under `../lazily-spec/conformance/reactive-graph/` are written
// against an abstract `Context`, and the corpus explicitly requires replay
// against *every* context a binding ships:
//
//   "a binding whose *asynchronous* context tracks staleness by revision
//    counters and in-flight state can break the pull chain that makes the lazy
//    strategy work, so a chain that refreshes correctly in the synchronous
//    context silently stops refreshing in the async one"
//   -- transitive_invalidation_reaches_depth.json (#lzdartobservercow)
//
// That is not a hypothetical: it is the exact shape of the cascade defect that
// shipped in lazily-dart and lazily-go. A runner that replays only the default
// context would have reported green against both. So lazily-js ships three
// adapters -- `Context`, `AsyncContext`, `ThreadSafeContext` -- and the runner
// replays the corpus against each independently.
//
// `ThreadSafeContext` is included because it is a *meaningful* wrapper, not an
// alias: every operation runs under a shared `AtomicMutex`, and it maintains its
// own instrumentation counters over a distinct internal `Context`. A mutex that
// serialized a recompute incorrectly, or a wrapper that forgot to forward an
// invalidation, would be invisible to the sync replay.
//
// ## Adapter contract
//
// Every adapter is uniformly `async`, so the engine can `await` each op without
// knowing which model it is driving. Each exposes:
//
//   name         -- model label used in assertion messages and the skip ledger
//   ops          -- Set of fixture op types this model can execute
//   assertions   -- Set of `expect` keys this model can evaluate
//   create()     -- returns a fresh instance
//
// and each instance exposes `cell`, `computed`, `read`, `setCell`, `dispose`,
// and `destroy`. `read` throws on a disposed node -- that is a contract the
// corpus asserts, not an implementation detail, so it is deliberately allowed to
// propagate and is caught by the engine.
//
// ## Capability sets are findings, not conveniences
//
// A model omits an op from `ops` only when the underlying context genuinely
// lacks the API. `AsyncContext` and `ThreadSafeContext` both omit `dispose`
// because neither exposes `disposeSlot`/`disposeCell` -- the sync `Context` is
// the only one with lazy-node teardown. That gap is reported by the runner as a
// named skip rather than being silently papered over by, say, disposing the
// inner context instead.
import { createContext } from "../../src/reactive.js";
import { AsyncContext } from "../../src/reactive-async.js";
import { ThreadSafeContext } from "../../src/thread-safe.js";

/** Assertion kinds the fixture bodies use that any model can evaluate. */
const VALUE_ASSERTIONS = ["note", "value", "read"];

/**
 * Sum the current values of `deps` and add `offset`.
 *
 * Fixture `computed` ops are always of the form `sum(reads) + offset`, which is
 * enough to build chains of arbitrary depth and fan-in while keeping the
 * expected values trivially checkable by hand.
 */
function sumOffset(values, offset) {
  let total = offset;
  for (const v of values) total += v;
  return total;
}

// --------------------------------------------------------------------------
// Model 1: the synchronous `Context` -- the binding's default execution model.
// --------------------------------------------------------------------------

export const syncModel = {
  name: "Context",
  ops: new Set(["cell", "computed", "read", "set_cell", "dispose"]),
  assertions: new Set([...VALUE_ASSERTIONS, "error", "readable"]),
  create() {
    const ctx = createContext();
    /** @type {Map<string, { kind: "cell" | "slot", handle: unknown }>} */
    const refs = new Map();

    const readRef = (ref) =>
      ref.kind === "cell" ? ctx.getCell(ref.handle) : ctx.get(ref.handle);

    return {
      async cell(id, value) {
        refs.set(id, { kind: "cell", handle: ctx.cell(value) });
      },
      async computed(id, reads, offset) {
        const deps = reads.map((r) => refs.get(r));
        const handle = ctx.computed(() =>
          sumOffset(deps.map(readRef), offset),
        );
        refs.set(id, { kind: "slot", handle });
      },
      async read(id) {
        return readRef(refs.get(id));
      },
      async setCell(id, value) {
        ctx.setCell(refs.get(id).handle, value);
      },
      async dispose(id) {
        const ref = refs.get(id);
        if (ref.kind === "cell") ctx.disposeCell(ref.handle);
        else ctx.disposeSlot(ref.handle);
      },
      async destroy() {},
    };
  },
};

// --------------------------------------------------------------------------
// Model 2: `AsyncContext` -- the path the dart/go cascade defect lived on.
// --------------------------------------------------------------------------
//
// Derived nodes are `memoAsync` slots: memoized (so the `==` store-guard step
// in the transitive fixture is meaningful) and async (so the revision-counter /
// in-flight machinery the fixture warns about is actually exercised).
//
// `setCell` awaits `settle()`. That is the model's legitimate quiescence
// boundary, not a workaround: it is where a caller in this context is entitled
// to observe a consistent graph. Reading before quiescence would assert a
// stronger property than the corpus states.
//
// `dispose` is absent from `ops`: `AsyncContext` exposes `disposeAsyncEffect`,
// `disposeSignal`, and a whole-context `dispose`, but no per-slot or per-cell
// teardown. Substituting one of those would replay a different fixture than the
// one on disk, so the runner names the gap and skips instead.

export const asyncModel = {
  name: "AsyncContext",
  ops: new Set(["cell", "computed", "read", "set_cell"]),
  assertions: new Set(VALUE_ASSERTIONS),
  create() {
    const ctx = new AsyncContext();
    /** @type {Map<string, { kind: "cell" | "slot", handle: unknown }>} */
    const refs = new Map();

    // Inside a compute: cells read synchronously, slots are awaited. Both
    // register the dependency edge before the value is produced.
    const readDep = async (cx, ref) =>
      ref.kind === "cell" ? cx.getCell(ref.handle) : await cx.getAsync(ref.handle);

    return {
      async cell(id, value) {
        refs.set(id, { kind: "cell", handle: ctx.cell(value) });
      },
      async computed(id, reads, offset) {
        const deps = reads.map((r) => refs.get(r));
        const handle = ctx.memoAsync(async (cx) => {
          const values = [];
          for (const dep of deps) values.push(await readDep(cx, dep));
          return sumOffset(values, offset);
        });
        refs.set(id, { kind: "slot", handle });
      },
      async read(id) {
        const ref = refs.get(id);
        return ref.kind === "cell"
          ? ctx.getCell(ref.handle)
          : await ctx.getAsync(ref.handle);
      },
      async setCell(id, value) {
        ctx.setCell(refs.get(id).handle, value);
        await ctx.settle();
      },
      async destroy() {
        await ctx.dispose();
      },
    };
  },
};

// --------------------------------------------------------------------------
// Model 3: `ThreadSafeContext` -- every op under a shared Atomics mutex.
// --------------------------------------------------------------------------
//
// Shaped like the sync model because the public surface is deliberately the
// same; the value of replaying it is that the mutex-guarded forwarding path is
// a distinct implementation that could drop an invalidation without the sync
// replay noticing. Like `AsyncContext` it has no `disposeSlot`/`disposeCell`.

export const threadSafeModel = {
  name: "ThreadSafeContext",
  ops: new Set(["cell", "computed", "read", "set_cell"]),
  assertions: new Set(VALUE_ASSERTIONS),
  create() {
    const ctx = new ThreadSafeContext();
    /** @type {Map<string, { kind: "cell" | "slot", handle: unknown }>} */
    const refs = new Map();

    const readRef = (ref) =>
      ref.kind === "cell" ? ctx.getCell(ref.handle) : ctx.get(ref.handle);

    return {
      async cell(id, value) {
        refs.set(id, { kind: "cell", handle: ctx.cell(value) });
      },
      async computed(id, reads, offset) {
        const deps = reads.map((r) => refs.get(r));
        const handle = ctx.computed(() =>
          sumOffset(deps.map(readRef), offset),
        );
        refs.set(id, { kind: "slot", handle });
      },
      async read(id) {
        return readRef(refs.get(id));
      },
      async setCell(id, value) {
        ctx.setCell(refs.get(id).handle, value);
      },
      async destroy() {},
    };
  },
};

/** Every execution model lazily-js ships, in replay order. */
export const MODELS = [syncModel, asyncModel, threadSafeModel];
