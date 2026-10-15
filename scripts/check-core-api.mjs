import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE_TYPES = path.join(ROOT, "src/core.d.ts");
const REACTIVE_TYPES = path.join(ROOT, "src/reactive.d.ts");
const SNAPSHOT = path.join(ROOT, "compat/core-api.json");
const DEPRECATIONS = path.join(ROOT, "compat/core-deprecations.json");
const PROFILE_EXPORTS = ["Computed", "Context", "Effect", "Source", "TeardownScope"];

function parse(file) {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function nameOf(node) {
  return node.name && ts.isIdentifier(node.name) ? node.name.text : null;
}

function exportedNames(source) {
  const names = [];
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause) continue;
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) names.push(element.name.text);
  }
  return names.sort();
}

function declarationIndex(source) {
  const index = new Map();
  for (const statement of source.statements) {
    const name = nameOf(statement);
    if (!name) continue;
    const declarations = index.get(name) ?? [];
    declarations.push(statement);
    index.set(name, declarations);
  }
  return index;
}

function declarationClosure(source, roots) {
  const index = declarationIndex(source);
  const pending = [...roots];
  const included = new Set();

  while (pending.length > 0) {
    const name = pending.pop();
    if (included.has(name)) continue;
    const declarations = index.get(name);
    if (!declarations) throw new Error(`Core declaration ${name} is missing from reactive.d.ts`);
    included.add(name);
    for (const declaration of declarations) {
      function visit(node) {
        if (ts.isIdentifier(node) && index.has(node.text) && !included.has(node.text)) {
          pending.push(node.text);
        }
        ts.forEachChild(node, visit);
      }
      visit(declaration);
    }
  }

  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  return Object.fromEntries(
    [...included]
      .sort()
      .map((name) => [
        name,
        index
          .get(name)
          .map((node) =>
            printer.printNode(ts.EmitHint.Unspecified, node, source).replace(/\s+/g, " ").trim(),
          ),
      ]),
  );
}

function deprecatedPaths(source, declarations) {
  const deprecated = new Set();
  for (const name of Object.keys(declarations)) {
    for (const node of declarationIndex(source).get(name) ?? []) {
      if (ts.getJSDocDeprecatedTag(node)) deprecated.add(name);
      for (const member of node.members ?? []) {
        const memberName = nameOf(member);
        if (memberName && ts.getJSDocDeprecatedTag(member)) deprecated.add(`${name}.${memberName}`);
      }
    }
  }
  return [...deprecated].sort();
}

function compareSnapshot(expected, actual) {
  assert.deepEqual(
    actual,
    expected,
    "Core API snapshot drifted; review compatibility and update intentionally",
  );
}

function validateDeprecations(metadata, discovered) {
  assert.equal(metadata.schema_version, 1);
  assert.equal(metadata.profile_id, "core-v1");
  assert.equal(metadata.core_api_generation, 1);
  assert.ok(metadata.compatibility_policy.minimum_generations >= 2);
  assert.ok(metadata.compatibility_policy.minimum_days >= 90);

  const recorded = metadata.deprecations.map(({ symbol }) => symbol).sort();
  assert.deepEqual(recorded, discovered, "Core deprecation metadata is incomplete or stale");
  assert.equal(new Set(recorded).size, recorded.length, "Core deprecation symbols must be unique");

  for (const entry of metadata.deprecations) {
    assert.equal(
      typeof entry.introduced_generation,
      "number",
      `${entry.symbol}: introduction missing`,
    );
    assert.equal(typeof entry.replacement, "string", `${entry.symbol}: replacement missing`);
    assert.ok(entry.replacement.length > 0, `${entry.symbol}: replacement is empty`);
    assert.ok(
      entry.compatibility_window.minimum_generations >= 2,
      `${entry.symbol}: window too short`,
    );
    assert.ok(
      entry.compatibility_window.minimum_days >= 90,
      `${entry.symbol}: day window too short`,
    );
    assert.ok(
      entry.earliest_removal_generation >=
        entry.deprecated_since_generation + entry.compatibility_window.minimum_generations,
      `${entry.symbol}: earliest removal violates its compatibility window`,
    );
  }
}

async function currentSnapshot() {
  const coreTypes = parse(CORE_TYPES);
  const reactiveTypes = parse(REACTIVE_TYPES);
  const typeExports = exportedNames(coreTypes);
  assert.deepEqual(
    typeExports,
    PROFILE_EXPORTS,
    "Core type facade diverges from the profile allow-list",
  );

  const runtime = await import(`${pathToFileURL(path.join(ROOT, "src/core.js")).href}?api-check`);
  const runtimeExports = Object.keys(runtime).sort();
  assert.deepEqual(
    runtimeExports,
    PROFILE_EXPORTS,
    "Core runtime facade diverges from the profile allow-list",
  );

  return {
    schema_version: 1,
    profile_id: "core-v1",
    core_api_generation: 1,
    package_entrypoint: "@lazily-hub/lazily-js/core",
    runtime_exports: runtimeExports,
    type_exports: typeExports,
    declarations: declarationClosure(reactiveTypes, typeExports),
  };
}

async function selfTest(actual, metadata, discovered) {
  const missingRuntime = structuredClone(actual);
  missingRuntime.runtime_exports.pop();
  assert.throws(() => compareSnapshot(actual, missingRuntime));

  const changedType = structuredClone(actual);
  changedType.declarations.Context[0] += " incompatible";
  assert.throws(() => compareSnapshot(actual, changedType));

  const missingDeprecation = structuredClone(metadata);
  missingDeprecation.deprecations.pop();
  assert.throws(() => validateDeprecations(missingDeprecation, discovered));
  console.log("Core API negative mutation self-tests: ok");
}

const actual = await currentSnapshot();
const reactiveTypes = parse(REACTIVE_TYPES);
const discovered = deprecatedPaths(reactiveTypes, actual.declarations);
const metadata = JSON.parse(readFileSync(DEPRECATIONS, "utf8"));
validateDeprecations(metadata, discovered);

if (process.argv.includes("--print")) {
  process.stdout.write(`${JSON.stringify(actual, null, 2)}\n`);
} else if (process.argv.includes("--self-test")) {
  await selfTest(actual, metadata, discovered);
} else {
  const expected = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  compareSnapshot(expected, actual);
  console.log(
    `Core API compatibility: ${actual.runtime_exports.length} exports, ${Object.keys(actual.declarations).length} declarations`,
  );
  console.log(`Core deprecations: ${discovered.length} structured entries`);
}
