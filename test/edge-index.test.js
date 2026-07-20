// Teardown scopes, disposal, and degree introspection (`#lzspecedgeindex`).
//
// ## Why this file exists
//
// The reactive-graph conformance corpus is replayed in
// `reactive-graph-conformance.test.js` against all three contexts. When this
// port was written that corpus held NINE fixtures, and mutation testing
// established that it pinned only the first of the three disposal semantics --
// that a disposal dirties the surviving dependent cone. Two deliberate defects
// were injected and all nine fixtures stayed green against all three models:
//
//   1. dropping the `disposalDepth` guard in `scheduleEffect`, so effects
//      reached by a disposal cascade are SCHEDULED rather than merely marked; and
//   2. tearing a scope down in FORWARD creation order instead of reverse.
//
// Neither was observable there: the fixtures' `observed_by` / `observed_count`
// assertions never straddled a disposal, and their `cleanup_order` expectations
// each contained a single effect, so no ordering was visible. A corpus that
// cannot tell a defect from a fix is not coverage for that defect, so semantics
// 2 and 3 got direct tests here, written to go red under exactly those mutants.
//
// lazily-spec has since added `disposal_does_not_run_surviving_effects.json` and
// `teardown_runs_members_in_reverse_creation_order.json` (spec `1c80db5`), and
// with those two the corpus DOES now catch both mutants on all three models.
// These tests are kept regardless, and are not redundant with them:
//
//   * they localize. A corpus failure names a fixture and a step; these name the
//     mechanism, and each mutant reddens its own three tests and nothing else.
//   * they cover the drain explicitly. Marking dirty and scheduling are
//     indistinguishable at the moment of disposal -- `disposeSlot` does not
//     flush -- so each semantic-2 test forces a drain afterwards and asserts the
//     effect STILL has not run. That step is what makes the assertion real.
//   * they cover shapes the corpus has no vocabulary for: `withScope`'s
//     `finally` bracket, `Symbol.dispose`, and the `ThreadSafeContext` wrapper.
//
// Everything below the two semantics is the surface they live on: scope shape,
// `disarm`, and the degree counts the disposal contract is written against.
import assert from "node:assert/strict";
import test from "node:test";

import { DisposedNodeError, TeardownScope, createContext } from "../src/reactive.js";
import { AsyncContext, AsyncTeardownScope } from "../src/reactive-async.js";
import { ThreadSafeContext } from "../src/thread-safe.js";

// =================================================================================
// Semantic 2 — effects reached by a disposal cascade are MARKED, NEVER SCHEDULED
// =================================================================================
//
// Disposal is not a publish. An effect's next run is driven by a real write; a
// teardown that runs one re-enters a body that reads the node being torn down,
// turning `dispose` itself into a throw and breaking the idempotence teardown
// paths depend on.
//
// The assertion has to survive a LATER flush, not merely the disposal call.
// Marking dirty and scheduling look identical at the moment of disposal --
// `disposeSlot` does not flush -- so a test that only checked the run count
// immediately after `end()` would pass under the mutant too. Each test below
// therefore forces a drain afterwards (`ctx.batch(() => {})` synchronously,
// `await ctx.settle()` asynchronously) and asserts the effect STILL has not run.
//
// Both go red under mutant 1.

test("semantic 2 [Context]: an effect reached by a scope teardown is never scheduled", () => {
  const ctx = createContext();
  const source = ctx.cell(1);

  const scope = ctx.scope();
  const mid = scope.computed(() => ctx.getCell(source) + 10);

  // The watcher lives OUTSIDE the scope and reads INTO it, so ending the scope
  // reaches it through the cascade rather than by disposing it directly.
  let runs = 0;
  ctx.effect(() => {
    runs++;
    try {
      ctx.get(mid);
    } catch (err) {
      // The read-after-dispose this effect would hit IF it were wrongly rerun.
      // Swallowed so the failure surfaces as a run count, not as a stray throw
      // from an unrelated place.
      if (!(err instanceof DisposedNodeError)) throw err;
    }
    return null;
  });
  assert.equal(runs, 1, "the effect runs once on registration");

  scope.end();
  assert.equal(runs, 1, "teardown did not run the effect inline");

  // The discriminating step: drain the effect queue. A scheduled-but-unflushed
  // effect fires here.
  ctx.batch(() => {});
  assert.equal(
    runs,
    1,
    "teardown must not leave an effect QUEUED either — disposal is not a publish",
  );

  // And the contract that does hold: the reader errors on its next real pull.
  assert.throws(() => ctx.get(mid), DisposedNodeError);
});

