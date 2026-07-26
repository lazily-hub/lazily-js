// Runtime conformance manifest (#lazilyupgradeconformance).
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
// Records to the path in LAZILY_CONFORMANCE_MANIFEST; a no-op when unset, so a
// plain `node --test` is unaffected.
const fs = require("node:fs");
const path = require("node:path");

const out = process.env.LAZILY_CONFORMANCE_MANIFEST;
if (out) {
  const marker = `${path.sep}lazily-spec${path.sep}conformance${path.sep}`;
  const opened = new Set();

  const record = (file) => {
    try {
      const p = typeof file === "string" ? file : file?.toString?.();
      if (!p || !p.includes(marker)) return;
      // Store the id relative to the conformance root, matching the corpus listing.
      opened.add(p.slice(p.indexOf(marker) + marker.length).split(path.sep).join("/"));
    } catch {
      // Never let bookkeeping break a test run.
    }
  };

  for (const fn of ["readFileSync", "readFile"]) {
    const original = fs[fn];
    if (typeof original !== "function") continue;
    fs[fn] = function (file, ...rest) {
      record(file);
      return original.call(this, file, ...rest);
    };
  }
  const originalPromises = fs.promises?.readFile;
  if (typeof originalPromises === "function") {
    fs.promises.readFile = function (file, ...rest) {
      record(file);
      return originalPromises.call(this, file, ...rest);
    };
  }

  // Append rather than truncate: `node --test test/*.test.js` may run more than one
  // process, and each must contribute what it read.
  process.on("exit", () => {
    if (opened.size === 0) return;
    try {
      fs.appendFileSync(out, [...opened].sort().join("\n") + "\n");
    } catch {
      // A manifest we cannot write is reported by the script as missing evidence,
      // which is the correct outcome — never mask it by failing the suite here.
    }
  });
}
