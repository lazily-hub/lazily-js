# lazily-js Benchmark Results

Generated benchmark data for the
[`@lazily-hub/lazily-js`](https://www.npmjs.com/package/@lazily-hub/lazily-js)
reactive primitives library.

## Benchmark Results

The suite is a 1:1 port of the single-threaded `Context` benchmarks in
lazily-rs's `benches/context.rs` — the same group/case names and the same
widths/depths (`FAN_OUT_WIDTHS=[32,256]`, `MEMO_CHAIN_DEPTH=32`,
`BATCH_STORM_CELLS=64`, `SET_CELL_INVALIDATION_FAN_OUT=512`) so JS and Rust
numbers are directly comparable.

JS runs on a single event-loop thread, so the lazily-rs `ThreadSafeContext`
multi-worker contention benchmarks (`thread_safe_contention`,
`thread_safe_effect_contention`, `thread_safe_graph_propagation`) have no
like-for-like single-process counterpart here and are intentionally omitted.

<!-- benchmark-results:start -->

Generated for package `@lazily-hub/lazily-js` version `0.20.0`.

Environment: Node.js `26.4.0` on `linux x64`.

Refresh command:

```bash
node scripts/run-benchmarks.mjs
```

Mean wall-clock time per iteration; 95% CI half-width from the standard error.

| Group | Case | Mean | 95% CI | p75 | p99 | Samples |
|---|---|---:|---:|---:|---:|---:|
| cached_reads | context | 31.966 ns | ± 1.575 ns | 30.743 ns | 70.839 ns | 100 |
| cold_first_get | context | 742.710 ns | ± 126.218 ns | 612.500 ns | 1.899 us | 100 |
| dependency_fan_out | context / 32 | 6.129 us | ± 1.563 us | 5.023 us | 41.656 us | 100 |
| dependency_fan_out | context / 256 | 48.997 us | ± 3.461 us | 47.868 us | 130.607 us | 100 |
| set_cell_invalidation | high_fan_out / 512 | 5.482 us | ± 1.327 us | 6.410 us | 18.184 us | 100 |
| memo_equality_suppression | context | 2.191 us | ± 356.052 ns | 3.813 us | 4.961 us | 100 |
| effect_flushing | context | 149.841 ns | ± 15.108 ns | 148.815 ns | 452.666 ns | 100 |
| batch_storms | context / 64 | 13.088 us | ± 281.500 ns | 13.352 us | 17.526 us | 100 |
| typed_cache_reads | context_cell | 29.928 ns | ± 0.847 ns | 29.585 ns | 46.606 ns | 100 |
| typed_cache_reads | context_slot | 46.437 ns | ± 5.381 ns | 39.915 ns | 179.573 ns | 100 |
| textcrdt_insert_str | 64 | 8.939 us | ± 2.581 us | 7.678 us | 50.727 us | 100 |
| textcrdt_insert_str | 256 | 28.383 us | ± 1.991 us | 25.568 us | 63.137 us | 100 |
| textcrdt_insert_str | 1024 | 111.611 us | ± 6.489 us | 124.136 us | 205.387 us | 100 |
| textcrdt_repeated_text | 64 | 40.149 us | ± 2.146 us | 36.146 us | 74.301 us | 100 |
| textcrdt_repeated_text | 256 | 181.856 us | ± 13.068 us | 187.465 us | 331.261 us | 100 |
| textcrdt_repeated_text | 1024 | 864.585 us | ± 45.266 us | 996.343 us | 1.519 ms | 100 |
| textcrdt_merge | 64 | 12.103 us | ± 798.827 ns | 12.955 us | 24.361 us | 100 |
| textcrdt_merge | 256 | 53.192 us | ± 4.002 us | 52.265 us | 143.726 us | 100 |
| textcrdt_merge | 1024 | 270.364 us | ± 17.669 us | 268.422 us | 593.144 us | 100 |
| textcrdt_delta_sync | 64 | 19.106 us | ± 1.372 us | 20.792 us | 29.232 us | 100 |
| textcrdt_delta_sync | 256 | 67.860 us | ± 5.469 us | 62.273 us | 196.534 us | 100 |
| textcrdt_delta_sync | 1024 | 262.078 us | ± 11.701 us | 257.410 us | 473.407 us | 100 |
| seqcrdt_insert_back | 64 | 82.803 us | ± 7.276 us | 79.240 us | 226.953 us | 100 |
| seqcrdt_insert_back | 256 | 1.561 ms | ± 57.393 us | 1.724 ms | 2.313 ms | 100 |
| seqcrdt_insert_back | 1024 | 43.643 ms | ± 971.721 us | 44.688 ms | 50.468 ms | 20 |
| seqcrdt_merge | 64 | 7.361 us | ± 624.875 ns | 8.053 us | 19.173 us | 100 |
| seqcrdt_merge | 256 | 26.977 us | ± 2.251 us | 30.373 us | 73.848 us | 100 |
| seqcrdt_merge | 1024 | 113.428 us | ± 6.981 us | 121.168 us | 252.144 us | 100 |

<!-- benchmark-results:end -->

## Suite

| Group | Case | Parity with lazily-rs | What it measures |
|-------|------|-----------------------|------------------|
| `cached_reads` | `context` | `bench_cached_reads` / context | Steady-state cached `ctx.get(slot)` (no recompute). |
| `cold_first_get` | `context` | `bench_cold_first_get` / context | First (uncached) read of a freshly built slot. |
| `dependency_fan_out` | `context / {32,256}` | `bench_dependency_fan_out` / context | One root cell invalidates N dependents, then all are re-read. |
| `set_cell_invalidation` | `high_fan_out / 512` | `bench_set_cell_invalidation` / high_fan_out | Cost of `setCell` invalidating a 512-wide fan-out (no recompute). |
| `memo_equality_suppression` | `context` | `bench_memo_equality_suppression` / context | Memo chain that stays equal downstream (guard suppresses recompute). |
| `effect_flushing` | `context` | `bench_effect_flushing` / context | Effect re-runs on every cell change. |
| `batch_storms` | `context / 64` | `bench_batch_storms` / context | Coalesced batched writes to 64 cells (one effect flush). |
| `typed_cache_reads` | `context_slot`, `context_cell` | `bench_typed_cache_reads` / context_* | Direct `ctx.get(slot)` vs `ctx.getCell(cell)`. |

### Running

```bash
npm run bench                 # run the suite, print a markdown table
node scripts/run-benchmarks.mjs        # run + refresh this file
node scripts/run-benchmarks.mjs --check # CI gate: exit 1 if stale
make bench                   # via the Makefile
```

### Harness

`bench/harness.mjs` is a zero-dependency criterion-style harness
(`node:perf_hooks` only). It offers two measurement modes:

- **`bench(group, case, fn)`** — auto-batched timing for *idempotent* routines
  (each sample times N calls, N auto-scaled so one sample lasts ~5 ms). Use for
  steady-state reads / repeated-equal-cost work.
- **`bench.batched(group, case, setup, routine)`** — `iter_batched` timing
  (criterion `BatchSize::SmallInput`): fresh `setup()` before every single
  measured call, setup excluded from timing. Use when the operation mutates graph
  state a second call would skip — e.g. the `==` guard on `setCell`, or a cold
  first read that caches on first access.

### Regression workflow

```bash
node scripts/run-benchmarks.mjs            # record "before" baseline in BENCHMARKS.md
# apply the performance patch
node scripts/run-benchmarks.mjs            # compare against the new numbers
```

## Scale (≥1M cells) — spreadsheet-shaped graph

A second suite ([`bench/scale.bench.mjs`](bench/scale.bench.mjs)) replicates the
lazily-rs [`scale`](https://github.com/lazily-hub/lazily-rs/blob/main/benches/scale.rs)
group, the lazily-go `scale` group, and lazily-py's
[`scale_bench.py`](https://github.com/lazily-hub/lazily-py/blob/main/src/lazily/scale_bench.py)
on a **spreadsheet-shaped** graph: `N` input cells + `N` formula slots where
`formula[i] = input[i] + input[i - 1]` (local fan-in, like a column of
`=A_i + A_{i-1}`). With the default `N = 1,000,000` that is **~2,000,000
reactive nodes**. Four scenarios cover the spreadsheet lifecycle:

- `build` — construct all `2N` nodes (formulas lazy, not yet computed).
- `cold_full_recalc` — first read of every formula (forces every compute + edge-tracking).
- `viewport_recalc` — edit one input, read only a 1,000-cell viewport (the
  lazy-pull win: off-viewport formulas stay dirty and never recompute).
- `full_recalc_invalidate_all` — re-set every input, then read every formula
  (worst-case full-sheet edit).

> **A "cell count" here counts two cells per row** — the graph models a column of
> formulas `=A_i + A_{i-1}`, so each row is **one input cell `A_i` plus one
> formula cell**. `N` rows ⇒ `N` inputs + `N` formulas = `2N` cells.

Timings use `performance.now()` (`node:perf_hooks`); single wall-clock run per
scenario. Lower is better. Treat the absolute numbers as indicative — the shapes
(relative costs, size-scaling behavior) are what transfer across runs and hosts.

### Reproduce

```bash
make bench-scale                                    # scale suite at N = 1,000,000
node bench/scale.bench.mjs                          # same, directly

# scale at a specific size / viewport:
LAZILY_SCALE_N=1000000 node bench/scale.bench.mjs
LAZILY_SCALE_N=5000000 node bench/scale.bench.mjs   # Google Sheets 10M-cell workbook
LAZILY_SCALE_VIEWPORT=1000 node bench/scale.bench.mjs
BENCH_FORMAT=json node bench/scale.bench.mjs        # machine-readable output
```

Large `N` needs headroom for the V8 heap — run with
`node --max-old-space-size=8192 bench/scale.bench.mjs` at 1M and `16384` at 5M.

### Hardware / environment

| | |
|---|---|
| CPU | AMD Ryzen 9 9950X3D (16 cores / 32 threads) |
| RAM | 186 GiB |
| OS | Linux 7.1.3 (CachyOS), x86-64 |
| Node.js | 26.4.0 (V8) |

### 1,000,000 rows (~2M cells / nodes)

Peak RSS ~1.0 GiB (~550 B/node).

| Benchmark | Time | Per cell | What it measures |
|-----------|-----:|---------:|------------------|
| `build` | ~0.90 s | ~450 ns | Construct all 2N nodes (each `Cell`/`Slot` allocates its own dependency structures — allocation- and GC-bound under V8). |
| `cold_full_recalc` | ~0.65 s | ~650 ns | First read of every formula — forces every compute + edge-tracking. |
| `viewport_recalc` | **~100 µs** | — | Edit one input, read only a 1,000-cell viewport. ~6,500× cheaper than a full cold recalc. |
| `full_recalc_invalidate_all` | ~1.30 s | ~1.30 µs | Re-set every input, then recompute the whole sheet (worst-case full-sheet edit). |

### 5,000,000 rows (10M cells — a full Google Sheets workbook)

Google Sheets caps a workbook at **10,000,000 cells**. Modeled as 5,000,000
input cells + 5,000,000 formula cells (`LAZILY_SCALE_N=5000000`). This is the
**largest size actually measured** — no extrapolation. Peak RSS ~5.0 GiB.

| Benchmark | Time | Per cell | What it measures |
|-----------|-----:|---------:|------------------|
| `build` | ~6.56 s | ~656 ns | Build the full 10M-node workbook (allocation/GC-bound). |
| `cold_full_recalc` | ~3.37 s | ~674 ns | Compute all 5M formulas cold. |
| `viewport_recalc` | **~106 µs** | — | Edit one input, read a 1,000-cell viewport. ~31,800× cheaper than a full cold recalc. |
| `full_recalc_invalidate_all` | ~7.38 s | ~1.48 µs | Re-set every input, recompute the whole workbook. |

So lazily-js backs a **full-capacity Google Sheets workbook** on V8: building it
is the expensive part (~6.6 s, allocation/GC-bound — one JS object graph per
node), but once built, a full cold recompute is ~3.4 s, and a one-cell edit +
bounded-viewport read stays in the **~100 µs range**. The lazy pull-based model
leaves off-viewport formulas dirty and never recomputes them — only ~2 formulas
actually recompute per edit (the two that read the edited input), regardless of
sheet size, which is exactly the property a viewport-rendered spreadsheet needs.

### Spreadsheet cell-count context

| Spreadsheet | Documented limit | Cells |
|-------------|------------------|------:|
| Google Sheets | 10,000,000 cells per workbook (18,278 columns max) | 10,000,000 |
| Microsoft Excel | 1,048,576 rows × 16,384 columns per worksheet | 17,179,869,184 |

The `LAZILY_SCALE_N=5000000` run above covers a full Google Sheets workbook. A
grid-complete Excel worksheet (17 billion cells) is unrepresentative — real
sheets populate a tiny fraction of the grid, and lazily only stores the cells you
create, so the `scale` group measures the populated-cell path that matters.

### Viewport scaling — flat

lazily-js's viewport recalc is **effectively size-independent** (~100 µs at 2M
nodes, ~106 µs at 10M nodes). The value cache is keyed by node identity, so both
the ~1,000 viewport cache-hit reads and the ~2 actual recomputes are O(1) map
operations that don't scale with total sheet size. This matches lazily-rs's and
lazily-py's flat curves. At 10M cells a one-cell edit + 1,000-cell viewport read
is ~31,800× cheaper than a full cold recalc and never touches off-viewport
formulas.

### Cross-language honesty

V8 is heavier per node than compiled Rust (lazily-rs builds the same 2M-node
graph in ~0.1 s vs ~0.9 s here) but far lighter than CPython (lazily-py's build
is ~10.6 s at 1M). The recompute paths (`cold_full_recalc` ~650 ns/formula) are
JIT-compiled and closer to the compiled bindings. These numbers are reported
honestly, not to claim parity — the transferable result is the **shape**: the
lazy-pull viewport property holds identically across all bindings (a one-cell
edit + bounded-viewport read is microseconds, independent of sheet size).
