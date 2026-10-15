#!/usr/bin/env node
// Execute the Core fixture runner and emit a fail-closed evidence report.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

import { killRoute, pointerEscape } from "./core-negative-control.mjs";

const BINDING_ID = "javascript";
const ROOT = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const RUNNER = [
  process.execPath,
  "--require",
  "./test/support/conformance-manifest.cjs",
  "--test",
  "test/reactive-graph-conformance.test.js",
];

function fail(message) {
  throw new Error(`core conformance: ${message}`);
}

function requiredPath(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is required`);
  return resolve(value);
}

function runRunner(corpus, scratch, observation = null) {
  const runId = `core-${process.pid}-${Date.now()}`;
  const env = {
    ...process.env,
    LAZILY_SPEC_CONFORMANCE_DIR: corpus,
    LAZILY_CONFORMANCE_RUN_ID: runId,
    LAZILY_CONFORMANCE_MANIFEST: join(scratch, "fixtures.txt"),
    LAZILY_CONFORMANCE_KEY_MANIFEST: join(scratch, "keys.txt"),
    LAZILY_CONFORMANCE_BLOCK_MANIFEST: join(scratch, "blocks.txt"),
    LAZILY_CONFORMANCE_SCENARIO_MANIFEST: join(scratch, "scenarios.txt"),
  };
  delete env.LAZILY_CORE_REACTIVE_REPORT_PATH;
  for (const name of ["fixtures.txt", "keys.txt", "blocks.txt", "scenarios.txt"]) {
    writeFileSync(join(scratch, name), `# lazily-run-id ${runId}\n`);
  }
  if (observation !== null) {
    writeFileSync(observation, "");
    env.LAZILY_CORE_REACTIVE_REPORT_PATH = observation;
  }
  return spawnSync(RUNNER[0], RUNNER.slice(1), {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout: 120_000,
  });
}

function fixtureDigest(profile, corpus) {
  const digest = createHash("sha256");
  for (const fixture of profile.required_fixtures) {
    const path = join(corpus, fixture.path);
    if (!existsSync(path)) fail(`required fixture is absent: ${path}`);
    digest.update(fixture.path);
    digest.update("\0");
    digest.update(readFileSync(path));
  }
  return digest.digest("hex");
}

function main() {
  const profilePath = requiredPath("LAZILY_CORE_PROFILE_PATH");
  const specRoot = requiredPath("LAZILY_CORE_SPEC_ROOT");
  const reportPath = requiredPath("LAZILY_CORE_REPORT_PATH");
  const reportsRoot = requiredPath("LAZILY_CORE_REPORTS_ROOT");
  if ((process.env.LAZILY_CORE_BINDING_ID ?? BINDING_ID) !== BINDING_ID) {
    fail("LAZILY_CORE_BINDING_ID does not name javascript");
  }

  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  if (!profile.bindings.some((item) => item.id === BINDING_ID)) {
    fail("profile does not contain the javascript binding");
  }
  const corpus = join(specRoot, "conformance");
  const observedDigest = fixtureDigest(profile, corpus);
  if (observedDigest !== profile.fixture_corpus.digest) {
    fail("Core fixture corpus digest does not match the profile");
  }

  const schemaDirectoryName = basename(dirname(profile.$schema));
  process.env.LAZILY_SPEC_SCHEMAS_DIR = join(specRoot, schemaDirectoryName);
  const { schemaPath } = require("../test/spec-corpus.cjs");
  const assertionSchema = JSON.parse(readFileSync(schemaPath("assertion-blocks.json"), "utf8"));
  const routes = new Map(profile.required_fixtures.map((fixture) => [fixture.path, []]));
  for (const route of assertionSchema["x-fixture-routes"]) {
    if (routes.has(route.fixture)) routes.get(route.fixture).push(route.pointer);
  }

  const scratch = mkdtempSync(join(tmpdir(), "lazily-core-javascript-"));
  try {
    const observation = join(scratch, "reactive-runs.jsonl");
    const baseline = runRunner(corpus, scratch, observation);
    if (baseline.status !== 0) {
      process.stderr.write(baseline.stdout ?? "");
      process.stderr.write(baseline.stderr ?? "");
      fail("baseline Core fixture runner failed");
    }
    const records = readFileSync(observation, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const expectedModels = ["AsyncContext", "Context", "ThreadSafeContext"];
    if (
      JSON.stringify(records.map((record) => record.model).sort()) !==
      JSON.stringify(expectedModels)
    ) {
      fail("runner did not report all three execution flavors");
    }

    const evidenceDir = join(reportsRoot, BINDING_ID);
    mkdirSync(evidenceDir, { recursive: true });
    const claims = {};
    const fixtures = [];
    const runtimeSkips = [];

    for (const required of profile.required_fixtures) {
      const rel = required.path;
      const name = rel.split("/").at(-1);
      const executed = records
        .filter((record) => record.replayed.includes(name))
        .map((record) => record.model)
        .sort();
      const skipped = records
        .filter((record) => `${record.model}/${name}` in record.skipped)
        .map((record) => [record.model, record.skipped[`${record.model}/${name}`]])
        .sort(([left], [right]) => left.localeCompare(right));
      const status =
        executed.length === records.length ? "passed" : executed.length > 0 ? "partial" : "skipped";
      if (skipped.length > 0) {
        if (executed.length !== 0) fail(`${rel} has an undeclared partial execution-flavor gap`);
        runtimeSkips.push({
          fixture: rel,
          scenario: "*",
          reason: [...new Set(skipped.map(([, reason]) => reason))].sort().join("; "),
        });
      }

      const assertionBlocks = [];
      if (executed.length > 0) {
        for (const route of routes.get(rel)) {
          const kill = killRoute({
            corpus,
            rel,
            route,
            mutationRoot: join(scratch, "mutant"),
            runner: (root) => runRunner(root, scratch),
            fail,
          });
          const claimId = `${rel}#${route}`;
          claims[claimId] = {
            status: "mutation-killed",
            models: executed,
            ...kill,
            runner: RUNNER,
          };
          assertionBlocks.push({
            id: route,
            consumed: true,
            discriminability_evidence: `${BINDING_ID}/assertion-evidence.json#/claims/${pointerEscape(claimId)}`,
          });
        }
      }

      fixtures.push({
        path: rel,
        scenario_ids: executed.length > 0 ? required.scenario_ids : [],
        proof_classes: required.proof_classes,
        assertion_blocks: assertionBlocks,
        status,
      });
    }

    writeFileSync(
      join(evidenceDir, "assertion-evidence.json"),
      `${JSON.stringify({ schema_version: 1, binding_id: BINDING_ID, claims }, null, 2)}\n`,
    );
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(
      reportPath,
      `${JSON.stringify(
        {
          schema_version: 1,
          profile_id: profile.profile_id,
          binding_id: BINDING_ID,
          fixture_corpus_digest: observedDigest,
          fixtures,
          runtime_skips: runtimeSkips,
          fixtureless_claims: [],
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main();
