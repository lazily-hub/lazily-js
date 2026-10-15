import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import * as core from "../src/core.js";
import * as reactive from "../src/reactive.js";

const ROOT = path.resolve(import.meta.dirname, "..");

test("the Core facade preserves reactive public identities", () => {
  for (const name of ["Context", "Source", "Computed", "Effect", "TeardownScope"]) {
    assert.equal(core[name], reactive[name], `${name} must be the existing reactive export`);
  }
});

test("the published package contains the Core facade and metadata", () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(manifest.exports?.["./core"], {
    types: "./src/core.d.ts",
    default: "./src/core.js",
  });

  const packReport = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: ROOT,
      encoding: "utf8",
    }),
  );
  // npm returns an array; Bun's npm-compatible frontend keys the same report
  // by package name. Normalize both package-manager shapes before asserting.
  const packed = Array.isArray(packReport) ? packReport : Object.values(packReport);
  assert.equal(packed.length, 1, "npm pack must describe exactly one package");
  const files = new Set(packed[0].files.map(({ path: entry }) => entry));
  for (const entry of ["src/core.js", "src/core.d.ts", "LICENSE", "NOTICE", "README.md"]) {
    assert.ok(files.has(entry), `packed npm artifact is missing ${entry}`);
  }
});
