// Execution-model adapters for the reactive-graph conformance runner
// (`#lzspecconf`, `#lzspecedgeindex`).
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
// alias: every operation runs under a shared `AtomicMutex` over a distinct
// internal `Context`. A mutex that serialized a recompute incorrectly, or a
// wrapper that forgot to forward an invalidation or a teardown, would be
// invisible to the sync replay.
//
// ## Adapter contract
//
// Every adapter is uniformly `async`, so the engine can `await` each op without
// knowing which model it is driving. Each exposes `name`, `ops`, `assertions`,
// and `create()`; each instance exposes the op surface plus `runLog` /
// `cleanupLog` (effect bodies and effect cleanups, in execution order),
// `settle()`, and `destroy()`.
//
// ## Subscribers are effects, not slots
//
// `fanout` / `churn` build their readers as EFFECTS. The corpus asserts
// `observed_count` on a publish, and in a lazy binding only an eager reader
// observes a publish without first being pulled -- a fan-out of lazy slots would
// report zero observers and the fixture would be measuring nothing.
//
// ## `kindOf` reads the HANDLE, not the graph
//
// lazily-js recycles node ids (`freeIds`), so after a disposal the arena at that
// id may already describe an unrelated node. `dispose_stale_handle` is precisely
// the case where that matters: the fixture hands back a handle whose id has been
// reissued and requires the teardown to be a no-op. Answering `kindOf` from the
// arena would make the runner assert the *successor's* kind and then tear it
// down -- so the kind comes from the class of the handle the model recorded,
// which is also how `Context.disposeNode` dispatches.
import {
  CellHandle,
  DisposedNodeError,
  EffectHandle,
  SlotHandle,
  createContext,
} from "../../src/reactive.js";
import {
  AsyncCellHandle,
  AsyncContext,
  AsyncEffectHandle,
  AsyncSlotHandle,
} from "../../src/reactive-async.js";
import { ThreadSafeContext } from "../../src/thread-safe.js";

export { DisposedNodeError };

/** Ops every model can now execute -- the whole corpus. */
const ALL_OPS = [
  "begin_scope",
  "cell",
  "churn",
  "computed",
  "disarm",
  "dispose",
  "dispose_fanout",
  "dispose_stale_handle",
  "effect",
  "end_scope",
  "fanout",
  "read",
  "set_cell",
];

/** `expect` keys every model can now evaluate -- the whole corpus. */
const ALL_ASSERTIONS = [
  "cleanup_order",
  "dependencies_of",
  "dependents_of",
  "error",
  "note",
  "observed_by",
  "observed_count",
  "read",
  "readable",
  "scope_owned_count",
  "value",
];

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

/** The kind of a node as the corpus names them, read from the handle's class. */
function kindOfHandle(handle) {
  if (handle instanceof CellHandle || handle instanceof AsyncCellHandle) return "cell";
  if (handle instanceof EffectHandle || handle instanceof AsyncEffectHandle) return "effect";
  if (handle instanceof SlotHandle || handle instanceof AsyncSlotHandle) return "slot";
  throw new Error("unrecognised handle class");
}

// --------------------------------------------------------------------------
// Models 1 and 3: the synchronous `Context`, and `ThreadSafeContext` -- the
// same public surface, one of them behind an Atomics mutex.
// --------------------------------------------------------------------------
//
// One factory for both. The wrapper is a genuinely distinct implementation (a
// forwarding layer that could drop an invalidation or take a lock at the wrong
// granularity), but its API is deliberately identical, so a shared adapter is
// what keeps the two replays comparable instead of accidentally diverging.

function makeSyncLikeModel(name, makeContext) {
  return {
    name,
    ops: new Set(ALL_OPS),
    assertions: new Set(ALL_ASSERTIONS),
    create() {
      const ctx = makeContext();
      /** @type {Map<string, object>} */
      const handles = new Map();
      /** @type {Map<string, object>} */
      const scopes = new Map();
      const runLog = [];
      const cleanupLog = [];

      const readId = (id) => {
        const handle = handles.get(id);
        return handle instanceof CellHandle ? ctx.getCell(handle) : ctx.get(handle);
      };

      return {
        runLog,
        cleanupLog,
        async cell(id, value, scopeName) {
          const handle =
            scopeName == null ? ctx.cell(value) : scopes.get(scopeName).cell(value);
          handles.set(id, handle);
        },
        async computed(id, reads, offset, scopeName) {
          const compute = () => sumOffset(reads.map(readId), offset);
          const handle =
            scopeName == null
              ? ctx.computed(compute)
              : scopes.get(scopeName).computed(compute);
          handles.set(id, handle);
        },
        async effect(id, reads, scopeName) {
          const body = () => {
            runLog.push(id);
            // Swallowed, never propagated: an effect that reads through a
            // disposed node must not turn the publish that scheduled it into a
            // throw. The corpus asserts read-after-dispose at top-level reads,
            // which is where a caller can act on it. Narrow on purpose -- any
            // OTHER error still escapes and fails the run.
            try {
              for (const r of reads) readId(r);
            } catch (err) {
              if (!(err instanceof DisposedNodeError)) throw err;
            }
            return () => cleanupLog.push(id);
          };
          const handle =
            scopeName == null ? ctx.effect(body) : scopes.get(scopeName).effect(body);
          handles.set(id, handle);
        },
        async read(id) {
          return readId(id);
        },
        async setCell(id, value) {
          ctx.setCell(handles.get(id), value);
        },
        async dispose(id) {
          ctx.disposeNode(handles.get(id));
        },
        kindOf: (id) => kindOfHandle(handles.get(id)),
        isEffectActive: (id) => ctx.isEffectActive(handles.get(id)),
        dependentsOf: (id) => ctx.dependentCount(handles.get(id)),
        dependenciesOf: (id) => ctx.dependencyCount(handles.get(id)),
        beginScope(scopeName) {
          scopes.set(scopeName, ctx.scope());
        },
        async endScope(scopeName) {
          scopes.get(scopeName).end();
        },
        disarmScope(scopeName) {
          scopes.get(scopeName).disarm();
        },
        scopeOwned: (scopeName) => scopes.get(scopeName).size,
        // Synchronous models are already quiescent when an op returns.
        async settle() {},
        async destroy() {},
      };
    },
  };
}

