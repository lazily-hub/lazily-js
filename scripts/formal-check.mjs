// Lazily-formal proof verification hook for the lazily-js test suite.
//
// The JS state-chart / reactive / collection / CRDT modules are accompanied by
// a Lean 4 formal model in the sibling `lazily-formal` submodule
// (`LazilyFormal.StateChart` / `StateMachine` / `Reactive` / `Collection` /
// `Tree` / `Reconciliation` / `AsyncSlotState`). The JS tests in
// `test/state-machine.test.js` and `test/statechart-properties.test.js` name
// the universal theorems they mirror; this script makes those theorems
// *executable* by building the Lean model. If a proof breaks, the test suite
// fails.
//
// Behavior:
//   - If `lazily-formal` is a sibling of this package (full repo checkout /
//     submodule present) and `lake` is on PATH, run `lake build` and propagate
//     its exit status.
//   - If either is missing (npm tarball consumer, shallow clone, no Lean
//     toolchain), print a clear SKIP notice and exit 0 so the JS-only tests
//     still run. CI uses a full checkout, so the formal model is verified
//     there.

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Layout: <repo>/scripts/formal-check.mjs and <superproject>/src/lazily-formal.
// From the published package root, `../lazily-formal` covers the in-repo
// submodule layout (`src/lazily-js` ↔ `src/lazily-formal`).
const candidates = [
  join(here, "..", "lazily-formal"),
  join(here, "..", "..", "lazily-formal"),
];

function resolveFormalDir() {
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const resolved = realpathSync(candidate);
      // A real lazily-formal checkout ships these markers.
      if (
        existsSync(join(resolved, "lakefile.lean")) &&
        existsSync(join(resolved, "LazilyFormal"))
      ) {
        return resolved;
      }
    } catch {
      // realpath may fail on a broken/empty submodule entry — keep scanning.
    }
  }
  return null;
}

function hasLake() {
  const { error } = spawnSync("lake", ["--version"], { stdio: "ignore" });
  return error === undefined;
}

const formalDir = resolveFormalDir();

if (!formalDir) {
  console.log(
    "[formal-check] SKIP — lazily-formal submodule not present. " +
      "Clone with --recurse-submodules to enable Lean proof verification.",
  );
  process.exit(0);
}

if (!hasLake()) {
  console.log(
    "[formal-check] SKIP — `lake` (Lean toolchain) not on PATH. " +
      "Install Lean via elan (https://lean-lang.org/lean4/doc/setup.html) " +
      "to enable proof verification.",
  );
  process.exit(0);
}

process.stdout.write(`[formal-check] building lazily-formal at ${formalDir} ...\n`);

const result = spawnSync("lake", ["build"], {
  cwd: formalDir,
  stdio: "inherit",
});

if (result.error) {
  console.error("[formal-check] FAIL — could not spawn `lake build`:", result.error);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`[formal-check] FAIL — \`lake build\` exited ${result.status}.`);
  process.exit(result.status ?? 1);
}

console.log("[formal-check] OK — all Lean proofs in lazily-formal compile.");
