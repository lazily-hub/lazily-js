// `#lzjsoptionalpeers`: pin the manifest's runtime dependency surface.
//
// `src/ffi-node.js` has always said koffi is optional -- it `require`s it inside
// a try/catch and its error message tells the caller to `npm i koffi` -- while
// `package.json` declared it a hard `dependencies` entry, so every consumer of
// the reactive core installed a native FFI addon. `protobufjs` was the same
// shape one step further out: nothing under `src/` imports it, only
// `build/generated/graph-boundary.js` does, reached solely through the
// `./protobuf-graph-boundary` export subpath.
//
// Both are now optional peers (npm does not auto-install a peer marked
// optional). This test asserts that from the sources rather than from prose:
// the set of bare package specifiers the shipped code imports must EQUAL the set
// the manifest declares optional, in both directions. A new bare import that
// nobody declared reddens here, and so does a declaration nothing imports.
//
// The scan carries its own floors, because a scanner that lost the tree would
// otherwise report "no undeclared imports" over nothing and read as green.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCANNED_ROOTS = ["src", path.join("build", "generated")];

// Every npm package the shipped code may import at runtime. Each one must be an
// optional peer, and each must actually be imported -- see both directions below.
const OPTIONAL_RUNTIME_PEERS = ["koffi", "protobufjs"];

// Specifier prefixes resolved by a host runtime rather than installed from a
// registry. `bun:ffi` is Bun's own FFI module, imported dynamically by
// `src/shm-backend.js` alongside the koffi (Node) and Deno branches.
const PLATFORM_PREFIXES = ["node:", "bun:", "deno:"];

// Floors. A scan that matched nothing must fail rather than pass vacuously.
const MIN_SCANNED_SOURCES = 40;
const MIN_BARE_IMPORT_SITES = 3;

function sources() {
  const files = [];
  for (const root of SCANNED_ROOTS) {
    const abs = path.join(ROOT, root);
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith(".js")) files.push(full);
      }
    };
    walk(abs);
  }
  return files;
}

// Comments have to go first: `src/state-projection.js` carries a JSDoc example
// importing `@lazily-hub/js/state-projection`, which is documentation, not a
// dependency.
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const SPECIFIER =
  /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)["'](?<spec>[@A-Za-z][\w.@/:-]*)["']/g;

function packageOf(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

function scan() {
  const files = sources();
  const byPackage = new Map();
  let sites = 0;
  for (const file of files) {
    const text = stripComments(readFileSync(file, "utf8"));
    for (const match of text.matchAll(SPECIFIER)) {
      const spec = match.groups.spec;
      if (spec.startsWith(".")) continue;
      if (PLATFORM_PREFIXES.some((prefix) => spec.startsWith(prefix))) continue;
      sites += 1;
      const pkg = packageOf(spec);
      if (!byPackage.has(pkg)) byPackage.set(pkg, new Set());
      byPackage.get(pkg).add(path.relative(ROOT, file));
    }
  }
  return { files, byPackage, sites };
}

const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

test("the import scan actually reads the shipped sources", () => {
  const { files, sites } = scan();
  assert.ok(
    files.length >= MIN_SCANNED_SOURCES,
    `scanned only ${files.length} source file(s) under ${SCANNED_ROOTS.join(", ")}; ` +
      `expected at least ${MIN_SCANNED_SOURCES}. The walk lost the tree, so every ` +
      `"no undeclared import" result below would be vacuous.`,
  );
  assert.ok(
    sites >= MIN_BARE_IMPORT_SITES,
    `found only ${sites} bare import site(s); expected at least ` +
      `${MIN_BARE_IMPORT_SITES}. The specifier match stopped firing.`,
  );
});

test("no hard runtime dependencies are declared", () => {
  const declared = Object.keys(manifest.dependencies ?? {});
  assert.deepEqual(
    declared,
    [],
    `package.json declares hard runtime dependencies: ${declared.join(", ")}. ` +
      `A consumer of the reactive core installs every one of them. Move each to ` +
      `peerDependencies with peerDependenciesMeta.<name>.optional = true, or add ` +
      `it to OPTIONAL_RUNTIME_PEERS here with a reason if it is genuinely required.`,
  );
});

test("every imported package is declared an optional peer", () => {
  const { byPackage } = scan();
  const imported = [...byPackage.keys()].sort();
  const expected = [...OPTIONAL_RUNTIME_PEERS].sort();
  const undeclared = imported.filter((pkg) => !expected.includes(pkg));
  const unimported = expected.filter((pkg) => !imported.includes(pkg));
  assert.deepEqual(
    undeclared,
    [],
    `the shipped code imports package(s) that are not declared optional peers: ` +
      undeclared.map((pkg) => `${pkg} (${[...byPackage.get(pkg)].join(", ")})`).join("; "),
  );
  // The other direction is what keeps the check honest: a name pinned here that
  // nothing imports means a rename could leave a real dependency unmeasured.
  assert.deepEqual(
    unimported,
    [],
    `OPTIONAL_RUNTIME_PEERS names package(s) nothing imports: ${unimported.join(", ")}. ` +
      `Remove them, or the set equality above stops measuring the real surface.`,
  );
});

test("each optional peer is declared optional, and available for our own tests", () => {
  for (const pkg of OPTIONAL_RUNTIME_PEERS) {
    assert.ok(
      manifest.peerDependencies?.[pkg],
      `${pkg} is imported by the shipped code but absent from peerDependencies`,
    );
    assert.equal(
      manifest.peerDependenciesMeta?.[pkg]?.optional,
      true,
      `${pkg} must carry peerDependenciesMeta.${pkg}.optional = true; without it npm ` +
        `auto-installs the peer and the dependency is not optional in practice`,
    );
    assert.ok(
      manifest.devDependencies?.[pkg],
      `${pkg} must stay in devDependencies so this repo's own suite still exercises ` +
        `the code path that imports it`,
    );
  }
});
