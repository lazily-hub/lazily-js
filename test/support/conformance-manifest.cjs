// Runtime conformance manifest (#lazilyupgradeconformance, #lzassertunknownkeys).
//
// The static coverage guard greps test sources for fixture filenames. That catches
// a fixture nobody mentions, but not a fixture mentioned in a comment and
// hand-transcribed — the drift found in lazily-cpp's queue tests. Only observing
// the actual read proves the bytes were opened.
//
// This is a --require preload rather than an edit to ~73 readFileSync call sites.
// Wrapping the syscall is not a shortcut here, it is the stronger instrument: it
// records what the suite REALLY read, so a runner that stops loading a fixture is
// caught even if its source still names it. Editing call sites would record what
// each site claims to load.
//
// Three manifests are produced:
//
//   LAZILY_CONFORMANCE_MANIFEST          — which fixtures were opened.
//   LAZILY_CONFORMANCE_KEY_MANIFEST      — which assertion KEYS inside those
//                                          fixtures were actually read
//                                          (#lzassertunknownkeys).
//   LAZILY_CONFORMANCE_SCENARIO_MANIFEST — which SCENARIOS inside those fixtures
//                                          were actually replayed
//                                          (#lzscenariocoverage).
//
// The second is a level below the first. "The fixture was replayed" does not mean
// "the assertion the fixture exists for was checked": a runner that reads named
// keys out of an `assertions`/`expect`/`expected` block and lets anything it does
// not recognise fall through reports the fixture as replayed while never checking
// the field. In JavaScript that path is invisible — `const {a, b} = fx.expect`
// and `if ("x" in a)` both read an absent or misspelled key as "not my problem",
// so a corpus key no binding implements is skipped in silence.
//
// The recorder converts every key of a tracked assertion block into an accessor
// that records the read. Accessors, not a Proxy: a Proxy is not structured-
// cloneable and several runners `structuredClone` a fixture, while accessor
// properties survive structuredClone, JSON.stringify and assert.deepEqual (which
// invokes them, so a whole-block deepEqual correctly counts as consuming every
// key). `"x" in block` deliberately does NOT count as a read — membership is how
// the silent path is spelled; only fetching the value is consumption.
//
// A read is still not an assertion (#lzconsumednotasserted). A runner can read a
// key and discard it: a named `continue` inside a loop that iterates the block, a
// value bound and never compared, or an arm that reads the key and then compares
// against a hardcoded literal instead of the fixture's own value. Every one of
// those marks the key READ and proves nothing. So the recorder tracks a second
// fact — which keys reached a comparison against their own fixture value — and a
// third — which keys a runner declared it cannot assert here, with a reason.
//
// Those two facts cannot be inferred by watching property access, so they are
// reported by the runner through `test/support/assert-key.js`, whose helpers are
// the ONLY path that marks a key asserted. That is deliberate: an arm comparing
// against a literal reads the key and never routes through the helper, so it
// stays unasserted and the guard names it.
//
// The scenario ledger is the rung above all of that (#lzscenariocoverage). A
// fixture with several named scenarios can be PARTIALLY replayed and nothing
// notices: rung 1 asks only whether the FILE was opened, and rungs 2-3 bind only
// the blocks a runner reaches, so an unreplayed scenario contributes no
// unconsumed and no unasserted key. Worse, key records are keyed by
// `fixture\tblock\tkey`, so sibling scenarios sharing an `expect` key name mask
// each other outright — `collections/stableid_alignment.json` had a scenario
// this runner never touched, hidden behind another scenario's `key_equal`.
//
// So this recorder also registers every element of a `scenarios` array against
// its fixture, resolving the scenario's id in the corpus-wide fixed order
// (`id`, else `name`, else the positional index spelled `#<n>`), and exposes a
// channel the runner marks a replay through. The registration is what lets the
// runner mark WITHOUT naming its own fixture, exactly as `blockOwner` does for
// keys — a runner that names the fixture is making a claim, and a claim rots.
//
// All of this is a no-op when the env vars are unset, so a plain `node --test` is
// unaffected.
const fs = require("node:fs");
const path = require("node:path");

const out = process.env.LAZILY_CONFORMANCE_MANIFEST;
const keyOut = process.env.LAZILY_CONFORMANCE_KEY_MANIFEST;
const scenarioOut = process.env.LAZILY_CONFORMANCE_SCENARIO_MANIFEST;
// Both the key tracker and the scenario ledger need the parsed fixture, so the
// JSON.parse hook and the walk are shared by them.
const walkOut = keyOut || scenarioOut;