export const syncModel = makeSyncLikeModel("Context", () => createContext());

export const threadSafeModel = makeSyncLikeModel(
  "ThreadSafeContext",
  () => new ThreadSafeContext(),
);

// --------------------------------------------------------------------------
// Model 2: `AsyncContext` -- the path the dart/go cascade defect lived on.
// --------------------------------------------------------------------------
//
// Derived nodes are `memoAsync` slots: memoized (so the `==` store-guard step in
// the transitive fixture is meaningful) and async (so the revision-counter /
// in-flight machinery the fixture warns about is actually exercised).
//
// `settle()` awaits the context's own quiescence anchor. That is the model's
// legitimate observation boundary, not a workaround: it is where a caller in
// this context is entitled to observe a consistent graph, and asserting before
// quiescence would assert a STRONGER property than the corpus states. It changes
// *when* assertions are evaluated, never *what* they assert -- an effect that
// never runs still fails.

export const asyncModel = {
  name: "AsyncContext",
  ops: new Set(ALL_OPS),
  assertions: new Set(ALL_ASSERTIONS),
  create() {
    const ctx = new AsyncContext();
    /** @type {Map<string, object>} */
    const handles = new Map();
    /** @type {Map<string, object>} */
    const scopes = new Map();
    const runLog = [];
    const cleanupLog = [];

    // Inside a compute: cells read synchronously, slots are awaited. Both
    // register the dependency edge before the value is produced.
    const readDep = async (cc, id) => {
      const handle = handles.get(id);
      return handle instanceof AsyncCellHandle
        ? cc.getCell(handle)
        : await cc.getAsync(handle);
    };

    const readId = async (id) => {
      const handle = handles.get(id);
      return handle instanceof AsyncCellHandle
        ? ctx.getCell(handle)
        : await ctx.getAsync(handle);
    };

    return {
      runLog,
      cleanupLog,
      async cell(id, value, scopeName) {
        const handle =
          scopeName == null ? ctx.cell(value) : scopes.get(scopeName).cell(value);
        handles.set(id, handle);
      },
      async computed(id, reads, offset, scopeName) {
        const compute = async (cc) => {
          const values = [];
          for (const r of reads) values.push(await readDep(cc, r));
          return sumOffset(values, offset);
        };
        const handle =
          scopeName == null
            ? ctx.memoAsync(compute)
            : scopes.get(scopeName).memoAsync(compute);
        handles.set(id, handle);
      },
      async effect(id, reads, scopeName) {
        const body = async (cc) => {
          runLog.push(id);
          try {
            for (const r of reads) await readDep(cc, r);
          } catch (err) {
            if (!(err instanceof DisposedNodeError)) throw err;
          }
          return () => cleanupLog.push(id);
        };
        const handle =
          scopeName == null
            ? ctx.effectAsync(body)
            : scopes.get(scopeName).effectAsync(body);
        handles.set(id, handle);
      },
      async read(id) {
        return readId(id);
      },
      async setCell(id, value) {
        ctx.setCell(handles.get(id), value);
      },
      async dispose(id) {
        await ctx.disposeNode(handles.get(id));
      },
      kindOf: (id) => kindOfHandle(handles.get(id)),
      isEffectActive: (id) => ctx.isEffectActive(handles.get(id)),
      dependentsOf: (id) => ctx.dependentCount(handles.get(id)),
      dependenciesOf: (id) => ctx.dependencyCount(handles.get(id)),
      beginScope(scopeName) {
        scopes.set(scopeName, ctx.scope());
      },
      async endScope(scopeName) {
        await scopes.get(scopeName).end();
      },
      disarmScope(scopeName) {
        scopes.get(scopeName).disarm();
      },
      scopeOwned: (scopeName) => scopes.get(scopeName).size,
      async settle() {
        await ctx.settle();
      },
      async destroy() {
        await ctx.dispose();
      },
    };
  },
};

/** Every execution model lazily-js ships, in replay order. */
export const MODELS = [syncModel, asyncModel, threadSafeModel];
