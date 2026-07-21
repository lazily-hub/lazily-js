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

<!-- tsift:code-navigation v=0.1.77 -->
## Code Navigation

Keep this block self-contained for Codex/OpenCode prompt reuse. If this repository also ships current `.claude/skills/tsift/SKILL.md` or `runbooks/code-navigation.md`, use those deeper runbooks for command detail instead of expanding this block.

Run `tsift status` at session start from the owning repo root. If the task or file lives under a git submodule (for example `src/tsift/...`), switch to that submodule root first so the harness loads the narrower local instructions and repo state instead of the superproject root. If status prints a `run:` recommendation for stale or missing tsift state, run `tsift status --fix` before relying on tsift results; when the harness cannot perform write commands, ask the user to run the printed command instead. Codex projects can install a prompt-time auto-reindex hook with `tsift init --codex`; OpenCode projects can install per-project tsift command shortcuts with `tsift init --opencode`.

Use the commands listed in its `use:` output:
- `tsift --envelope source-read <file> --budget normal` — AST-symbol projection with span metadata and source-window expansion commands (prefer over cat/head for source code files)
- `tsift --envelope symbol-read <symbol> --budget normal` — token-budgeted symbol body, AST span metadata, child refs, and graph/source expansion commands
- `tsift --envelope search <query> --budget normal` — AST-aware hybrid search preview (prefer over grep/rg)
- `tsift --envelope explain <symbol> --budget normal` — callers, callees, community preview
- `tsift graph <symbol> --callers` / `--callees` — call graph navigation
- `tsift summarize <symbol>` — cached summary (only when listed in `use:`)
- `tsift workflow search` — ordered exact/search/explain/summarize/digest recipe that preserves result handles across expansions

When a search envelope includes `report.scale_guard`, run one of its `narrow_commands` before dispatching parallel agents. The guard means the original result set or corpus is broad enough that fan-out should start from a narrower cited handle, path, or exact query.

Prefer bounded digest commands over raw transcript, diff, and verbose-log reads:
- `tsift --envelope session-review <path> --next-context --budget normal` or `tsift --envelope context-pack <path> --budget normal` instead of replaying long session docs, JSONL transcripts, or agent-doc runtime logs with `cat`, `tail`, or `sed`.
- `tsift diff-digest [path]` (`--cached`, `--revision <rev>`) instead of `git diff`, `git show`, or patch-style `git log`.
- `tsift --envelope digest-runner --kind test --path . --shell-command '<test command>'` / `tsift --envelope digest-runner --kind log --path . --shell-command '<build command>'` for noisy test/build/install output, or let the rewrite/hooks create those artifact-backed envelopes for `cargo test`, `pytest`, and verbose cargo commands.
- If RTK is installed, digest-runner delegates supported generic command families through `rtk rewrite` and records the chosen compact filter in `report.filter` while preserving tsift artifact handles.
- Codex, OpenCode, and other harnesses without Claude-style `PreToolUse` hooks should run `tsift rewrite --run '<command>'` before broad `rg`/recursive grep, raw transcript/session/log reads, `git diff`/`git show`/single-patch `git log`, `cargo test`/`pytest`, and cargo build/check/clippy/install commands so the same search, session-digest, diff-digest, and digest-runner rewrites apply manually. OpenCode can install this path as `/tsift-rewrite-run` with `tsift init --opencode`.

For local verification, run `make check` before committing. After local changes, check the latest GitHub Actions CI run with `gh run list --workflow CI --limit 1` and fix any failing tests before calling the work complete.

Only read full source files when tsift results are insufficient.
<!-- /tsift:code-navigation -->