if (out || walkOut) {
  const marker = `${path.sep}lazily-spec${path.sep}conformance${path.sep}`;
  const opened = new Set();
  // `fixture\tblock\tkey\tP` present, `...\tR` read, `...\tA` asserted,
  // `...\tX\t<reason>` excused.
  const keyRecords = new Set();
  // Instrumented block object -> `fixture\tblock`, so the assertion helpers can
  // attribute a mark without the runner naming its own fixture.
  const blockOwner = new WeakMap();
  // Scenario object -> `fixture\tid`, the same trick one level up: the scenario
  // helpers mark a replay by handing back the object the runner is replaying.
  const scenarioOwner = new WeakMap();
  // `fixture\tid` for every scenario a runner really replayed.
  const scenarioRecords = new Set();
  // Fixture text -> corpus-relative id, so JSON.parse can attribute a parse to
  // the bytes a corpus read returned.
  const corpusText = new Map();
  // Some runners rewrite the text before parsing it (the stdlib loader quotes
  // 64-bit literals so they survive as BigInt). Those parses must still be
  // attributed, so a leading-window index backs up the exact match. A window
  // claimed by two fixtures is set to null and stops matching, so the fallback
  // can never attribute a parse to the wrong fixture — and a parse that matches
  // neither leaves the fixture with no key records at all, which the guard
  // reports as missing evidence rather than passing in silence.
  const PREFIX = 200;
  const corpusPrefix = new Map();

  const relId = (file) => {
    try {
      const p = typeof file === "string" ? file : file?.toString?.();
      if (!p || !p.includes(marker)) return null;
      // Store the id relative to the conformance root, matching the corpus listing.
      return p
        .slice(p.indexOf(marker) + marker.length)
        .split(path.sep)
        .join("/");
    } catch {
      // Never let bookkeeping break a test run.
      return null;
    }
  };

  const record = (file) => {
    const rel = relId(file);
    if (rel) opened.add(rel);
    return rel;
  };

  // Blocks whose keys are machine-checkable assertions. `invariants` is
  // deliberately absent: its values are English prose naming a property the
  // fixture's `steps` encode, so there is nothing to compare a runner's
  // observation against. That exemption is ENFORCED below rather than assumed —
  // a non-string value in an `invariants` block is a machine-checkable assertion
  // hiding in the one block nothing checks, and it throws.
  // `expect_initial` / `expect_after` are the same kind of block under a
  // phase-qualified name (`collections/semtree_incremental.json`). Leaving them
  // out let a whole assertion block sit outside both rungs, which is the gap
  // the tracked-name list exists to close.
  const TRACKED = new Set(["assertions", "expect", "expected", "expect_initial", "expect_after"]);

  // Prose keys inside a tracked block. Their values are English sentences about
  // the step, not values to compare, so they are exempt from read, assertion and
  // excuse accounting alike. The exemption is conditional on the value REALLY
  // being a string, for the same reason the `invariants` exemption is enforced: a
  // machine-checkable value must never be able to hide behind a prose name.
  //
  // `reason` is deliberately NOT here. In this corpus it carries error
  // discriminators (`clock_regression`, `deadline_overflow`,
  // `operation_unavailable`) that a runner must compare, so exempting it would
  // silence a real assertion.
  const PROSE = new Set(["comment", "description", "note", "notes", "why"]);
  const isProse = (key, value) => PROSE.has(key) && typeof value === "string";

  const remember = (data, rel) => {
    try {
      const text = data.toString("utf8");
      corpusText.set(text, rel);
      const head = text.slice(0, PREFIX);
      if (head.length < PREFIX) return;
      const claimed = corpusPrefix.get(head);
      corpusPrefix.set(head, claimed === undefined || claimed === rel ? rel : null);
    } catch {
      // Bookkeeping only.
    }
  };

  const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

  const instrumentBlock = (rel, block, object) => {
    blockOwner.set(object, `${rel}\t${block}`);
    for (const [key, value] of Object.entries(object)) {
      if (isProse(key, value)) continue;
      keyRecords.add(`${rel}\t${block}\t${key}\tP`);
      Object.defineProperty(object, key, {
        enumerable: true,
        configurable: true,
        get() {
          keyRecords.add(`${rel}\t${block}\t${key}\tR`);
          return value;
        },
        set(next) {
          // Some runners mutate a clone to prove the runner itself fails on drift.
          Object.defineProperty(object, key, {
            enumerable: true,
            configurable: true,
            writable: true,
            value: next,
          });
        },
      });
    }
  };

  // The corpus-wide scenario id resolution order (#lzscenariocoverage):
  //
  //   1. `id` if present
  //   2. else `name` if present
  //   3. else the positional index, spelled `#<n>` (0-based)
  //
  // The corpus is not uniform — the three `stdlib` fixtures identify a scenario
  // by `id`, twenty-eight identify by `name`, and
  // `collections/mergecell_algebra.json` carries no identifier at all. Step 3
  // exists so this rung is not blocked on a shared-corpus edit; the guard
  // REPORTS every positional fallback rather than accepting it silently, and
  // that visibility is what makes the corpus gap fixable upstream later.
  const scenarioId = (scenario, index) => {
    if (scenario.id !== undefined && scenario.id !== null) return String(scenario.id);
    if (scenario.name !== undefined && scenario.name !== null) return String(scenario.name);
    return `#${index}`;
  };

  const registerScenarios = (rel, list) => {
    list.forEach((scenario, index) => {
      if (!isPlainObject(scenario)) return;
      scenarioOwner.set(scenario, `${rel}\t${scenarioId(scenario, index)}`);
    });
  };

  const walk = (rel, node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(rel, item);
      return;
    }
    if (!isPlainObject(node)) return;
    // Read the raw entries BEFORE any accessor is installed on this node, so the
    // walk never records itself as a consumer.
    for (const [key, value] of Object.entries(node)) {
      if (key === "invariants" && isPlainObject(value)) {
        for (const [name, claim] of Object.entries(value)) {
          if (typeof claim !== "string") {
            throw new Error(
              `${rel}: invariants.${name} is not prose (${typeof claim}). ` +
                "`invariants` is exempt from key-consumption tracking because its " +
                "values are English descriptions of what `steps` encode. A value " +
                "with a machine-checkable shape belongs in `expect`/`expected` " +
                "where the consumption guard can see it.",
            );
          }
        }
        continue;
      }
      if (key === "scenarios" && Array.isArray(value) && scenarioOut) {
        registerScenarios(rel, value);
      }
      walk(rel, value);
      if (keyOut && TRACKED.has(key) && isPlainObject(value)) instrumentBlock(rel, key, value);
    }
  };

  for (const fn of ["readFileSync", "readFile"]) {
    const original = fs[fn];
    if (typeof original !== "function") continue;
    fs[fn] = function (file, ...rest) {
      const rel = record(file);
      const result = original.call(this, file, ...rest);
      if (walkOut && rel && (typeof result === "string" || Buffer.isBuffer(result))) {
        remember(result, rel);
      }
      return result;
    };
  }
  const originalPromises = fs.promises?.readFile;
  if (typeof originalPromises === "function") {
    fs.promises.readFile = function (file, ...rest) {
      const rel = record(file);
      const promise = originalPromises.call(this, file, ...rest);
      if (!walkOut || !rel) return promise;
      return promise.then((result) => {
        try {
          if (typeof result === "string" || Buffer.isBuffer(result)) remember(result, rel);
        } catch {
          // Bookkeeping only.
        }
        return result;
      });
    };
  }

  if (keyOut) {
    // The channel `test/support/assert-key.js` marks through. It is installed on
    // `globalThis` because the recorder is a CJS `--require` preload and the
    // runners are ESM; there is no import edge between them.
    //
    // `owner()` returning null means the object handed in is not a tracked
    // assertion block — a nested plain object inside one, or a structuredClone of
    // one. Marking is then a no-op, and the helper still performs the comparison;
    // the guard reports the original block's key as read-but-not-asserted, which
    // is the correct outcome for a runner asserting against a copy.
    globalThis.__lazilyConformanceKeys = {
      owner(object) {
        if (!isPlainObject(object)) return null;
        return blockOwner.get(object) ?? null;
      },
      mark(object, key, tag, reason) {
        const id = this.owner(object);
        if (id === null) return false;
        // Prose keys carry no presence record, so they carry no mark either.
        if (!keyRecords.has(`${id}\t${key}\tP`)) return false;
        keyRecords.add(tag === "X" ? `${id}\t${key}\tX\t${reason}` : `${id}\t${key}\t${tag}`);
        return true;
      },
    };
  }

  if (scenarioOut) {
    // The channel `test/support/scenario.js` marks a replay through, installed on
    // `globalThis` for the same reason as the key channel: the recorder is a CJS
    // `--require` preload and the runners are ESM.
    //
    // `owner()` returning null means the object handed in is not an element of a
    // corpus fixture's `scenarios` array — a hand-built object, or a
    // structuredClone of a real scenario. Unlike the key channel this is NOT
    // absorbed quietly: a scenario whose replay cannot be attributed would be
    // reported by the guard as never replayed, and "your runner replayed a copy"
    // is a far more useful failure than that. The helper turns it into a throw.
    globalThis.__lazilyConformanceScenarios = {
      owner(scenario) {
        if (!isPlainObject(scenario)) return null;
        return scenarioOwner.get(scenario) ?? null;
      },
      record(scenario) {
        const id = this.owner(scenario);
        if (id === null) return false;
        scenarioRecords.add(id);
        return true;
      },
    };
  }

  if (walkOut) {
    const originalParse = JSON.parse;
    JSON.parse = function (text, reviver) {
      const value = originalParse.call(this, text, reviver);
      if (corpusText.size !== 0) {
        let key = null;
        if (typeof text === "string") key = text;
        else if (Buffer.isBuffer(text)) key = text.toString("utf8");
        let rel = key === null ? undefined : corpusText.get(key);
        if (!rel && key !== null && key.length >= PREFIX) {
          rel = corpusPrefix.get(key.slice(0, PREFIX)) ?? undefined;
        }
        if (rel) walk(rel, value);
      }
      return value;
    };
  }

  // Append rather than truncate: `node --test test/*.test.js` may run more than one
  // process, and each must contribute what it read.
  const flush = (file, lines) => {
    if (!file || lines.size === 0) return;
    try {
      fs.appendFileSync(file, [...lines].sort().join("\n") + "\n");
    } catch {
      // A manifest we cannot write is reported by the script as missing evidence,
      // which is the correct outcome — never mask it by failing the suite here.
    }
  };

  process.on("exit", () => {
    flush(out, opened);
    flush(keyOut, keyRecords);
    flush(scenarioOut, scenarioRecords);
  });
}