test("semantic 2 [AsyncContext]: an effect reached by a scope teardown is never scheduled", async () => {
  const ctx = new AsyncContext();
  const source = ctx.cell(1);

  const scope = ctx.scope();
  const mid = scope.memoAsync(async (cc) => cc.getCell(source) + 10);

  let runs = 0;
  ctx.effectAsync(async (cc) => {
    runs++;
    try {
      await cc.getAsync(mid);
    } catch (err) {
      if (!(err instanceof DisposedNodeError)) throw err;
    }
    return null;
  });
  await ctx.settle();
  assert.equal(runs, 1, "the effect runs once on registration");

  await scope.end();
  // `settle()` is the drain: an effect scheduled during the teardown has a run
  // loop kicked on a microtask, and settling awaits it.
  await ctx.settle();
  assert.equal(
    runs,
    1,
    "teardown must not schedule the effect — disposal is not a publish",
  );

  await assert.rejects(() => ctx.getAsync(mid), DisposedNodeError);
  await ctx.dispose();
});

test("semantic 2 [Context]: a direct disposeSlot does not schedule either", () => {
  const ctx = createContext();
  const source = ctx.cell(1);
  const mid = ctx.computed(() => ctx.getCell(source) + 10);

  let runs = 0;
  ctx.effect(() => {
    runs++;
    try {
      ctx.get(mid);
    } catch (err) {
      if (!(err instanceof DisposedNodeError)) throw err;
    }
    return null;
  });
  assert.equal(runs, 1);

  ctx.disposeSlot(mid);
  ctx.batch(() => {});
  assert.equal(runs, 1, "disposal is not a publish, whether or not a scope drove it");
});

// =================================================================================
// Semantic 3 — a scope tears down in REVERSE creation order
// =================================================================================
//
// Graph state does not depend on the order (`disposeAll_order_independent` in
// lazily-formal), which is exactly why the corpus cannot see this. But effect
// CLEANUPS are side effects, and their order is observable to anyone who closes
// a file, cancels a request, or releases a lock in one.
//
// Reverse order means dependents are torn down before what they read, so the
// scope never transiently dangles inside itself. Two effects are the minimum
// that makes the direction visible; the corpus's `cleanup_order` expectations
// each contain a single effect, which is why they cannot discriminate it.
//
// Both go red under mutant 2.

test("semantic 3 [Context]: scope teardown runs cleanups in reverse creation order", () => {
  const ctx = createContext();
  const source = ctx.cell(1);
  const order = [];

  const scope = ctx.scope();
  scope.effect(() => {
    ctx.getCell(source);
    return () => order.push("first");
  });
  scope.effect(() => {
    ctx.getCell(source);
    return () => order.push("second");
  });
  scope.effect(() => {
    ctx.getCell(source);
    return () => order.push("third");
  });

  scope.end();
  assert.deepEqual(
    order,
    ["third", "second", "first"],
    "cleanups must unwind in reverse creation order, not forward",
  );
});

test("semantic 3 [AsyncContext]: scope teardown runs cleanups in reverse creation order", async () => {
  const ctx = new AsyncContext();
  const source = ctx.cell(1);
  const order = [];

  const scope = ctx.scope();
  for (const name of ["first", "second", "third"]) {
    scope.effectAsync(async (cc) => {
      cc.getCell(source);
      return () => order.push(name);
    });
    // Serialize registration so creation order is unambiguous; the async run
    // loop is what assigns each effect its cleanup.
    await ctx.settle();
  }

  await scope.end();
  assert.deepEqual(order, ["third", "second", "first"]);
  await ctx.dispose();
});

test("semantic 3 [Context]: reverse order holds for a mixed slot/effect scope", () => {
  const ctx = createContext();
  const source = ctx.cell(1);
  const order = [];

  const scope = ctx.scope();
  scope.effect(() => {
    ctx.getCell(source);
    return () => order.push("outer");
  });
  const mid = scope.computed(() => ctx.getCell(source) + 1);
  scope.effect(() => {
    // Reads a scope sibling, so a FORWARD teardown would tear `mid` out from
    // under this effect's cleanup while it is still registered.
    ctx.get(mid);
    return () => order.push("inner");
  });

  scope.end();
  assert.deepEqual(order, ["inner", "outer"]);
});

// =================================================================================
// Scope shape
// =================================================================================

test("scope: end is idempotent and withScope brackets it", () => {
  const ctx = createContext();
  let cleanups = 0;

  const returned = ctx.withScope((scope) => {
    assert.ok(scope instanceof TeardownScope);
    scope.effect(() => () => {
      cleanups++;
    });
    assert.equal(scope.size, 1);
    return "body result";
  });

  assert.equal(returned, "body result", "withScope returns the body's value");
  assert.equal(cleanups, 1, "the scope ended when the body returned");
});

