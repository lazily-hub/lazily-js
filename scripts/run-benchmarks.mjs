#!/usr/bin/env node
// Refresh the generated benchmark results section in BENCHMARKS.md.
//
// Mirrors lazily-rs's `scripts/update-benchmark-results.py`: runs the bench
// suite, captures mean/95%-CI per Group/Case, and rewrites the
// <!-- benchmark-results:start --> ... <!-- benchmark-results:end --> block.
//
// Usage:
//   node scripts/run-benchmarks.mjs           # run benches + refresh BENCHMARKS.md
//   node scripts/run-benchmarks.mjs --no-run  # render only from last captured JSON
//   node scripts/run-benchmarks.mjs --check   # exit 1 if BENCHMARKS.md is stale

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BENCHMARKS_MD = path.join(ROOT, "BENCHMARKS.md");
const START = "<!-- benchmark-results:start -->";
const END = "<!-- benchmark-results:end -->";

const require = createRequire(import.meta.url);
const pkg = require(path.join(ROOT, "package.json"));

const GROUP_ORDER = {
  cached_reads: 0,
  cold_first_get: 1,
  dependency_fan_out: 2,
  set_cell_invalidation: 3,
  memo_equality_suppression: 4,
  effect_flushing: 5,
  batch_storms: 6,
  typed_cache_reads: 7,
  // Phase 2 perf-win benches (#lzjsshalloweq, #lzjslazyedges): equality guard
  // on its own + per-node allocation cost at scale.
  default_equal: 8,
  node_allocation: 9,
  // CRDT-plane benches (Phase 1 #lztextordcache / #lztextinsertchain /
  // #lzopidkeytuple / #lzseqstringifyeq). Kept in regression-gated suite so
  // algorithmic regressions surface at PR time.
  textcrdt_insert_str: 10,
  textcrdt_repeated_text: 11,
  textcrdt_merge: 12,
  textcrdt_delta_sync: 13,
  seqcrdt_insert_back: 14,
  seqcrdt_merge: 15,
};

const BENCH_FILES = ["bench/context.bench.mjs", "bench/crdt.bench.mjs"];

function caseKey(group, caseLabel) {
  // Extract trailing numeric param (e.g. "context / 32" -> 32) so widths sort
  // numerically (32 before 256) instead of lexically (256 before 32).
  const m = caseLabel.match(/(\d+)\s*$/);
  const num = m ? Number(m[1]) : Number.POSITIVE_INFINITY;
  const base = m ? caseLabel.slice(0, m.index).replace(/\s*\/\s*$/, "") : caseLabel;
  return [base, num];
}

function sortByGroupThenCase(results) {
  results.sort(
    (a, b) =>
      (GROUP_ORDER[a.group] ?? 99) - (GROUP_ORDER[b.group] ?? 99) ||
      (() => {
        const [ab, an] = caseKey(a.group, a.case);
        const [bb, bn] = caseKey(b.group, b.case);
        return ab.localeCompare(bb) || an - bn;
      })(),
  );
  return results;
}

function runBenches() {
  const all = [];
  for (const file of BENCH_FILES) {
    const out = execFileSync(process.execPath, [path.join(ROOT, file)], {
      cwd: ROOT,
      maxBuffer: 1 << 30,
      env: { ...process.env, BENCH_FORMAT: "json" },
      encoding: "utf8",
    });
    const { results } = JSON.parse(out);
    all.push(...results);
  }
  return sortByGroupThenCase(all);
}

function fmt(ns) {
  if (ns == null) return "—";
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(3)} ms`;
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(3)} us`;
  return `${ns.toFixed(3)} ns`;
}

function render(results) {
  const node = process.versions.node;
  const platform = `${process.platform} ${process.arch}`;
  const lines = [];
  lines.push(`Generated for package \`${pkg.name}\` version \`${pkg.version}\`.`);
  lines.push("");
  lines.push(`Environment: Node.js \`${node}\` on \`${platform}\`.`);
  lines.push("");
  lines.push("Refresh command:");
  lines.push("");
  lines.push("```bash");
  lines.push("node scripts/run-benchmarks.mjs");
  lines.push("```");
  lines.push("");
  lines.push(
    "Mean wall-clock time per iteration; 95% CI half-width from the standard error.",
  );
  lines.push("");
  lines.push("| Group | Case | Mean | 95% CI | p75 | p99 | Samples |");
  lines.push("|---|---|---:|---:|---:|---:|---:|");
  for (const r of results) {
    lines.push(
      `| ${r.group} | ${r.case} | ${fmt(r.mean)} | ± ${fmt(r.ci)} | ${fmt(r.p75)} | ${fmt(r.p99)} | ${r.samples} |`,
    );
  }
  return lines.join("\n");
}

function refresh(results) {
  const body = render(results);
  let md = readFileSync(BENCHMARKS_MD, "utf8");
  const startIdx = md.indexOf(START);
  const endIdx = md.indexOf(END);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`missing ${START} / ${END} markers in BENCHMARKS.md`);
  }
  const next =
    md.slice(0, startIdx + START.length) +
    "\n\n" +
    body +
    "\n\n" +
    md.slice(endIdx);
  writeFileSync(BENCHMARKS_MD, next);
}

// Parse the generated table in BENCHMARKS.md into a set of "group|case" keys.
function currentRowKeys() {
  const md = readFileSync(BENCHMARKS_MD, "utf8");
  const startIdx = md.indexOf(START);
  const endIdx = md.indexOf(END);
  if (startIdx === -1 || endIdx === -1) return null;
  const section = md.slice(startIdx, endIdx);
  const keys = new Set();
  for (const line of section.split("\n")) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
    if (!m) continue;
    if (m[1] === "Group" && m[2] === "Case") continue;
    if (m[1].startsWith("---")) continue;
    keys.add(`${m[1].trim()}|${m[2].trim()}`);
  }
  return keys;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--check")) {
    // Timing numbers are non-deterministic, so the gate checks the SET of
    // group/case rows instead: BENCHMARKS.md must list exactly the rows the
    // bench suite produces (catches a new case that wasn't refreshed into the doc).
    const fresh = runBenches().map((r) => `${r.group}|${r.case}`);
    const current = currentRowKeys();
    if (current === null) {
      console.error("BENCHMARKS.md missing benchmark-results markers.");
      process.exit(1);
    }
    const missing = fresh.filter((k) => !current.has(k));
    const extra = [...current].filter((k) => !fresh.includes(k));
    if (missing.length === 0 && extra.length === 0) {
      console.error("BENCHMARKS.md row set is up to date.");
      return;
    }
    if (missing.length) console.error("missing rows:", missing);
    if (extra.length) console.error("stale rows:", extra);
    console.error("Run: node scripts/run-benchmarks.mjs");
    process.exit(1);
  }
  const results = args.includes("--no-run")
    ? [] // --no-run without captured JSON just re-renders an empty table
    : runBenches();
  refresh(results);
  console.error("Refreshed BENCHMARKS.md with %d rows.", results.length);
}

main();
