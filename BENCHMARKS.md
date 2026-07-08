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