test("scope: withScope ends the scope even when the body throws", () => {
  const ctx = createContext();
  let cleanups = 0;
  assert.throws(
    () =>
      ctx.withScope((scope) => {
        scope.effect(() => () => {
          cleanups++;
        });
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.equal(cleanups, 1, "the finally-bracket ran the teardown anyway");
});

test("scope: ending twice disposes once, and a scope ended inside withScope is not re-ended", () => {
  const ctx = createContext();
  let cleanups = 0;
  ctx.withScope((scope) => {
    scope.effect(() => () => {
      cleanups++;
    });
    scope.end();
    assert.equal(cleanups, 1);
    assert.equal(scope.ended, true);
  });
  assert.equal(cleanups, 1, "the bracket's end() is a no-op after an explicit one");
});

test("scope: Symbol.dispose ends the scope (TC39 explicit resource management)", () => {
  const ctx = createContext();
  let cleanups = 0;
  const scope = ctx.scope();
  scope.effect(() => () => {
    cleanups++;
  });
  // Exercised through the protocol rather than the `using` syntax so the test
  // itself does not require the syntax to be parseable.
  scope[Symbol.dispose]();
  assert.equal(cleanups, 1);
  assert.equal(scope.ended, true);
});

test("scope: disarm disposes nothing and leaves every edge intact", () => {
  const ctx = createContext();
  const source = ctx.cell(1);
  let cleanups = 0;

  const scope = ctx.scope();
  const escaped = scope.computed(() => ctx.getCell(source) + 1);
  scope.effect(() => {
    ctx.get(escaped);
    return () => {
      cleanups++;
    };
  });
  assert.equal(scope.size, 2);
  assert.equal(ctx.dependentCount(source), 1);

  scope.disarm();
  assert.equal(scope.size, 0, "a disarmed scope owns nothing");
  scope.end();

  assert.equal(cleanups, 0, "ending a disarmed scope disposes nothing");
  assert.equal(ctx.get(escaped), 2, "the nodes keep their values");
  assert.equal(ctx.dependentCount(source), 1, "and keep their edges");
});

test("scope: adopt takes ownership of an externally built node", () => {
  const ctx = createContext();
  const outside = ctx.cell(1);
  const scope = ctx.scope();
  scope.adopt(outside);
  assert.equal(scope.size, 1);
  scope.end();
  assert.throws(() => ctx.getCell(outside), DisposedNodeError);
});

test("scope: adopting into an already-ended scope is a no-op, not an immediate dispose", () => {
  const ctx = createContext();
  const scope = ctx.scope();
  scope.end();
  const late = ctx.cell(7);
  scope.adopt(late);
  assert.equal(scope.size, 0);
  assert.equal(ctx.getCell(late), 7, "the scope's moment had passed");
});

test("scope [AsyncContext]: the async scope has the same shape", async () => {
  const ctx = new AsyncContext();
  const scope = ctx.scope();
  assert.ok(scope instanceof AsyncTeardownScope);
  const source = scope.cell(3);
  const derived = scope.memoAsync(async (cc) => cc.getCell(source) + 1);
  assert.equal(await ctx.getAsync(derived), 4);
  assert.equal(scope.size, 2);

  await scope.end();
  assert.equal(scope.ended, true);
  await assert.rejects(() => ctx.getAsync(derived), DisposedNodeError);
  await ctx.dispose();
});

test("scope [ThreadSafeContext]: scope operations forward through the mutex", () => {
  const ctx = new ThreadSafeContext();
  const source = ctx.cell(1);
  let cleanups = 0;
  ctx.withScope((scope) => {
    const mid = scope.computed(() => ctx.getCell(source) + 1);
    scope.effect(() => {
      ctx.get(mid);
      return () => {
        cleanups++;
      };
    });
    assert.equal(scope.size, 2);
    assert.equal(ctx.dependentCount(source), 1);
  });
  assert.equal(cleanups, 1);
  assert.equal(ctx.dependentCount(source), 0, "the teardown reached the inner graph");
});

// =================================================================================
// Degree introspection — counts, never collections
// =================================================================================

test("degrees: counts track live edges in both directions, and disposal returns them to baseline", () => {
  const ctx = createContext();
  const source = ctx.cell(1);
  assert.equal(ctx.dependentCount(source), 0);
  assert.equal(ctx.dependencyCount(source), 0, "a cell is a pure source");

  const mid = ctx.computed(() => ctx.getCell(source) + 1);
  const sink = ctx.computed(() => ctx.get(mid) + 1);
  assert.equal(ctx.get(sink), 3);

  assert.equal(ctx.dependentCount(source), 1);
  assert.equal(ctx.dependentCount(mid), 1);
  assert.equal(ctx.dependencyCount(mid), 1);
  assert.equal(ctx.dependencyCount(sink), 1);
  assert.equal(ctx.dependentCount(sink), 0);

  ctx.disposeSlot(sink);
  assert.equal(ctx.dependentCount(mid), 0, "upstream edge detached");
  assert.equal(ctx.dependencyCount(sink), 0, "a disposed node reports zero degree");

  ctx.disposeSlot(mid);
  assert.equal(ctx.dependentCount(source), 0, "back to baseline");
});

test("degrees: a subscribe/unsubscribe cycle leaves the source's dependent count unchanged", () => {
  const ctx = createContext();
  const source = ctx.cell(0);
  const baseline = ctx.dependentCount(source);

  for (let i = 0; i < 200; i++) {
    ctx.withScope((scope) => {
      scope.effect(() => {
        ctx.getCell(source);
        return null;
      });
      assert.equal(ctx.dependentCount(source), baseline + 1, "one live subscriber");
    });
  }

  assert.equal(
    ctx.dependentCount(source),
    baseline,
    "the leak this whole plane exists to prevent: a constant live width must not "
    + "grow the source's dependent set",
  );
});

test("degrees: a signal handle resolves to its backing slot", () => {
  const ctx = createContext();
  const source = ctx.cell(1);
  const sig = ctx.signal(() => ctx.getCell(source) + 1);
  assert.equal(ctx.getSignal(sig), 2);
  // The signal's memo slot reads the cell, and its puller effect reads the slot.
  assert.equal(ctx.dependencyCount(sig), 1, "the backing slot's forward degree");
  assert.equal(ctx.dependentCount(sig), 1, "the puller effect reads it");
  assert.equal(ctx.dependencyCount(sig.effect), 1);
});

// =================================================================================
// Read/write after dispose, and the stale-handle hazard under id recycling
// =================================================================================

test("disposal: reads and writes after dispose raise DisposedNodeError, and dispose is idempotent", () => {
  const ctx = createContext();
  const source = ctx.cell(1);
  const derived = ctx.computed(() => ctx.getCell(source) + 1);
  assert.equal(ctx.get(derived), 2);

  ctx.disposeNode(derived);
  assert.throws(() => ctx.get(derived), DisposedNodeError);
  ctx.disposeNode(derived); // idempotent

  ctx.disposeNode(source);
  assert.throws(() => ctx.getCell(source), DisposedNodeError);
  assert.throws(() => ctx.setCell(source, 9), DisposedNodeError);
});

test("disposal: disposeNode dispatches on the handle's class, so a stale handle cannot tear down its id's successor", () => {
  const ctx = createContext();
  const sentinel = ctx.cell(99);
  ctx.disposeNode(sentinel);

  // Ids are recycled, so the successor very likely occupies the sentinel's id.
  const successor = ctx.computed(() => 1);
  assert.equal(ctx.get(successor), 1);

  // Disposing through the stale CELL handle must be a no-op: dispatching on the
  // arena's current kind would tear down the innocent slot instead.
  ctx.disposeNode(sentinel);
  assert.equal(ctx.get(successor), 1, "the successor survived a stale-handle teardown");
});

test("disposal: a reader that hits a disposed node leaves no dangling upstream edge", () => {
  const ctx = createContext();
  const source = ctx.cell(1);
  const mid = ctx.computed(() => ctx.getCell(source) + 1);
  const reader = ctx.computed(() => ctx.get(mid) + 1);
  assert.equal(ctx.get(reader), 3);
  assert.equal(ctx.dependencyCount(reader), 1);

  ctx.disposeSlot(mid);
  assert.throws(() => ctx.get(reader), DisposedNodeError);
  assert.equal(
    ctx.dependencyCount(reader),
    0,
    "the failed recompute registered no edge onto the freed id",
  );
});

test("disposal [AsyncContext]: a reader that hits a disposed node leaves no dangling upstream edge", async () => {
  const ctx = new AsyncContext();
  const source = ctx.cell(1);
  const mid = ctx.memoAsync(async (cc) => cc.getCell(source) + 1);
  const reader = ctx.memoAsync(async (cc) => (await cc.getAsync(mid)) + 1);
  assert.equal(await ctx.getAsync(reader), 3);
  assert.equal(ctx.dependencyCount(reader), 1);

  ctx.disposeSlot(mid);
  await assert.rejects(() => ctx.getAsync(reader), DisposedNodeError);
  assert.equal(ctx.dependencyCount(reader), 0);
  await ctx.dispose();
});
