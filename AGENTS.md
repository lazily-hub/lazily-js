# lazily-js

JavaScript / Node.js port of the lazily reactive-signals family.

## Architecture — the Cell kernel (`#lzcellkernel`)

`src/reactive.js` is the reactive graph. It follows the Cell kernel design
(`tasks/software/lazily-cell-kernel-design.md` + naming v2): `Cell` is the
value-node *concept* over two value kinds; the bare kind name is the **handle** a
caller holds. `Effect` is a value-less sink outside the hierarchy.

- `Source` (v1 `SourceCell`) — written from outside; exposes `get`/`set`/`merge`.
  `ctx.source(v)` is keep-latest; `ctx.source(v, policy)` folds `.merge` under an
  associative `MergePolicy` (a keep-latest `Source` is the plain cell, so `Source`
  subsumes the former `MergeCell`).
- `Computed` (v1 `FormulaCell`) — computed from upstream; exposes `get` and no
  `set`/`merge`. `ctx.computed(f)` is **always guarded** (an equal recompute
  suppresses downstream; matches TC39 `Signal.Computed`). There is no unguarded
  mode, and `memo` is removed (folded into guarded `computed`).
- `Effect` (v1 `EffectHandle`) — a sink; reads nothing, depended on by nothing.

**Unified shared reads (`#lzrsgetarc`).** JavaScript object values are references,
so the single `Context.get` / tracked compute `get` surface is naturally the
shared-reference read for both `Source` and `Computed`: it returns the same
current object, refreshes computeds identically, and registers the same tracked
edge, with no clone-bearing alternate API. This realizes the
`Reactive.readShared_eq_readCell`, `Reactive.trackedSharedRead_eq_trackedRead`,
and `Reactive.trackedSharedRead_registers_edge` formal pins.

**Read/write split without a compile guarantee.** JavaScript has neither a
compile-time nor (by design §4) a runtime kind gate, so the split is expressed by
METHOD PRESENCE: a `Source` object has `set`/`merge`; a `Computed` object does not
(`computed.set` is `undefined`). No panic is invented.

**Eager = an eager computed, not a kind (`computed(f).eager()`).** `.eager()`
attaches a puller `Effect` that keeps the computed materialized; it is idempotent
and returns the SAME handle. `.lazy()` reverts, `.isEager()` queries. Eagerness is
graph state — the `F_EAGER` bit on the computed's node plus the `eagerBy` side
table (computed id → puller effect id), cleared on `.lazy()`/dispose. Because the
puller is a scheduled effect, invalidations coalesce, so the `#lzsignaleager`
per-write-puller bug is structurally unwritable. This retires `Signal`; the former
`SignalHandle` and `ctx.signal()` remain only as deprecated compatibility for the
thread-safe / async contexts (which keep their own signal handles for now,
mirroring lazily-rs) and `state-machine`.

v2 retired the `SourceCell`/`FormulaCell`/`CellHandle`/`SlotHandle`/`EffectHandle`
handle names, the `formula`/`memo` constructors, and the unguarded `computed`. The
`cell`/`slot` constructors remain as deprecated aliases (→ `source`/`computed`);
the `.d.ts` keeps type-only `CellHandle`/`SlotHandle`/`EffectHandle` aliases for
peripheral modules during the staged family-wide rename. The storage `id`/arena
vocabulary is unchanged.

## Commit & Push

Commit and push completed work at the end of every turn that changed code,
tests, docs, or fixtures — do not leave finished work uncommitted. Run `make
check` first and ensure it is green; stage only the files that belong to the
change (never secrets or private customer names — see the workspace
`runbooks/private-name-hygiene.md`); write a concise commit message in the
repo's existing style; push to the current branch on `origin`. This standing
rule overrides the harness default of "commit only when explicitly asked" for
this repo.

<!-- tsift:code-navigation v=0.1.80 -->
## Code Navigation

Run `tsift status` at session start from the owning repo root. If the task or file lives under a git submodule (for example `src/tsift/...`), switch to that submodule root first so the harness loads the narrower local instructions and repo state instead of the superproject root. If status prints a `run:` recommendation for stale or missing tsift state, run `tsift status --fix` before relying on tsift results; when the harness cannot perform write commands, ask the user to run the printed command instead.

Prefer tsift envelopes over raw reads:
- `tsift --envelope search <query>` instead of `grep`/`rg`
- `tsift --envelope source-read <file>` / `tsift --envelope symbol-read <symbol>` instead of `cat`/`head`
- `tsift --envelope explain <symbol>` and `tsift graph <symbol> --callers` / `--callees` for call graphs
- `tsift diff-digest [path]` instead of `git diff`, `git show`, or patch-style `git log`
- `tsift --envelope session-review <path>` / `tsift --envelope context-pack <path>` instead of replaying long session docs, transcripts, or runtime logs
- `tsift --envelope digest-runner --kind test|log --path . --shell-command '<command>'` instead of raw test/build output

Command detail lives in [`runbooks/code-navigation.md`](runbooks/code-navigation.md) — budgets, `tsift workflow search`, `report.scale_guard` handling, the harness rewrite path for `PreToolUse`-less harnesses, and Codex/OpenCode integration. `tsift init` writes and versions that runbook alongside this block, so it is present in every initialized checkout; read it before broad exploration instead of expanding this block. A repository that also ships a current `.claude/skills/tsift/SKILL.md` should use that skill as the deeper source.

For local verification, run `make check` before committing. After local changes, check the latest GitHub Actions CI run with `gh run list --workflow CI --limit 1` and fix any failing tests before calling the work complete.

Only read full source files when tsift results are insufficient.
<!-- /tsift:code-navigation -->
