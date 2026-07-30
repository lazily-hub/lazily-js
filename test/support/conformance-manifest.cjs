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
// Two manifests are produced:
//
//   LAZILY_CONFORMANCE_MANIFEST      — which fixtures were opened.
//   LAZILY_CONFORMANCE_KEY_MANIFEST  — which assertion KEYS inside those fixtures
//                                      were actually read (#lzassertunknownkeys).
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
// Both are no-ops when their env var is unset, so a plain `node --test` is
// unaffected.
const fs = require("node:fs");
const path = require("node:path");

const out = process.env.LAZILY_CONFORMANCE_MANIFEST;
const keyOut = process.env.LAZILY_CONFORMANCE_KEY_MANIFEST;

if (out || keyOut) {
  const marker = `${path.sep}lazily-spec${path.sep}conformance${path.sep}`;
  const opened = new Set();
  // `fixture\tblock\tkey\tP` for present, `...\tR` for read.
  const keyRecords = new Set();
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
      return p.slice(p.indexOf(marker) + marker.length).split(path.sep).join("/");
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
  const TRACKED = new Set(["assertions", "expect", "expected"]);

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
    for (const [key, value] of Object.entries(object)) {
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
              `${rel}: invariants.${name} is not prose (${typeof claim}). `
              + "`invariants` is exempt from key-consumption tracking because its "
              + "values are English descriptions of what `steps` encode. A value "
              + "with a machine-checkable shape belongs in `expect`/`expected` "
              + "where the consumption guard can see it.",
            );
          }
        }
        continue;
      }
      walk(rel, value);
      if (TRACKED.has(key) && isPlainObject(value)) instrumentBlock(rel, key, value);
    }
  };

  for (const fn of ["readFileSync", "readFile"]) {
    const original = fs[fn];
    if (typeof original !== "function") continue;
    fs[fn] = function (file, ...rest) {
      const rel = record(file);
      const result = original.call(this, file, ...rest);
      if (keyOut && rel && (typeof result === "string" || Buffer.isBuffer(result))) {
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
      if (!keyOut || !rel) return promise;
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
  });
}
