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

Generated for package `@lazily-hub/lazily-js` version `0.6.0`.

Environment: Node.js `26.4.0` on `linux x64`.

Refresh command:

```bash
node scripts/run-benchmarks.mjs
```

Mean wall-clock time per iteration; 95% CI half-width from the standard error.

| Group | Case | Mean | 95% CI | p75 | p99 | Samples |
|---|---|---:|---:|---:|---:|---:|
| cached_reads | context | 57.798 ns | ± 20.941 ns | 46.398 ns | 124.744 ns | 100 |
| cold_first_get | context | 669.220 ns | ± 8.630 ns | 670.000 ns | 802.610 ns | 100 |
| dependency_fan_out | context / 32 | 7.448 us | ± 824.968 ns | 6.783 us | 34.205 us | 100 |
| dependency_fan_out | context / 256 | 43.766 us | ± 1.064 us | 43.270 us | 49.513 us | 100 |
| set_cell_invalidation | high_fan_out / 512 | 10.737 us | ± 376.524 ns | 10.113 us | 17.141 us | 100 |
| memo_equality_suppression | context | 2.387 us | ± 193.801 ns | 2.310 us | 2.864 us | 100 |
| effect_flushing | context | 211.187 ns | ± 20.150 ns | 221.482 ns | 524.491 ns | 100 |
| batch_storms | context / 64 | 30.430 us | ± 1.295 us | 30.815 us | 49.775 us | 99 |
| typed_cache_reads | context_cell | 31.325 ns | ± 1.052 ns | 30.255 ns | 58.102 ns | 100 |
| typed_cache_reads | context_slot | 120.262 ns | ± 4.805 ns | 118.099 ns | 220.409 ns | 100 |

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
