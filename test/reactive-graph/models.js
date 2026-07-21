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
  Source,
  DisposedNodeError,
  Effect,
  SignalHandle,
  Computed,
  createContext,
} from "../../src/reactive.js";
import {
  AsyncCellHandle,
  AsyncContext,
  AsyncEffectHandle,
  AsyncSignalHandle,
  AsyncSlotHandle,
} from "../../src/reactive-async.js";
import { ThreadSafeContext } from "../../src/thread-safe.js";

export { DisposedNodeError };

/** Ops every model can now execute -- the whole corpus. */
const ALL_OPS = [
  "batch",
  "begin_scope",
  "cell",
  "churn",
  "computed",
  "disarm",
  "dispose",
  "dispose_fanout",
  "dispose_signal",
  "dispose_stale_handle",
  "effect",
  "end_scope",
  "fanout",
  "read",
  "set_cell",
  "signal",
];

/** `expect` keys every model can now evaluate -- the whole corpus. */
const ALL_ASSERTIONS = [
  "cleanup_order",
  "computes_of",
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
  if (handle instanceof Source || handle instanceof AsyncCellHandle) return "cell";
  if (handle instanceof Effect || handle instanceof AsyncEffectHandle) return "effect";
  if (handle instanceof Computed || handle instanceof AsyncSlotHandle) return "slot";
  if (handle instanceof SignalHandle || handle instanceof AsyncSignalHandle) return "signal";
  throw new Error("unrecognised handle class");
}

/**
 * The `computes_of` counter (`#lzsignaleager`).
 *
 * The signal fixtures assert *when* a compute ran, because an eager signal and
 * the lazy memo it is built on return identical values for every read sequence
 * the corpus can express -- a values-only assertion passes against a `signal()`
 * that is secretly a `memo()`. So the count must come from the real compute
 * closure, wrapped exactly once at synthesis, and must never be derived from the
 * runner's own model of what "should" have happened. `bump` is called from
 * inside the closure the context invokes; if the context never calls it, the
 * count stays where it was and the fixture fails, which is the point.
 *
 * Cumulative for the whole scenario, including the invocation at creation, and
 * never reset per step.
 */
function makeComputeCounter() {
  /** @type {Map<string, number>} */
  const counts = new Map();
  return {
    /** Wrap a compute so every invocation the context makes is counted. */
    countingSync(id, compute) {
      counts.set(id, 0);
      return () => {
        counts.set(id, counts.get(id) + 1);
        return compute();
      };
    },
    countingAsync(id, compute) {
      counts.set(id, 0);
      return async (cc) => {
        counts.set(id, counts.get(id) + 1);
        return compute(cc);
      };
    },
    of(id) {
      const n = counts.get(id);
      if (n === undefined) {
        throw new Error(`computes_of asked for ${id}, which has no counted compute`);
      }
      return n;
    },
  };
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
      const computes = makeComputeCounter();

      const readId = (id) => {
        const handle = handles.get(id);
        if (handle instanceof Source) return ctx.get(handle);
        if (handle instanceof SignalHandle) return ctx.getSignal(handle);
        return ctx.get(handle);
      };

      return {
        runLog,
        cleanupLog,
        async cell(id, value, scopeName) {
          const handle =
            scopeName == null ? ctx.source(value) : scopes.get(scopeName).source(value);
          handles.set(id, handle);
        },
        async computed(id, reads, offset, scopeName) {
          const compute = computes.countingSync(id, () => sumOffset(reads.map(readId), offset));
          const handle =
            scopeName == null
              ? ctx.computed(compute)
              : scopes.get(scopeName).computed(compute);
          handles.set(id, handle);
        },
        // Same `sum(reads) + offset` convention as `computed`, so the only
        // difference the fixtures see is eagerness.
        async signal(id, reads, offset, scopeName) {
          const compute = computes.countingSync(id, () => sumOffset(reads.map(readId), offset));
          const handle =
            scopeName == null ? ctx.signal(compute) : scopes.get(scopeName).signal(compute);
          handles.set(id, handle);
        },
        // Clause 4: the eager puller only. The backing memo slot survives and
        // reverts to lazy -- this is deliberately NOT `disposeNode`.
        async disposeSignal(id) {
          ctx.disposeSignal(handles.get(id));
        },
        async batch(writes) {
          ctx.batch(() => {
            for (const w of writes) ctx.set(handles.get(w.id), w.value);
          });
        },
        computesOf: (id) => computes.of(id),
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
          ctx.set(handles.get(id), value);
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
    const computes = makeComputeCounter();

    // Inside a compute: cells read synchronously, slots are awaited. Both
    // register the dependency edge before the value is produced.
    const readDep = async (cc, id) => {
      const handle = handles.get(id);
      if (handle instanceof AsyncCellHandle) return cc.get(handle);
      if (handle instanceof AsyncSignalHandle) return await cc.getAsync(handle.slot);
      return await cc.getAsync(handle);
    };

    const readId = async (id) => {
      const handle = handles.get(id);
      if (handle instanceof AsyncCellHandle) return ctx.get(handle);
      if (handle instanceof AsyncSignalHandle) return await ctx.getSignalAsync(handle);
      return await ctx.getAsync(handle);
    };

    return {
      runLog,
      cleanupLog,
      async cell(id, value, scopeName) {
        const handle =
          scopeName == null ? ctx.source(value) : scopes.get(scopeName).source(value);
        handles.set(id, handle);
      },
      async computed(id, reads, offset, scopeName) {
        const compute = computes.countingAsync(id, async (cc) => {
          const values = [];
          for (const r of reads) values.push(await readDep(cc, r));
          return sumOffset(values, offset);
        });
        const handle =
          scopeName == null
            ? ctx.memoAsync(compute)
            : scopes.get(scopeName).memoAsync(compute);
        handles.set(id, handle);
      },
      async signal(id, reads, offset, scopeName) {
        const compute = computes.countingAsync(id, async (cc) => {
          const values = [];
          for (const r of reads) values.push(await readDep(cc, r));
          return sumOffset(values, offset);
        });
        const handle =
          scopeName == null
            ? ctx.signalAsync(compute)
            : scopes.get(scopeName).signalAsync(compute);
        handles.set(id, handle);
      },
      async disposeSignal(id) {
        await ctx.disposeSignal(handles.get(id));
      },
      // `AsyncContext` satisfies clause 3 twice over: the batch defers
      // invalidation to the outermost exit, AND effect reruns coalesce into a
      // `pending` flag on the executor, so N writes reach the puller as one
      // rerun even unbatched. Verified by removing this wrapper: the sync and
      // thread-safe models then report the fixture's predicted 3, the async one
      // still reports 2. That is a stronger guarantee, not a missing one -- but
      // it does mean the batch fixture's discriminating power on THIS model
      // comes from the scheduler rather than from `batch` itself.
      async batch(writes) {
        ctx.batch(() => {
          for (const w of writes) ctx.set(handles.get(w.id), w.value);
        });
      },
      computesOf: (id) => computes.of(id),
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
        ctx.set(handles.get(id), value);
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
