#!/usr/bin/env bash
# CI-reachability guard (#lzcheckcireachguard).
#
# Fails the build when `make check` runs a gate that CI never reaches. That is the
# drift this guard exists for: someone adds a target to `check`, it passes locally
# forever, and no CI job ever executes it — which is exactly how #lzinteroppeerci
# happened. The interop peer, the single cross-binding wire-compatibility gate, was
# in every binding's `check` and in no binding's workflow, for months.
#
# It also exists because the obvious hand-audit is WRONG. Grepping the workflows
# for "make check" reported all nine bindings as covered; every one of those hits
# was a COMMENT. Comments are the reason this is a script and not a convention:
# only `run:` bodies count here, and comment lines inside them are stripped before
# anything is matched.
#
# WHAT IT PROVES
#
#   For every target in `check`'s prerequisite closure, at least one CI `run:`
#   step invokes the same program with the same distinguishing flags.
#
# WHAT IT DOES NOT PROVE
#
#   That CI runs it against the same inputs, in the same environment, or that the
#   command means the same thing there. Reach is a floor, not equivalence. The
#   sibling guards (conformance-coverage, assertion-keys, scenario-coverage) are
#   what prove a run examined anything.
#
# HOW A TARGET IS MATCHED
#
#   Recipes are read through `make -n`, so make variables are already expanded and
#   we compare real command lines rather than source text. `make -p` is
#   deliberately NOT used: it dumps the entire environment to stdout, which would
#   print every secret in the job's env into the CI log.
#
#   Each command is split on the shell's sequencing operators, redirections are
#   dropped, and the remainder is reduced to an ANCHOR: the program basename plus
#   its subcommands and flag NAMES (values dropped), with path arguments reduced to
#   basenames and bare path globs discarded. A target is reached when EVERY one of
#   its anchors is a subsequence of a command in THE ONE CI STEP THAT TARGET IS
#   PINNED TO (see THE STEP MAP below), or when CI runs `make <target>` directly.
#   Every, not any: a target that runs two gates and is half-covered by CI is a
#   gap, and "any" would report it green.
#
#   Keeping flag names in the anchor is what makes the guard falsifiable rather
#   than decorative: `go test -race` does not match a CI step that only runs
#   `go test -count=1`, so dropping the race job reddens this guard instead of
#   being absorbed by the plain test job.
#
#   An argument that is still a VARIABLE reference at this point — `$MANIFEST` in
#   a CI step, or a `$$VAR` a recipe leaves for the shell — names a value the
#   guard cannot resolve, so it becomes a WILDCARD matching exactly one token on
#   the other side (#lzcireachvaranchor). Make and CI routinely spell the same
#   path differently, one through an expanded `$(VAR)` and the other through the
#   environment, and they are the same command. Dropping the token instead, which
#   is what this used to do, lost the argument as well as its value and reported
#   a step that genuinely ran the gate as unreachable — a false RED that cost one
#   binding a hardcoded second spelling of the path plus a hand-written equality
#   assertion, which is a new drift surface invented to satisfy a guard whose job
#   is detecting drift. Arity still counts: `script.sh $A` does not match a CI
#   step that passes no argument at all.
#
#   Commands whose program is a shell builtin or a plain file/text utility carry no
#   gate, so they contribute no anchor. A target with no non-trivial command at all
#   (a mkdir-only reset step, say) is reported as carrying no gate and is not
#   required to appear in CI. It cannot fail a build, so it cannot hide one.
#
# THE EXCUSE LIST IS THE OTHER HALF OF THE DELIVERABLE
#
#   scripts/ci-reach.conf names the workflows that count and the targets that are
#   deliberately local-only, each with a reason. It is the one place a reader can
#   see what this binding does not enforce in CI, in the same spirit as
#   KNOWN_UNCOVERED. Excuses are checked in BOTH directions: an excused target that
#   CI turns out to reach fails too, so the list cannot rot into a list of things
#   that used to be true.
#
# THE CLOSURE'S MEMBERSHIP IS PINNED, AND THE PIN IS BACKED BY AN ORACLE
#   (#pinreachclosure)
#
#   Everything above measures how a target in the closure fares. Nothing above
#   asked WHICH targets have to be in it, and the closure below is derived by
#   awk-scanning Makefile SOURCE for the first `^<root>:` line. Four separate
#   holes followed from that, all measured in this repo at exit 0 against a
#   scratch copy of this Makefile:
#
#     1. Drop `typecheck` from `check`'s prerequisite list and the guard prints
#        `OK — 10 target(s) reached by CI` and never names the target that left.
#        A gate stops being required and the guard approves.
#     2. Wrap the real `check:` line in a DEAD make conditional and put a
#        shorter one in the `else`:
#
#            ifeq (0,1)
#            check: fmt build typecheck ... ci-reach   # the only ^check: awk reads
#            else
#            check: fmt build ... ci-reach             # what make actually parses
#            endif
#
#        awk reads the first line, make parses the second. `make -n check` runs
#        no `npm run typecheck` and the verdict is BYTE-IDENTICAL (`cmp -s`) to
#        healthy. A names-only pin over the awk closure is constant across both
#        states, so it passes the compromised one BY CONSTRUCTION — set-equal to
#        a set that describes nothing.
#     3. Keep the name and neuter the recipe (`typecheck:` / `true`). Membership
#        is unchanged; the target is silently RECLASSIFIED to `no gate` and the
#        verdict is the same false green the `dry_run` section above records.
#     4. An `excuse:` naming a target that is not in the closure at all is
#        silently ignored (`0 excused`, no complaint), while KNOWN_UNCOVERED in
#        scripts/check-conformance-coverage.sh does check that direction.
#
#   So the pin is three parts plus two rungs that keep it honest, and the parts
#   are useless apart:
#
#   A. THE MAKE-DERIVED ORACLE, the load-bearing part. Every anchor of every
#      gated closure member must appear in the anchor set of
#      `make -n <root>` — make's answer, not awk's. This is what stops hole 2:
#      the awk closure can lie about the prerequisite list, but it cannot make
#      `make -n check` print a command make does not run.
#
#      The comparison is over NORMALIZED ANCHORS, not raw command lines, and
#      that is deliberate. Four bindings measured raw-line matching false-REDDING
#      the targets that carry the suite, because a run id minted per make
#      invocation (this Makefile's own `LAZILY_CONFORMANCE_RUN_ID`, were it ever
#      spelled into a recipe rather than exported) differs between
#      `make -n <target>` and `make -n <root>` — two invocations, two ids, two
#      raw lines, one gate. Anchors already drop flag values, so they absorb it,
#      and reusing `anchors` here means there is ONE definition of "which gate is
#      this command", shared with the reach verdict rather than a second spelling
#      of it.
#
#      `make -n` only; never `make -p`. `make -p` builds the default goal and
#      dumps the environment, which would print the job's secrets into the log.
#
#   B. EXPECTED_CLOSURE_TARGETS — the discovered closure by SET EQUALITY, both
#      directions, reported separately and by name, with the root target's own
#      name pinned too so renaming `check:` cannot quietly empty the closure.
#      Set equality and not a count: a floor passes a SWAP (drop one, add one),
#      and a ceiling self-disables, starting at zero slack and gaining slack with
#      every legitimate migration until the same attack passes again. The
#      property that matters is fails-when-stale, which is the same reasoning
#      that replaced `MAX_LEDGERED_BLOCKS` with `EXPECTED_LEDGERED_BLOCKS` in
#      scripts/check-assertion-keys.mjs. `EXPECTED_` already means exact equality
#      in these repos, so the name carries the semantics; it is not `MIN_`,
#      `MAX_` or `KNOWN_`.
#
#   C. EXPECTED_NO_GATE_TARGETS — the `no gate` classification, also by set
#      equality, which is what stops hole 3. Today it is just the root, so the
#      pin is cheap and a neutered recipe has nowhere to hide: it lands in a set
#      of size one whose single legitimate member is named.
#
#   D. THE ANCHOR-COLLISION RUNG, and it runs BEFORE the oracle's verdict is
#      trusted. Normalization can only MERGE, so if two gated members reduce to
#      the same anchor set the oracle cannot tell them apart and has been
#      comparing a smaller set than it appears to. lazily-rs found that anchors
#      CREATE a collision raw lines do not (two `cd $(DIR) && lake build`
#      targets), so this is not hypothetical. It is a hard failure naming both
#      targets and the shared anchors. It also catches a member-to-member
#      repoint — `typecheck:` running `npm run build` — which defeats A, B and C
#      on its own: every count is unchanged, the command really is in
#      `make -n check`, and the only trace is that two members now say the same
#      thing.
#
#   E. A STABILITY RE-PROBE ON THE ORACLE'S FAILURE PATH ONLY. Anchors absorb a
#      leading `VAR=$(ID) cmd` but NOT `cmd --tags run-$(ID)`, where the volatile
#      value is a positional token. In that case the oracle reds blaming the
#      closure, which sends the reader hunting a dropped prerequisite that is
#      still there. So before reporting a mismatch, ask make the same two
#      questions again; if either side does not answer the same way twice, say
#      the recipe is non-deterministic and that the volatile value belongs out of
#      the command line. The refusal stands either way — only the diagnosis
#      changes.
#
# THE STEP MAP: REACH IS MEASURED INSIDE ONE NAMED CI STEP (#stepscopedreach)
#
#   A-E all measure the closure. None of them asked WHERE in CI a gate runs, and
#   `anchor_reached` asked only whether SOME command in a flat set of every
#   `run:` body in the workflow contained the member's anchors. So a member's
#   recipe repointed at a real workflow step that no member runs — `typecheck:`
#   running `npm run size:check`, which the size-budget step really does execute
#   — defeated A, B, C and D together: membership unchanged, classification
#   unchanged, CI genuinely reaches the command so reach was unchanged, and no
#   two members collided because the new command was nobody else's. Measured in
#   this repo against a scratch copy: exit 0, verdict BYTE-IDENTICAL to healthy,
#   and `npm run typecheck` no longer run by `make check` at all. Repointing
#   `test:` at `npm run test:formal` did the same.
#
#   The close is a pin in the OTHER direction from a per-recipe-content pin.
#   EXPECTED_GATE_STEPS pins, per member, the NAME of the CI step that runs it,
#   and reach is then checked inside THAT step. Repoint a member at any other
#   step's command and its anchors are no longer in its own step, so this exits 1
#   naming the member, the step, and the anchor the step does not run.
#
#   Why the NAME and not the recipe: churn is step-name-rate, not recipe-rate. A
#   recipe gaining a flag moves the recipe and the CI step's command together, so
#   the mapping does not move — which is the property a per-recipe-content pin
#   lacked. That pin would have churned on every recipe edit, been updated
#   reflexively, and become the passes-when-stale check this family already
#   removed once.
#
#   A name-only pin that is merely PRESENT asserts nothing, so each entry is
#   checked four ways: the step EXISTS in a counted workflow and is spelled
#   exactly ONCE across all of them (a duplicate name is refused, never unioned —
#   adding a second step with the pinned name while the real one is gutted is the
#   attack a name-keyed index invites); the step carries neither `if:` nor
#   `continue-on-error: true`; every one of the member's anchors is in that step;
#   and the pin is SET-EQUAL to the members actually reached by anchor, both
#   directions. An unnamed `run:` step is refused outright rather than credited to
#   the step above it, because `- run: <the real gate>` appended after a gutted
#   pinned step would otherwise satisfy that step's pin.
#
#   A member CI reaches by running `make <target>` is REFUSED a step pin, and
#   EXPECTED_MAKE_INVOKED_MEMBERS records the refusal. Where CI's instruction is
#   "run the target" there is no independent CI-side spelling of the gate, so a
#   step name for it would assert nothing about the recipe. In this binding that
#   is `fmt`, and only `fmt`: CI runs `make fmt`, and `make check` zero times.
#
# WHAT THE STEP MAP ALONE DOES NOT CLOSE. Items 1-2 remain residuals; item 3 is
# closed below by the workflow/job activation pin. All were measured in this repo
# at exit 0 with a verdict byte-identical to healthy before their respective pin.
#
#   1. A recipe WEAKENED inside its own pinned step. Anchors match as
#      subsequences and extra CI-side tokens are allowed by design, so dropping
#      `--binding js` from `assertion-ordering-check` leaves the shortened anchor
#      a subsequence of the step's unchanged command. Only a per-recipe-content
#      pin would close this, which is the churn trade above.
#
#   2. A recipe repointed at ANOTHER COMMAND IN THE SAME PINNED STEP. The step
#      map narrows the haystack from every `run:` body to one step; a step that
#      runs more than one command still offers a choice inside itself.
#      `typecheck:` repointed from `npm run typecheck` to `tsc -p tsconfig.json`
#      passes, because the pinned step runs both. Measured: 9 of the 10 pinned
#      steps here carry exactly one anchor, so the residual is one step wide
#      today — but that is a property of this workflow, not of the design.
#
#   3. A pinned step that exists, is unique, is unconditional, runs the gate —
#      inside a JOB or WORKFLOW that does not run. `if: false` or
#      `continue-on-error: true` on the JOB, or the workflow's `on:` reduced to
#      `workflow_dispatch`, all stay green. The step-level halves of that are
#      refused above because the step map gave this guard a handle on the step;
#      the step map had no handle on the job or trigger. EXPECTED_TRIGGERS,
#      EXPECTED_TRIGGER_FILTERS, EXPECTED_GATE_JOBS, EXPECTED_JOB_ACTIVATION and
#      EXPECTED_JOB_MATRIX below now make that activation exact, while independent
#      floors require push/PR/default-branch/no-path/blocking behavior.
#
#   4. Renaming a CI step reds this guard. That is the accepted cost, not a
#      defect: it is the churn the design trades for, and it is a required,
#      reviewable one-line edit rather than a silent loss of a gate.
#
# MEASURED CLEAN HERE, so the next reader does not redo it
#
#   * ONE STEP PER MEMBER is all EXPECTED_GATE_STEPS can express. lazily-kt found
#     a member whose gate genuinely spans TWO CI steps, where a one-step pin
#     falsely reds. Measured here: all 11 gated members carry exactly ONE anchor,
#     and each anchor is contained in exactly ONE `run:` step, so nothing
#     legitimate reddens. Constructed deliberately (a `test:` recipe running both
#     `npm test` and `npm run test:formal`, which CI spells in two steps) the
#     guard reds naming the step and the anchor it does not run — the right
#     diagnosis, but the pin cannot express the state. If that shape ever arrives
#     here, split the recipe or extend the pin; do NOT loosen the check to pass.
#
#   * THE WILDCARD. `anchors` emits an ANY token for an argument it cannot
#     resolve, and it matches on EITHER side — so a CI step anchor ending in a
#     wildcard would match any single-token member anchor, and lazily-cpp could
#     delete its own CI step and still report OK through exactly that. Swept
#     here at byte level: ZERO of the 16 CI step anchors and ZERO of the 11
#     member anchors contain the sentinel. The `$` tokens this workflow does
#     spell (`$root`, `$files`, `$LAZILY_CONFORMANCE_RUN_ID`) all sit in
#     commands whose program is trivial, or inside `$(...)`, so none reaches an
#     anchor. Measured by CONSEQUENCE as well, which is the check that does not
#     depend on reading the relation right: deleting each member's own CI step,
#     one at a time, reds this guard for all 11 of 11 and names exactly the
#     member that step carries. That is also the superset measurement — the
#     shape lazily-rs found in 8 of 46 members has ZERO instances here, because
#     `npm test` is not a subsequence of `npm run test:formal` (`run` intervenes
#     and `test:formal` is one token).
set -euo pipefail

MAKE_BIN="${MAKE:-make}"
ROOT_TARGET="${CI_REACH_ROOT_TARGET:-check}"
CONF="${CI_REACH_CONF:-scripts/ci-reach.conf}"

if [ ! -f Makefile ]; then
	echo "check-ci-reach: no Makefile in $(pwd)" >&2
	exit 1
fi

# `make -n` has to be USABLE before any recipe is read through it (#lzgrepcpipefail).
#
# Every recipe this guard inspects arrives via `dry_run`, which is
# `make -n "$@" 2>/dev/null | grep -v ... || true`. That `|| true` is correct for
# the grep — `grep -v` exits 1 when it filters every line away, and an empty
# recipe is a legitimate measurement — but it is INDISCRIMINATE: make's own
# failure exits through the same pipeline, `2>/dev/null` swallows the message,
# and the empty stdout that survives is then read as "this recipe runs no
# checkable command". The verdict is a FALSE GREEN, measured against a scratch
# copy of this Makefile with one prerequisite removed from `typecheck`:
#
#     make: *** No rule to make target 'no-such-prerequisite'.  Stop.   (exit 2)
#
#     no gate  typecheck                        recipe runs no checkable command
#     check-ci-reach: OK — 10 target(s) reached by CI, 0 excused, 2 carrying no gate
#     exit 0
#
# `typecheck` carries a real gate (`npm run typecheck`) and CI really runs it.
# The guard stopped requiring it, said OK, and the only trace was a count moving
# from 11 to 10 — nothing in that output mentions make at all. A guard that
# reports OK while quietly dropping a target from its own obligations is the
# exact failure this whole ladder exists to refuse, so it may not be exempt.
#
# This check is in the MAIN shell on purpose. It cannot live inside `dry_run`:
# that function is called from `prefix="$(dry_run ... | wc -l)"`, a command
# substitution, where an `exit 1` kills the subshell and the caller carries on
# with a bad count and no idea anything failed.
# No `trap` for this temp file: the matching section below installs its own EXIT
# trap for $ci_raw/$ci_anchor, and a second `trap ... EXIT` REPLACES the first
# rather than adding to it, so a trap here would be silently discarded and leak.
# Remove it by hand on both paths instead.
mk_err="$(mktemp)"
if ! "$MAKE_BIN" -n "$ROOT_TARGET" >/dev/null 2>"$mk_err"; then
	echo "check-ci-reach: \`$MAKE_BIN -n $ROOT_TARGET\` FAILED, so no recipe below could be" >&2
	echo "  read. Every target would report as carrying no gate and this guard would" >&2
	echo "  print OK while enforcing nothing. make said:" >&2
	sed 's/^/    /' "$mk_err" >&2
	rm -f "$mk_err"
	exit 1
fi
rm -f "$mk_err"

# ---------------------------------------------------------------- configuration

workflows=()
workflow_count=0
excused_targets=()
excused_reasons=()
excuse_count=0

if [ -f "$CONF" ]; then
	while IFS= read -r line || [ -n "$line" ]; do
		line="${line%%$'\r'}"
		case "$line" in
		'#'* | '') continue ;;
		esac
		key="${line%%:*}"
		val="${line#*:}"
		val="$(printf '%s' "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
		case "$key" in
		workflow)
			workflows+=("$val")
			workflow_count=$((workflow_count + 1))
			;;
		excuse)
			tgt="${val%%[[:space:]]*}"
			reason="${val#"$tgt"}"
			reason="$(printf '%s' "$reason" | sed -e 's/^[[:space:]]*//')"
			if [ -z "$reason" ]; then
				echo "check-ci-reach: excuse for '$tgt' has no reason — an excuse without a reason is not an excuse" >&2
				exit 1
			fi
			excused_targets+=("$tgt")
			excused_reasons+=("$reason")
			excuse_count=$((excuse_count + 1))
			;;
		*)
			echo "check-ci-reach: unknown key '$key' in $CONF" >&2
			exit 1
			;;
		esac
	done <"$CONF"
fi

if [ "$workflow_count" -eq 0 ]; then
	workflows=(".github/workflows/ci.yml")
	workflow_count=1
fi

for wf in "${workflows[@]}"; do
	if [ ! -f "$wf" ]; then
		echo "check-ci-reach: workflow '$wf' listed in $CONF does not exist" >&2
		exit 1
	fi
done

# ------------------------------------------------------------ the closure's pin

# The root whose closure this guard is allowed to measure (#pinreachclosure).
# Pinned so that renaming `check:` -- or pointing CI_REACH_ROOT_TARGET at some
# smaller target -- cannot quietly empty the closure and leave the guard
# reporting OK over nothing. Rename the target here and in the Makefile in the
# same commit.
EXPECTED_ROOT_TARGET="check"

# Every target `make check` is required to run, by SET EQUALITY. Sorted, and
# including the root itself because the root is a closure member. See the header:
# a count is not enough, and this pin is meaningful only because the oracle below
# proves make agrees with it.
#
# Twelve entries: 11 carrying a gate CI reaches, 0 excused, 1 (the root) carrying
# no gate of its own -- which is the accounting the OK line prints.
EXPECTED_CLOSURE_TARGETS=(
	assertion-keys
	assertion-ordering-check
	build
	# The root. It has prerequisites and no recipe, so it is legitimately in
	# EXPECTED_NO_GATE_TARGETS below as well.
	check
	ci-reach
	conformance-coverage
	flag-hygiene
	fmt
	scenario-coverage
	test
	test-interop-peer
	typecheck
)

# Closure members that legitimately carry no gate of their own, by SET EQUALITY.
# This is the classification pin: a target that keeps its name while its recipe
# is neutered (`typecheck:` / `true`) stays in the closure and is silently
# reclassified to `no gate`, which pre-pin was exit 0 with a verdict identical to
# a false green this guard's own header records. Only the root belongs here: it
# is a prerequisite list, not a recipe. Adding a second entry is a claim that a
# target in `check` checks nothing, so it needs a reason on the line.
EXPECTED_NO_GATE_TARGETS=(
	check
)

# THE STEP MAP (#stepscopedreach). For each closure member CI reaches by
# SPELLING its command, the NAME of the CI step that runs it. Reach is then
# checked INSIDE that step instead of against a flat set of every `run:` body in
# the workflow, which is what closes the recipe-swap route: repoint a member's
# recipe at any other step's command -- at a step no member runs, or at another
# member's gate -- and its anchors are no longer in ITS step, so this exits 1.
#
# Churn is step-name-rate, not recipe-rate, and that is the whole reason this pin
# is affordable where a per-recipe-content pin was not. A recipe gaining a flag
# moves the recipe and the CI step's command together and the mapping does not
# move; only renaming or removing a CI step touches this list.
#
# `member|workflow|job id|step name`, one per line, sorted by member. The step name
# is matched as an EXACT string against the scraped `- name:` value (YAML quotes
# stripped, ends trimmed), never as a substring. Workflow and job are part of the
# identity because moving an unchanged step under different job activation is a
# behavior change even though its name and command remain byte-identical.
#
# Every entry is checked in four directions, because a name-only pin that is
# merely PRESENT asserts nothing:
#   - the step exists in a counted workflow, and is spelled exactly ONCE across
#     all of them. A duplicate name is refused rather than unioned: adding a
#     second step with the pinned name, carrying the gate, while the real one is
#     gutted, is the attack a name-keyed index invites.
#   - the step carries neither `if:` nor `continue-on-error: true`. A step that is
#     pinned as the one place a gate runs, and then made conditional or unable to
#     fail its job, is a gate that does not run -- an invisible one-line drop,
#     which is the same shape this pin exists to turn into a reviewable edit.
#   - every one of the member's anchors is a subsequence of one of THAT step's
#     commands.
#   - set equality with the members actually reached by anchor, both directions,
#     so neither a new member nor a removed one can slip past unpinned.
EXPECTED_GATE_STEPS=(
	"assertion-keys|.github/workflows/ci.yml|test|Rungs 2-3 — assertion keys were READ and ASSERTED (#lzassertunknownkeys, #lzconsumednotasserted)"
	"assertion-ordering-check|.github/workflows/ci.yml|test|Assertion observation ordering (#lzassertordering)"
	"build|.github/workflows/ci.yml|test|Build (syntax check every entry point)"
	"ci-reach|.github/workflows/ci.yml|test|CI-reachability guard (#lzcheckcireachguard)"
	"conformance-coverage|.github/workflows/ci.yml|test|Rung 1 — canonical fixtures were OPENED (#portconformancecoverage)"
	"flag-hygiene|.github/workflows/ci.yml|test|Rung 5 — fixture flags are type-required, not coerced (#lzsiblingrunnermasking)"
	"scenario-coverage|.github/workflows/ci.yml|test|Rung 4 — every fixture SCENARIO was replayed (#lzscenariocoverage)"
	"test|.github/workflows/ci.yml|test|Test (assert fixtures actually ran)"
	"test-interop-peer|.github/workflows/ci.yml|test|Interop peer self-check (#lzinteroppeerci)"
	"typecheck|.github/workflows/ci.yml|test|Typecheck shipped declarations"
)

# Members CI reaches by running `make <target>` rather than by spelling the
# gate's own command, by SET EQUALITY. These are REFUSED a step pin, and that
# refusal is the point rather than an omission: where CI's instruction is "run
# the target", there is no independent CI-side spelling to cross-check, so
# naming a step for it would assert nothing about the recipe. `fmt` is here
# because CI runs `make fmt`, not `npm run format`.
#
# The set equality is what keeps the refusal honest in both directions. If CI
# ever spells `npm run format` directly instead, `fmt` leaves this set, becomes
# anchor-reached, and needs a step pin -- a required, reviewable edit, not a
# silent reclassification.
EXPECTED_MAKE_INVOKED_MEMBERS=(
	fmt
)

# The workflow/job/step that performs each make invocation. This does not pretend
# to independently spell the target's recipe; it pins the activation container so
# moving `make fmt` into a conditional or advisory job cannot remain invisible.
EXPECTED_MAKE_INVOKED_STEPS=(
	"fmt|.github/workflows/ci.yml|test|Format gate (make fmt)"
)

# ------------------------------------------------------------- activation pin
# Exact workflow activation, not a comment in ci-reach.conf
# (#verifyworkflowactually). Values are pinned rather than job-level conditions
# being forbidden: other bindings legitimately use matrix-dependent advisory
# legs, and an exact value handles that shape without a false assumption.
EXPECTED_TRIGGERS=(
	".github/workflows/ci.yml|pull_request,push,workflow_dispatch"
)
EXPECTED_TRIGGER_FILTERS=(
	".github/workflows/ci.yml|pull_request|"
	".github/workflows/ci.yml|push|branches=main"
	".github/workflows/ci.yml|workflow_dispatch|"
)
EXPECTED_GATE_JOBS=(
	".github/workflows/ci.yml|test"
)
EXPECTED_JOB_ACTIVATION=(
	".github/workflows/ci.yml|test|continue-on-error=;if=;needs="
)
EXPECTED_JOB_MATRIX=(
	".github/workflows/ci.yml|test|"
)

# Pins detect drift. These independent floors state the requirement even if a
# workflow edit and its EXPECTED_* value are changed together.
REQUIRED_TRIGGERS=(push pull_request)
REQUIRED_TRIGGER_BRANCH="main"
FORBIDDEN_ACTIVATION_LITERALS=(
	"if=false"
	"if=\${{ false }}"
	"if=\${{false}}"
	"if='false'"
	"continue-on-error=true"
	"continue-on-error=\${{ true }}"
	"continue-on-error=\${{true}}"
)

if [ "$ROOT_TARGET" != "$EXPECTED_ROOT_TARGET" ]; then
	echo "check-ci-reach: measuring the closure of '$ROOT_TARGET', but EXPECTED_ROOT_TARGET in $0" >&2
	echo "  pins it to '$EXPECTED_ROOT_TARGET'. A guard pointed at a different root measures a" >&2
	echo "  different closure, and EXPECTED_CLOSURE_TARGETS below would then be comparing" >&2
	echo "  against the wrong set. Either restore the root, or rename it in both places." >&2
	exit 1
fi

# Sorted, newline-separated rendering of a name list, for `comm`-style set
# comparison. Declared here so the pins and the discovered sets are reduced by
# the same code.
as_set() {
	printf '%s\n' "$@" | sed '/^$/d' | LC_ALL=C sort -u
}

# Both directions of a set difference, by name. `comm` and not a nested loop:
# it reports the two asymmetries separately, which is exactly the distinction the
# diagnostics have to make -- "you broke a gate" versus "you meant to change the
# closure".
set_only_in_first() {
	LC_ALL=C comm -23 <(printf '%s\n' "$1") <(printf '%s\n' "$2")
}

# ------------------------------------------------------- make target extraction

# A Makefile may set .RECIPEPREFIX to something other than tab (lazily-rs uses
# `>`), which puts recipe lines at column 0 where a rule line lives. Without this
# a recipe such as `>cargo test --features a:b` reads as a rule named `>cargo`.
RECIPE_PREFIX="$(awk -F= '/^[[:space:]]*\.RECIPEPREFIX[[:space:]]*[:+]?=/ {
	v = $2; gsub(/^[[:space:]]+|[[:space:]]+$/, "", v); if (v != "") print substr(v, 1, 1); exit
}' Makefile)"

# Prerequisites of a target, straight from the Makefile source, with `\`
# continuations joined and trailing comments removed. Order-only prerequisites are
# dropped: they constrain ordering, not what runs.
prereqs_of() {
	awk -v target="$1" -v rp="$RECIPE_PREFIX" '
		BEGIN { pat = "^" target ":([^=]|$)"; if (rp == "") rp = "\t" }
		{
			line = $0
			# Only the ACTUAL recipe prefix marks a recipe line. Treating any
			# leading whitespace as one loses a rule that is merely indented,
			# which under a non-tab .RECIPEPREFIX is perfectly legal make and
			# collapses the whole closure to a single target. A continuation is
			# exempt: under the default tab prefix a wrapped prerequisite list is
			# normally tab-indented.
			if (!cont && substr(line, 1, 1) == rp) next
			sub(/^[[:space:]]+/, "", line)
			if (cont) {
				buf = buf " " line
				if (line ~ /\\[[:space:]]*$/) next
				cont = 0
				emit(buf)
				exit
			}
			if (line !~ pat) next
			buf = line
			if (line ~ /\\[[:space:]]*$/) { cont = 1; next }
			emit(buf)
			exit
		}
		function emit(s,   rest, n, i, parts) {
			gsub(/\\/, " ", s)
			sub(/#.*$/, "", s)
			rest = substr(s, index(s, ":") + 1)
			sub(/\|.*$/, "", rest)
			n = split(rest, parts, /[[:space:]]+/)
			for (i = 1; i <= n; i++) if (parts[i] != "") print parts[i]
		}
	' Makefile
}

# Is this name an explicit rule in the Makefile?
is_makefile_target() {
	awk -v target="$1" -v rp="$RECIPE_PREFIX" '
		BEGIN { pat = "^" target ":([^=]|$)"; if (rp == "") rp = "\t"; found = 0 }
		substr($0, 1, 1) == rp { next }
		{ line = $0; sub(/^[[:space:]]+/, "", line) }
		line ~ pat { found = 1; exit }
		END { exit found ? 0 : 1 }
	' Makefile
}

# Breadth-first closure of ROOT_TARGET's prerequisites, parents before children.
closure=""
queue="$ROOT_TARGET"
seen=" "
while [ -n "$queue" ]; do
	current="${queue%%$'\n'*}"
	if [ "$current" = "$queue" ]; then queue=""; else queue="${queue#*$'\n'}"; fi
	[ -n "$current" ] || continue
	case "$seen" in
	*" $current "*) continue ;;
	esac
	seen="$seen$current "
	closure="$closure$current"$'\n'
	while IFS= read -r dep; do
		[ -n "$dep" ] || continue
		if is_makefile_target "$dep"; then
			queue="$queue$dep"$'\n'
		fi
	done < <(prereqs_of "$current")
done

# --------------------------------------------------- membership pin (both ways)

# Deferred to the end with the other verdicts so the per-target report above is
# printed in full first: a reader looking at a dropped gate wants to see which
# targets DID report before being told the set changed.
pin_errors=""
pin_error_count=0

pin_fail() {
	pin_errors="$pin_errors$1"$'\n'
	pin_error_count=$((pin_error_count + 1))
}

discovered_set="$(printf '%s' "$closure" | sed '/^$/d' | LC_ALL=C sort -u)"
expected_set="$(as_set "${EXPECTED_CLOSURE_TARGETS[@]}")"

if [ "$discovered_set" != "$expected_set" ]; then
	while IFS= read -r t; do
		[ -n "$t" ] || continue
		pin_fail "'$t' is pinned in EXPECTED_CLOSURE_TARGETS but is NOT in '$ROOT_TARGET''s closure — a
    gate was dropped from the root's prerequisites, or renamed. Restore the
    prerequisite; only edit the pin if dropping the gate is the intended change."
	done <<<"$(set_only_in_first "$expected_set" "$discovered_set")"
	while IFS= read -r t; do
		[ -n "$t" ] || continue
		pin_fail "'$t' is in '$ROOT_TARGET''s closure but is NOT pinned in EXPECTED_CLOSURE_TARGETS — a
    target was added to the root without being pinned. Add it to the pin (and to
    EXPECTED_NO_GATE_TARGETS if it legitimately carries no gate)."
	done <<<"$(set_only_in_first "$discovered_set" "$expected_set")"
fi

# The mirror of KNOWN_UNCOVERED's reverse check: an excuse for a target that is
# not in the closure at all excuses nothing. Pre-pin it was a silent no-op —
# `0 excused`, no complaint, a verdict byte-identical to healthy — so the one
# place a reader goes to see what this binding does not enforce in CI could name
# a target that no longer exists and read as current.
for i in "${!excused_targets[@]}"; do
	t="${excused_targets[$i]}"
	case "$discovered_set" in
	"$t" | "$t"$'\n'* | *$'\n'"$t" | *$'\n'"$t"$'\n'*) continue ;;
	esac
	pin_fail "$CONF excuses '$t', which is not in '$ROOT_TARGET''s closure — \`make $ROOT_TARGET\` does
    not run it, so the excuse excuses nothing and reads as current. Drop the
    excuse, or fix the target name if it was renamed."
done

# `make -n` for a target emits its prerequisites' commands first, then its own.
# Asking make for the prerequisite list alone yields exactly that prefix — make
# applies the same de-duplication to both invocations — so removing it leaves the
# target's own recipe. Diagnostics make writes about targets it has nothing to do
# for are not commands and are dropped.
# A recipe line broken across physical lines with `\` reaches the shell as ONE
# command, and make -n prints it the way the Makefile spells it. Joining here is
# what keeps `VAR=x \` + `go test ./...` from being read as two commands, the
# second of which is where the whole gate lives.
join_continuations() {
	awk '
		{
			line = $0
			if (line ~ /\\[[:space:]]*$/) {
				sub(/\\[[:space:]]*$/, "", line)
				buf = buf line " "
				next
			}
			print buf line
			buf = ""
		}
		END { if (buf != "") print buf }
	'
}

dry_run() {
	"$MAKE_BIN" -n "$@" 2>/dev/null | grep -v -e '^make\[' -e '^make:' | join_continuations || true
}

own_commands() {
	local target="$1"
	local deps=()
	local dep_count=0
	while IFS= read -r dep; do
		[ -n "$dep" ] || continue
		if is_makefile_target "$dep"; then
			deps+=("$dep")
			dep_count=$((dep_count + 1))
		fi
	done < <(prereqs_of "$target")

	if [ "$dep_count" -eq 0 ]; then
		dry_run "$target"
		return
	fi
	local prefix
	prefix="$(dry_run "${deps[@]}" | wc -l)"
	dry_run "$target" | tail -n +"$((prefix + 1))"
}

# ------------------------------------------------------------- workflow scraping

# The field separator that carries a STEP NAME alongside a command or an anchor
# (#stepscopedreach). ASCII FS: not a byte any step name or shell command in
# these workflows contains, so no quoting question arises.
SEP=$'\034'

# Every `run:` step, tagged with the NAME of the step it came from. Two record
# kinds, because the two questions are different:
#
#   S<SEP>NAME            this `run:` step EXISTS and is called NAME
#   C<SEP>NAME<SEP>cmd    NAME runs this command
#
# The S record is what lets a pinned step name be checked for EXISTENCE, and for
# being spelled exactly ONCE, independently of whether its body happens to carry
# a command this guard can read. Without it, a step whose body is all comments or
# all shell builtins would be indistinguishable from a step that is not there —
# and "the step I pinned is gone" is the diagnosis that matters most.
#
# Comment lines inside a run body are stripped here — the whole reason this guard
# is a script.
#
# The step NAME is CLEARED by any new list item that does not start with `name:`.
# An unnamed `run:` step must not inherit its predecessor's name: appending
# `- run: <the real gate>` after a gutted but still-pinned step would otherwise
# be credited to the pinned name, which is this design's own attack surface. It
# comes out unnamed instead, and the rung below refuses an unnamed `run:` step
# outright rather than attributing it by proximity.
ci_step_commands() {
	awk -v SEP="$SEP" '
		BEGIN { DQ = sprintf("%c", 34); SQ = sprintf("%c", 39) }
		function unquote(v,   f, l) {
			if (length(v) < 2) return v
			f = substr(v, 1, 1); l = substr(v, length(v), 1)
			if (f == l && (f == DQ || f == SQ)) return substr(v, 2, length(v) - 2)
			return v
		}
		function out(s) { print "C" SEP curname SEP s }
		function flush() { if (buf != "") { out(buf); buf = "" } }
		# Per-FILE state. The conf may list more than one workflow, and an
		# unterminated run: block or a leftover step name must not leak from one
		# into the next.
		FNR == 1 { flush(); inblock = 0; curname = "" }
		{
			line = $0
			indent = match(line, /[^ ]/) - 1
			if (indent < 0) indent = 9999

			if (inblock) {
				if (line ~ /^[[:space:]]*$/) next
				if (indent <= block_indent) { flush(); inblock = 0 }
				else {
					sub(/^[[:space:]]+/, "", line)
					if (substr(line, 1, 1) == "#") next
					if (line ~ /\\[[:space:]]*$/) {
						sub(/\\[[:space:]]*$/, "", line)
						buf = buf " " line
						next
					}
					if (buf != "") { out(buf " " line); buf = "" } else out(line)
					next
				}
			}

			# A new list item. `- name:` names the step that follows; anything
			# else starts a step this scanner cannot name, so the name is
			# cleared rather than carried over.
			if (line ~ /^[[:space:]]*-[[:space:]]+name:[[:space:]]*/) {
				curname = line
				sub(/^[[:space:]]*-[[:space:]]+name:[[:space:]]*/, "", curname)
				sub(/[[:space:]]+$/, "", curname)
				# A quoted YAML scalar is the same name. Unquoting here keeps a
				# reformat of the workflow from reading as a renamed step, which
				# would red every pin under it.
				curname = unquote(curname)
				next
			}
			if (line ~ /^[[:space:]]*-[[:space:]]+/) curname = ""

			if (line ~ /^[[:space:]]*(-[[:space:]]+)?run:[[:space:]]*[|>][-+]?[[:space:]]*$/) {
				print "S" SEP curname
				inblock = 1
				block_indent = indent
				buf = ""
				next
			}
			if (line ~ /^[[:space:]]*(-[[:space:]]+)?run:[[:space:]]*[^|>[:space:]]/) {
				print "S" SEP curname
				sub(/^[[:space:]]*(-[[:space:]]+)?run:[[:space:]]*/, "", line)
				out(line)
			}
		}
		END { flush() }
	' "$@"
}

# The three projections of the scraper. Single-sourced on purpose: a second
# spelling of "which lines are CI commands" is a second thing to drift.
ci_commands() {
	ci_step_commands "$@" | awk -v FS="$SEP" -v OFS="$SEP" '
		$1 == "C" { s = $3; for (i = 4; i <= NF; i++) s = s OFS $i; print s }'
}

ci_named_commands() {
	ci_step_commands "$@" | awk -v FS="$SEP" -v OFS="$SEP" '
		$1 == "C" { s = $3; for (i = 4; i <= NF; i++) s = s OFS $i; print $2 OFS s }'
}

ci_step_names() {
	ci_step_commands "$@" | awk -v FS="$SEP" '$1 == "S" { print $2 }'
}

# Execution-affecting keys on each `run:` step, one record per step per key:
#
#   NAME<SEP>if                 the step is CONDITIONAL
#   NAME<SEP>continue-on-error  the step cannot fail its job
#
# Matched at the step's own key indent (the dash column plus two), so a line
# inside a `run:` body that happens to begin with `if:` is not one of these.
ci_step_conditions() {
	awk -v SEP="$SEP" '
		BEGIN { DQ = sprintf("%c", 34); SQ = sprintf("%c", 39); keyindent = -1 }
		function unquote(v,   f, l) {
			if (length(v) < 2) return v
			f = substr(v, 1, 1); l = substr(v, length(v), 1)
			if (f == l && (f == DQ || f == SQ)) return substr(v, 2, length(v) - 2)
			return v
		}
		function name_of(line,   v) {
			v = line
			sub(/^[[:space:]]*(-[[:space:]]+)?name:[[:space:]]*/, "", v)
			sub(/[[:space:]]+$/, "", v)
			return unquote(v)
		}
		function flush() {
			if (has_run) {
				if (has_if) print curname SEP "if"
				if (has_coe) print curname SEP "continue-on-error"
			}
			has_run = 0; has_if = 0; has_coe = 0
		}
		FNR == 1 { flush(); keyindent = -1; curname = "" }
		{
			line = $0
			indent = match(line, /[^ ]/) - 1
			if (indent < 0) next

			if (line ~ /^[[:space:]]*-[[:space:]]/) {
				flush()
				keyindent = indent + 2
				curname = ""
				if (line ~ /^[[:space:]]*-[[:space:]]+name:[[:space:]]*/) curname = name_of(line)
				if (line ~ /^[[:space:]]*-[[:space:]]+run:/) has_run = 1
				next
			}
			if (indent != keyindent) next
			if (line ~ /^[[:space:]]*run:/) has_run = 1
			else if (line ~ /^[[:space:]]*name:[[:space:]]*/) curname = name_of(line)
			else if (line ~ /^[[:space:]]*if:/) has_if = 1
			else if (line ~ /^[[:space:]]*continue-on-error:[[:space:]]*true[[:space:]]*$/) has_coe = 1
		}
		END { flush() }
	' "$@"
}

# A second projection gives every run step its workflow and job identity. The
# existing command reader deliberately deals only in step names; comparing the
# two readers below makes parser silence a failure rather than an "absent" value.
# Rows are WORKFLOW<TAB>JOB<TAB>ORDINAL<TAB>STEP.
ci_step_locations() {
	awk '
		BEGIN { DQ = sprintf("%c", 34); SQ = sprintf("%c", 39) }
		function unquote(v,   f, l) {
			if (length(v) < 2) return v
			f = substr(v, 1, 1); l = substr(v, length(v), 1)
			if (f == l && (f == DQ || f == SQ)) return substr(v, 2, length(v) - 2)
			return v
		}
		function emit() { print FILENAME "\t" job "\t" stepno "\t" step }
		FNR == 1 { injobs = 0; inblock = 0; job = ""; step = ""; stepno = 0 }
		{
			line = $0
			indent = match(line, /[^ ]/) - 1
			if (indent < 0) next
			if (inblock) {
				if (line ~ /^[[:space:]]*$/) next
				if (indent > block_indent) next
				inblock = 0
			}
			if (line ~ /^jobs:[[:space:]]*$/) { injobs = 1; job = ""; next }
			if (injobs && indent == 0) { injobs = 0; job = "" }
			if (!injobs) next
			if (line ~ /^  [A-Za-z0-9_.-]+:[[:space:]]*$/) {
				job = line; sub(/^  /, "", job); sub(/:[[:space:]]*$/, "", job)
				step = ""; stepno = 0; next
			}
			if (job == "") next
			if (line ~ /^      -[[:space:]]/) { stepno++; step = "" }
			if (line ~ /^      -[[:space:]]+name:[[:space:]]*/) {
				step = line
				sub(/^      -[[:space:]]+name:[[:space:]]*/, "", step)
				sub(/[[:space:]]+$/, "", step)
				step = unquote(step)
			}
			if (line ~ /^      -[[:space:]]+run:[[:space:]]*[|>][-+]?[[:space:]]*$/ ||
			    line ~ /^        run:[[:space:]]*[|>][-+]?[[:space:]]*$/) {
				emit(); inblock = 1; block_indent = indent; next
			}
			if (line ~ /^      -[[:space:]]+run:[[:space:]]*[^|>[:space:]]/ ||
			    line ~ /^        run:[[:space:]]*[^|>[:space:]]/) emit()
		}
	' "$@"
}

# Top-level trigger rows are WORKFLOW<TAB>TRIGGER<TAB>FILTER, with an empty
# FILTER presence row for every trigger. Unsupported structures emit !SHAPE.
wf_triggers() {
	awk '
		function flushsub() {
			if (subkey != "") { printf "%s\t%s\t%s=%s\n", FILENAME, trigger, subkey, vals; subkey = ""; vals = "" }
		}
		function unquote(v) { gsub(/^[\047"]|[\047"]$/, "", v); return v }
		function flowlist(v,   n, a, i, out) {
			gsub(/^\[[[:space:]]*|[[:space:]]*\]$/, "", v)
			n = split(v, a, /[[:space:]]*,[[:space:]]*/); out = ""
			for (i = 1; i <= n; i++) if (a[i] != "") out = out (out == "" ? "" : ",") unquote(a[i])
			return out
		}
		FNR == 1 { flushsub(); inon = 0; trigger = "" }
		{
			line = $0; sub(/[[:space:]]+$/, "", line)
			if (line ~ /^[[:space:]]*#/ || line ~ /^[[:space:]]*$/) next
			indent = match(line, /[^ ]/) - 1
			if (line ~ /^on:[[:space:]]*$/) { flushsub(); inon = 1; trigger = ""; next }
			if (line ~ /^on:/) { printf "%s\t!SHAPE\t%s\n", FILENAME, line; inon = 0; next }
			if (indent == 0) { flushsub(); inon = 0; trigger = ""; next }
			if (!inon) next
			if (indent == 2) {
				flushsub()
				if (line !~ /^  [A-Za-z0-9_.-]+:[[:space:]]*$/) { printf "%s\t!SHAPE\t%s\n", FILENAME, line; next }
				trigger = line; sub(/^  /, "", trigger); sub(/:[[:space:]]*$/, "", trigger)
				printf "%s\t%s\t\n", FILENAME, trigger; next
			}
			if (trigger == "") { printf "%s\t!SHAPE\t%s\n", FILENAME, line; next }
			if (indent == 4) {
				flushsub()
				if (line !~ /^    [A-Za-z0-9_.-]+:/) { printf "%s\t!SHAPE\t%s\n", FILENAME, line; next }
				key = line; sub(/^    /, "", key); sub(/:.*$/, "", key)
				value = line; sub(/^    [A-Za-z0-9_.-]+:[[:space:]]*/, "", value)
				if (value == "") { subkey = key; vals = ""; next }
				if (value ~ /^\[.*\]$/) { printf "%s\t%s\t%s=%s\n", FILENAME, trigger, key, flowlist(value); next }
				printf "%s\t%s\t%s=%s\n", FILENAME, trigger, key, unquote(value); next
			}
			if (indent == 6 && line ~ /^      -[[:space:]]/) {
				if (subkey == "") { printf "%s\t!SHAPE\t%s\n", FILENAME, line; next }
				value = line; sub(/^      -[[:space:]]*/, "", value)
				if (value ~ /:[[:space:]]/) { printf "%s\t!SHAPE\t%s\n", FILENAME, line; next }
				vals = vals (vals == "" ? "" : ",") unquote(value); next
			}
			printf "%s\t!SHAPE\t%s\n", FILENAME, line
		}
		END { flushsub() }
	' "$@"
}

# Job rows are WORKFLOW<TAB>JOB<TAB>KEY<TAB>VALUE. PRESENT is emitted even for
# a job with no activation keys, preventing an unread job from looking absent.
wf_job_activation() {
	awk '
		function bad(l) { printf "%s\t!SHAPE\t\t%s\n", FILENAME, l }
		function unquote(v) { gsub(/^[\047"]|[\047"]$/, "", v); return v }
		function flowlist(v,   n, a, i, out) {
			gsub(/^\[[[:space:]]*|[[:space:]]*\]$/, "", v)
			n = split(v, a, /[[:space:]]*,[[:space:]]*/); out = ""
			for (i = 1; i <= n; i++) if (a[i] != "") out = out (out == "" ? "" : ",") unquote(a[i])
			return out
		}
		function flushaxis() {
			if (axis != "") { printf "%s\t%s\tmatrix\t%s=%s\n", FILENAME, job, axis, vals; axis = ""; vals = "" }
		}
		FNR == 1 { flushaxis(); injobs = 0; job = ""; mode = ""; submode = "" }
		{
			line = $0; sub(/[[:space:]]+$/, "", line)
			if (line ~ /^[[:space:]]*#/ || line ~ /^[[:space:]]*$/) next
			indent = match(line, /[^ ]/) - 1
			if (line ~ /^jobs:[[:space:]]*$/) { flushaxis(); injobs = 1; job = ""; next }
			if (indent == 0) { flushaxis(); injobs = 0; job = ""; next }
			if (!injobs) next
			if (indent == 2) {
				flushaxis()
				if (line !~ /^  [A-Za-z0-9_.-]+:[[:space:]]*$/) { bad(line); next }
				job = line; sub(/^  /, "", job); sub(/:[[:space:]]*$/, "", job)
				mode = ""; submode = ""; printf "%s\t%s\tPRESENT\t\n", FILENAME, job; next
			}
			if (job == "") { bad(line); next }
			if (indent == 4) {
				flushaxis(); submode = ""
				if (line !~ /^    [A-Za-z0-9_.-]+:/) { bad(line); next }
				key = line; sub(/^    /, "", key); sub(/:.*$/, "", key)
				mode = (key == "strategy") ? "strategy" : "other"
				if (key == "if" || key == "continue-on-error" || key == "needs") {
					value = line; sub(/^    [A-Za-z0-9_.-]+:[[:space:]]*/, "", value)
					if (value == "") { bad(line); next }
					if (value ~ /^\[.*\]$/) value = flowlist(value)
					printf "%s\t%s\t%s\t%s\n", FILENAME, job, key, value
				}
				next
			}
			if (mode != "strategy") next
			if (indent == 6) {
				flushaxis()
				if (line !~ /^      [A-Za-z0-9_.-]+:/) { bad(line); next }
				key = line; sub(/^      /, "", key); sub(/:.*$/, "", key)
				submode = (key == "matrix") ? "matrix" : ""; next
			}
			if (submode != "matrix") next
			if (indent == 8) {
				flushaxis()
				if (line !~ /^        [A-Za-z0-9_.-]+:/) { bad(line); next }
				key = line; sub(/^        /, "", key); sub(/:.*$/, "", key)
				if (key == "include" || key == "exclude") { bad(line); next }
				value = line; sub(/^        [A-Za-z0-9_.-]+:[[:space:]]*/, "", value)
				if (value == "") { axis = key; vals = ""; next }
				if (value ~ /^\[.*\]$/) { printf "%s\t%s\tmatrix\t%s=%s\n", FILENAME, job, key, flowlist(value); next }
				bad(line); next
			}
			if (indent == 10 && line ~ /^          -[[:space:]]/) {
				if (axis == "") { bad(line); next }
				value = line; sub(/^          -[[:space:]]*/, "", value)
				if (value ~ /:[[:space:]]/) { bad(line); next }
				vals = vals (vals == "" ? "" : ",") unquote(value); next
			}
			bad(line)
		}
		END { flushaxis() }
	' "$@"
}

# ------------------------------------------------------------------- normalizing

# Reduce command text to anchors, one per line, each a space-separated token list.
#
# With a first argument, input lines are `NAME<SEP>command` and output lines are
# `NAME<SEP>anchor`: the same normalizer, carrying the step name through it. One
# definition of "which gate is this command" — the step-scoped reach check and
# the flat verdict must not be able to disagree about what a command reduces to.
anchors() {
	awk -v named="${1:-}" -v SEP="$SEP" '
		BEGIN {
			# Sentinel for an unresolvable variable reference. Deliberately not a
			# string any real argument can be.
			ANY = "\001any"
			split(": true false echo printf cd pushd popd mkdir rmdir rm cp mv ln touch " \
			      "export unset set local read eval exec trap wait sleep exit return " \
			      "if then else elif fi for while until do done case esac function " \
			      "test [ [[ pwd ls cat head tail sed awk grep egrep fgrep sort uniq " \
			      "wc tr cut paste tee xargs env dirname basename date git", t, / /)
			for (i in t) if (t[i] != "") trivial[t[i]] = 1
		}
		{
			line = $0
			pfx = ""
			if (named != "") {
				sepix = index(line, SEP)
				if (sepix == 0) next
				pfx = substr(line, 1, sepix - 1)
				line = substr(line, sepix + 1)
			}
			n = split(split_unquoted(line), cmds, /\n/)
			for (i = 1; i <= n; i++) emit(cmds[i], pfx)
		}
		# Split on the shell'"'"'s sequencing operators, but ONLY outside quotes. Doing
		# this before quotes are stripped is what stops a `;` inside a message —
		# `echo "missing $(DIR); clone the sibling"` — from being read as a second
		# command and inventing an anchor for a gate that does not exist. That is a
		# false RED, so it costs a real target its verdict.
		function split_unquoted(s,   i, c, nxt, len, inq, q, out) {
			out = ""; inq = 0; q = ""; len = length(s)
			for (i = 1; i <= len; i++) {
				c = substr(s, i, 1)
				if (inq) {
					if (c == q) { inq = 0; q = "" }
					out = out c
					continue
				}
				if (c == "\"" || c == "'"'"'" || c == "`") { inq = 1; q = c; out = out c; continue }
				nxt = substr(s, i + 1, 1)
				if (c == ";") { out = out "\n"; continue }
				if ((c == "&" && nxt == "&") || (c == "|" && nxt == "|")) { out = out "\n"; i++; continue }
				if (c == "|") { out = out "\n"; continue }
				out = out c
			}
			return out
		}
		function emit(cmd, pfx,   m, j, tok, out, prog, started, parts) {
			gsub(/[`"'"'"']/, " ", cmd)
			gsub(/\$\(/, " ", cmd)
			gsub(/\$\{/, " ", cmd)
			gsub(/[(){}]/, " ", cmd)
			m = split(cmd, parts, /[[:space:]]+/)
			prog = ""
			out = ""
			started = 0
			for (j = 1; j <= m; j++) {
				tok = parts[j]
				if (tok == "" || tok == "\\") continue
				if (tok ~ /^[0-9]*>>?$/ || tok == "<" || tok ~ /^[0-9]+>&[0-9]+$/) break
				if (!started) {
					if (tok ~ /^[A-Za-z_][A-Za-z0-9_]*=/) continue
					started = 1
					prog = tok
					sub(/.*\//, "", prog)
					if (prog == "" || (prog in trivial)) return
					out = prog
					continue
				}
				if (tok ~ /^-/) {
					sub(/=.*$/, "", tok)
					out = out " " tok
					continue
				}
				if (tok ~ /^\.{1,3}$/ || tok ~ /^\.{1,2}\/\.{0,3}$/) continue
				if (tok ~ /\//) {
					sub(/\/+$/, "", tok)
					sub(/.*\//, "", tok)
					if (tok == "" || tok ~ /^\.{1,3}$/) continue
				}
					# A token that is still a shell/make VARIABLE reference names a
					# value this guard cannot resolve — a CI step spelling a path as
					# "$LAZILY_CONFORMANCE_MANIFEST" and a Makefile recipe spelling the
					# same path through an expanded $(VAR) are the same command. Dropping
					# it (what this used to do) loses the ARGUMENT as well as its value,
					# so `script.sh <path>` no longer matched a CI step that really ran
					# `script.sh "$PATH"` and the target was reported unreachable. That is
					# a false RED, and it cost lazily-cpp a hardcoded second spelling of
					# the path plus a hand-written equality assertion to keep the two in
					# sync — a new drift surface invented to satisfy a guard that exists
					# to detect drift.
					#
					# Emit a WILDCARD instead: one token that matches one token, so arity
					# is preserved. `script.sh $A` still fails against a CI step that
					# passes no argument at all. This is the same looseness the normalizer
					# already applies to paths, which it reduces to basenames — reach is a
					# floor, not equivalence, exactly as the header says.
					if (substr(tok, 1, 1) == "$") { out = out " " ANY; continue }
				out = out " " tok
			}
			if (started && out != "") print (pfx == "" ? out : pfx SEP out)
		}
	'
}

# --------------------------------------------------------------------- matching

ci_raw="$(mktemp)"
ci_anchor="$(mktemp)"
ci_stepanchor="$(mktemp)"
ci_stepnames="$(mktemp)"
ci_stepcond="$(mktemp)"
ci_steploc="$(mktemp)"
wf_trig="$(mktemp)"
wf_act="$(mktemp)"
# ONE trap. A second `trap ... EXIT` REPLACES the first rather than adding to it,
# so every temp file this guard makes has to be named here.
trap 'rm -f "$ci_raw" "$ci_anchor" "$ci_stepanchor" "$ci_stepnames" "$ci_stepcond" "$ci_steploc" "$wf_trig" "$wf_act"' EXIT
ci_commands "${workflows[@]}" >"$ci_raw"
anchors <"$ci_raw" | sort -u >"$ci_anchor"
ci_named_commands "${workflows[@]}" | anchors named | LC_ALL=C sort -u >"$ci_stepanchor"
ci_step_names "${workflows[@]}" >"$ci_stepnames"
ci_step_conditions "${workflows[@]}" | LC_ALL=C sort -u >"$ci_stepcond"
ci_step_locations "${workflows[@]}" | LC_ALL=C sort >"$ci_steploc"
wf_triggers "${workflows[@]}" | LC_ALL=C sort >"$wf_trig"
wf_job_activation "${workflows[@]}" | LC_ALL=C sort >"$wf_act"

if awk -F'\t' '$2 == "!SHAPE" { found = 1 } END { exit found ? 0 : 1 }' "$wf_trig" "$wf_act"; then
	echo "check-ci-reach: unsupported YAML shape in a workflow activation position:" >&2
	awk -F'\t' '$2 == "!SHAPE" { print "  - " $1 ": " ($4 == "" ? $3 : $4) }' "$wf_trig" "$wf_act" >&2
	echo "  Teach wf_triggers/wf_job_activation this shape; parser silence would make an" >&2
	echo "  absent activation pin pass vacuously, so this guard refuses to guess." >&2
	exit 1
fi

# Both readers must identify the same run steps. Otherwise an activation parser
# miss could turn a real job into the all-absent value expected below.
command_step_names="$(LC_ALL=C sort "$ci_stepnames")"
location_step_names="$(awk -F'\t' '{ print $4 }' "$ci_steploc" | LC_ALL=C sort)"
if [ "$command_step_names" != "$location_step_names" ]; then
	echo "check-ci-reach: workflow readers disagree about the run: steps they found" >&2
	echo "  The command reader and the job-aware activation reader must see the same" >&2
	echo "  multiset; fix unsupported indentation instead of treating it as absence." >&2
	exit 1
fi

if [ ! -s "$ci_anchor" ]; then
	echo "check-ci-reach: no run: steps found in ${workflows[*]} — a guard with an empty haystack passes everything" >&2
	exit 1
fi

# An unnamed `run:` step cannot be attributed to anything, so the step map
# refuses one instead of guessing (#stepscopedreach). Crediting it to the
# preceding step's name would let `- run: <the real gate>`, appended after a
# gutted but still-pinned step, satisfy that step's pin; dropping it silently
# would hide a gate CI really runs. A `name:` is not a behaviour change.
if LC_ALL=C grep -qxF -- "" "$ci_stepnames"; then
	unnamed="$(LC_ALL=C grep -cxF -- "" "$ci_stepnames" || true)"
	echo "check-ci-reach: $unnamed \`run:\` step(s) in ${workflows[*]} have no \`name:\`." >&2
	echo "  EXPECTED_GATE_STEPS pins gates BY STEP NAME, so an unnamed step cannot be" >&2
	echo "  attributed: crediting it to the step above would let an appended \`- run:\`" >&2
	echo "  satisfy that step's pin. Give every run: step a name — it is not a behaviour" >&2
	echo "  change." >&2
	exit 1
fi

# Does CI contain a command whose tokens contain this anchor as an in-order
# subsequence? Extra flags and arguments on the CI side are fine; missing ones are
# not.
anchor_reached() {
	awk -v want="$1" '
		BEGIN { ANY = "\001any"; wn = split(want, w, / /) }
		{
			hn = split($0, h, / /)
			wi = 1
			# A wildcard on EITHER side matches, because either side may be the
			# one that spelled the argument through a variable.
			for (hi = 1; hi <= hn && wi <= wn; hi++)
				if (h[hi] == w[wi] || h[hi] == ANY || w[wi] == ANY) wi++
			if (wi > wn) { found = 1; exit }
		}
		END { exit found ? 0 : 1 }
	' "$ci_anchor"
}

# Does the CI step NAMED `$2` contain a command whose tokens contain the anchor
# `$1` as an in-order subsequence? The step-scoped twin of `anchor_reached`
# (#stepscopedreach), and deliberately the same subsequence rule rather than a
# stricter one: what changes here is the HAYSTACK, from every `run:` body in the
# workflow down to the one step the gate is pinned to.
#
# Both functions survive because they answer different questions. A pinned
# member has to be reached inside ITS step; an EXCUSED member's excuse is stale
# the moment ANY CI step reaches it, which is the flat question.
anchor_reached_in_step() {
	awk -v want="$1" -v step="$2" -v SEP="$SEP" '
		BEGIN { ANY = "\001any"; wn = split(want, w, / /) }
		{
			sepix = index($0, SEP)
			if (sepix == 0) next
			if (substr($0, 1, sepix - 1) != step) next
			hn = split(substr($0, sepix + 1), h, / /)
			wi = 1
			for (hi = 1; hi <= hn && wi <= wn; hi++)
				if (h[hi] == w[wi] || h[hi] == ANY || w[wi] == ANY) wi++
			if (wi > wn) { found = 1; exit }
		}
		END { exit found ? 0 : 1 }
	' "$ci_stepanchor"
}

# The step name pinned for this member, or nonzero if it has none.
pinned_step_for() {
	local t="$1" e
	for e in "${EXPECTED_GATE_STEPS[@]}"; do
		if [ "${e%%|*}" = "$t" ]; then
			local rest="${e#*|}"
			rest="${rest#*|}"
			printf '%s' "${rest#*|}"
			return 0
		fi
	done
	return 1
}

pinned_workflow_for() {
	local t="$1" e rest
	for e in "${EXPECTED_GATE_STEPS[@]}"; do
		if [ "${e%%|*}" = "$t" ]; then
			rest="${e#*|}"; printf '%s' "${rest%%|*}"; return 0
		fi
	done
	return 1
}

pinned_job_for() {
	local t="$1" e rest
	for e in "${EXPECTED_GATE_STEPS[@]}"; do
		if [ "${e%%|*}" = "$t" ]; then
			rest="${e#*|}"; rest="${rest#*|}"; printf '%s' "${rest%%|*}"; return 0
		fi
	done
	return 1
}

make_step_entry_for() {
	local t="$1" e
	for e in "${EXPECTED_MAKE_INVOKED_STEPS[@]}"; do
		if [ "${e%%|*}" = "$t" ]; then printf '%s' "$e"; return 0; fi
	done
	return 1
}

step_location_count() {
	awk -F'\t' -v wf="$1" -v job="$2" -v step="$3" \
		'$1 == wf && $2 == job && $4 == step { n++ } END { print n + 0 }' "$ci_steploc"
}

# How many `run:` steps across the counted workflows carry this exact name.
# Exactly one is the only acceptable answer: zero means the pin is dead, and two
# means a name-keyed lookup cannot say which step it found the gate in.
step_occurrence_count() {
	awk -v want="$1" '$0 == want { n++ } END { print n + 0 }' "$ci_stepnames"
}

# Execution-affecting keys on the step named $1, comma-separated, empty if none.
step_conditions_of() {
	awk -v want="$1" -v SEP="$SEP" '
		{
			sepix = index($0, SEP)
			if (sepix == 0) next
			if (substr($0, 1, sepix - 1) != want) next
			out = (out == "" ? "" : out ", ") substr($0, sepix + 1)
		}
		END { print out }
	' "$ci_stepcond"
}

# CI invoking the target through make counts as reach without any anchor work.
make_invokes() {
	awk -v target="$1" '
		{
			n = split($0, t, / /)
			if (t[1] != "make") next
			for (i = 2; i <= n; i++) if (t[i] == target) { found = 1; exit }
		}
		END { exit found ? 0 : 1 }
	' "$ci_anchor"
}

is_excused() {
	local t="$1" i
	for i in "${!excused_targets[@]}"; do
		[ "${excused_targets[$i]}" = "$t" ] && return 0
	done
	return 1
}

excuse_reason() {
	local t="$1" i
	for i in "${!excused_targets[@]}"; do
		if [ "${excused_targets[$i]}" = "$t" ]; then
			printf '%s' "${excused_reasons[$i]}"
			return
		fi
	done
}

# ------------------------------------------- the make-derived oracle's haystack

# What make says `make <root>` really runs, reduced by the SAME normalizer the
# reach verdict uses (#pinreachclosure). This is the oracle's haystack: the awk
# closure above can be made to lie about the prerequisite list, but it cannot
# make this set contain a command make does not run. Computed once, outside the
# loop, because it is the same answer for every target.
#
# `make -n`, never `make -p` — see the header. The root's readability was already
# asserted in the main shell before any recipe was read, so an empty set here
# would be a real emptiness rather than a swallowed make error; the vacuity rule
# below still refuses to call that OK.
root_anchors="$(dry_run "$ROOT_TARGET" | anchors | LC_ALL=C sort -u || true)"

# Anchor set per GATED closure member, kept for the collision rung. Only gated
# members: a member with no anchors is the `no gate` class, which
# EXPECTED_NO_GATE_TARGETS pins exactly and by name, and treating two empty sets
# as a "collision" would fire this rung redundantly with a worse message.
declare -A gated_anchors=()
oracle_misses=""
oracle_miss_count=0
step_map_misses=""
step_map_miss_count=0
discovered_anchor_reached=""
discovered_make_invoked=""
gate_jobs_found=""

unreached=""
unreached_count=0
stale=""
stale_count=0
nogate=""
nogate_count=0
reached=0
excused_ok=0

while IFS= read -r target; do
	[ -n "$target" ] || continue

	# Per-target half of the `make -n` gate above. The root gate catches a broken
	# graph, which is the reachable case, but it is the ROOT it proves readable —
	# so assert it for the target actually being measured, immediately before its
	# empty anchor set would be read as "carries no gate". Also in the main shell,
	# and deliberately NOT folded into `dry_run` or `own_commands`: both are
	# called from command substitutions where an `exit` reaches only the subshell.
	if ! "$MAKE_BIN" -n "$target" >/dev/null 2>&1; then
		echo "check-ci-reach: \`$MAKE_BIN -n $target\` failed — its recipe cannot be read," >&2
		echo "  so an empty anchor set here would be reported as 'no gate' instead of as" >&2
		echo "  this failure. Fix the target; do not let it be excused by silence." >&2
		unreached="$unreached$target"$'\n'
		unreached_count=$((unreached_count + 1))
		printf 'UNREADABLE  %s\n' "$target"
		continue
	fi

	target_anchors="$(own_commands "$target" | anchors | sort -u || true)"

	if [ -z "$target_anchors" ]; then
		nogate="$nogate$target"$'\n'
		nogate_count=$((nogate_count + 1))
		continue
	fi

	gated_anchors["$target"]="$target_anchors"

	# HOW CI REACHES THIS MEMBER, recorded BEFORE the oracle (#stepscopedreach).
	# It decides whether the member gets a step pin at all, and it has to be
	# recorded even for a member the oracle then refuses: otherwise the
	# set-equality rungs below would also report that member as unpinned, burying
	# the real diagnosis under a second, wrong one.
	via=anchors
	make_invokes "$target" && via=make
	if is_excused "$target"; then
		via=excused
	elif [ "$via" = make ]; then
		discovered_make_invoked="$discovered_make_invoked$target"$'\n'
	else
		discovered_anchor_reached="$discovered_anchor_reached$target"$'\n'
	fi

	# THE ORACLE. Every anchor this target carries has to appear in what make says
	# the ROOT runs. Without this the membership pin is set-equal to a set that
	# describes nothing: an `ifeq` block, or a dead `ifeq (0,1)` one, decouples the
	# awk-scanned prerequisite list from the list make parses, and the pin is
	# constant across both states.
	oracle_missing=""
	while IFS= read -r a; do
		[ -n "$a" ] || continue
		# A HERE-STRING, not `printf ... | grep -q`. `grep -q` exits on its first
		# match and SIGPIPEs the left-hand side, which under `pipefail` makes the
		# pipeline fail — so `if !` would invert on a MATCH and report a false
		# ORACLE MISMATCH. It arms probabilistically, below the pipe buffer, which
		# is the worst kind. A here-string is an fd, not a pipe.
		if ! LC_ALL=C grep -qxF -- "$a" <<<"$root_anchors"; then
			oracle_missing="$oracle_missing$a"$'\n'
		fi
	done <<<"$target_anchors"

	if [ -n "$oracle_missing" ]; then
		# THE STABILITY RE-PROBE, on the failure path only. Ask make both questions
		# again before blaming the closure: a volatile value in a POSITIONAL token
		# (`cmd --tags run-$(ID)`, which anchors keep because only flag values are
		# dropped) differs between two make invocations, and the mismatch then says
		# "a gate was dropped" about a gate that is still there. The refusal stands
		# either way; only the diagnosis changes.
		reprobe_target="$(own_commands "$target" | anchors | LC_ALL=C sort -u || true)"
		reprobe_root="$(dry_run "$ROOT_TARGET" | anchors | LC_ALL=C sort -u || true)"
		if [ "$reprobe_target" != "$target_anchors" ] || [ "$reprobe_root" != "$root_anchors" ]; then
			# Blame the TARGET's own recipe when that is what moved, even if the
			# root moved too — the root's answer contains the target's line, so a
			# volatile token in one recipe makes both sides differ, and the
			# actionable half is the recipe.
			blame="\`$MAKE_BIN -n $ROOT_TARGET\`"
			[ "$reprobe_target" = "$target_anchors" ] || blame="$target's own recipe"
			oracle_misses="${oracle_misses}NONDETERMINISTIC  $target
    $blame does not answer the same way twice, so this guard cannot compare the
    two sides at all and is refusing rather than guessing. Something in the
    command line carries a value minted per make invocation (a run id, a
    timestamp, a PID) in a POSITIONAL token — anchors drop flag VALUES, so a
    leading \`VAR=\$(ID) cmd\` is absorbed and \`cmd --tags run-\$(ID)\` is not.
    Move the volatile value out of the command line: export it, as this
    Makefile's LAZILY_CONFORMANCE_RUN_ID already does. This is NOT a dropped
    prerequisite — do not go looking for one.
"
			oracle_miss_count=$((oracle_miss_count + 1))
			printf 'NONDETERMINISTIC  %s\n' "$target"
			continue
		fi
		oracle_misses="${oracle_misses}ORACLE MISMATCH  $target
    is in '$ROOT_TARGET''s awk-scanned closure, but \`$MAKE_BIN -n $ROOT_TARGET\` does not run
    these commands of its own:
$(printf '%s' "$oracle_missing" | sed '/^$/d; s/^/      /')
    make and the Makefile's source text disagree about what \`$ROOT_TARGET\` runs. The
    usual cause is a make conditional: a second \`$ROOT_TARGET:\` line in an \`ifeq\`/\`else\`
    block, where this guard's scanner reads the first and make parses the other.
    Restore the gate to the branch make actually takes; only edit
    EXPECTED_CLOSURE_TARGETS if removing it is the intended change."
		oracle_miss_count=$((oracle_miss_count + 1))
		printf 'ORACLE MISMATCH  %s\n' "$target"
		continue
	fi

	hit=1
	missing_anchors=""
	pinned_step=""

	if [ "$via" = excused ]; then
		# An excuse claims CI does not run this gate AT ALL, so the FLAT question
		# is the right one here and `anchor_reached` is why both functions exist.
		# Any CI step reaching an excused member makes the excuse stale, whatever
		# step it is in — there is no pinned step to scope to, because an excused
		# member is one no step was supposed to run.
		if ! make_invokes "$target"; then
			while IFS= read -r a; do
				[ -n "$a" ] || continue
				if ! anchor_reached "$a"; then
					hit=0
					missing_anchors="$missing_anchors$a"$'\n'
				fi
			done <<<"$target_anchors"
		fi
	elif [ "$via" = make ]; then
		# Reached by `make <target>`. There is no CI-side spelling of the gate to
		# cross-check, so a step pin here would assert nothing about the recipe —
		# having one is an error, not extra safety.
		if pinned_step="$(pinned_step_for "$target")"; then
			pin_fail "'$target' is reached by CI running \`$MAKE_BIN $target\`, yet EXPECTED_GATE_STEPS pins it
    to the step '$pinned_step'. Where CI's instruction is 'run the target' there is no
    independent CI-side spelling of the gate, so a step name for it asserts nothing
    about the recipe. Drop the entry; the member belongs in
    EXPECTED_MAKE_INVOKED_MEMBERS, which is where the refusal is recorded."
		fi
		if ! make_entry="$(make_step_entry_for "$target")"; then
			step_map_misses="${step_map_misses}UNPINNED MAKE STEP  $target
    is reached through \`$MAKE_BIN $target\`, but EXPECTED_MAKE_INVOKED_STEPS does not
    name the workflow, job and step that activates it. Add an exact location."
			step_map_miss_count=$((step_map_miss_count + 1))
			printf 'STEP PIN  %s\n' "$target"
			continue
		fi
		make_rest="${make_entry#*|}"; make_wf="${make_rest%%|*}"
		make_rest="${make_rest#*|}"; make_job="${make_rest%%|*}"; make_step="${make_rest#*|}"
		if [ "$(step_location_count "$make_wf" "$make_job" "$make_step")" -ne 1 ] ||
		   ! anchor_reached_in_step "make $target" "$make_step"; then
			step_map_misses="${step_map_misses}DEAD MAKE STEP PIN  $target
    is pinned to '$make_wf' job '$make_job' step '$make_step', but exactly one such
    run: step invoking \`$MAKE_BIN $target\` was not found. Restore it or update the pin."
			step_map_miss_count=$((step_map_miss_count + 1))
			printf 'STEP PIN  %s\n' "$target"
			continue
		fi
		gate_jobs_found="$gate_jobs_found$make_wf|$make_job"$'\n'
	else
		# STEP-SCOPED REACH (#stepscopedreach). Every anchor has to be in the ONE
		# step this member is pinned to, not in some `run:` body somewhere in the
		# workflow.
		if ! pinned_step="$(pinned_step_for "$target")"; then
			step_map_misses="${step_map_misses}UNPINNED  $target
    is reached by CI SPELLING its command, but EXPECTED_GATE_STEPS names no step
    for it. Reach is checked inside a member's pinned step; with no pin there is
    nothing to scope to but 'some run: step somewhere', which is the flat check
    this pin replaced. Add \"$target|<the exact name: of the step that runs it>\".
"
			step_map_miss_count=$((step_map_miss_count + 1))
			printf 'STEP PIN  %s\n' "$target"
			continue
		fi

		occurrences="$(step_occurrence_count "$pinned_step")"
		if [ "$occurrences" -eq 0 ]; then
			step_map_misses="${step_map_misses}DEAD STEP PIN  $target
    is pinned to the CI step '$pinned_step', and no \`run:\` step in
    ${workflows[*]} has that name. The step was renamed or removed, so the pin
    names nothing and this guard cannot say where the gate runs. Correct the name
    in EXPECTED_GATE_STEPS, or restore the step.
"
			step_map_miss_count=$((step_map_miss_count + 1))
			printf 'STEP PIN  %s\n' "$target"
			continue
		fi

		pinned_workflow="$(pinned_workflow_for "$target")"
		pinned_job="$(pinned_job_for "$target")"
		if [ "$(step_location_count "$pinned_workflow" "$pinned_job" "$pinned_step")" -ne 1 ]; then
			step_map_misses="${step_map_misses}MOVED STEP PIN  $target
    is pinned to '$pinned_workflow' job '$pinned_job' step '$pinned_step', but that
    exact workflow/job/step identity does not exist once. A gate step moved to a
    differently activated job is a behavior change; restore it or update the pin."
			step_map_miss_count=$((step_map_miss_count + 1))
			printf 'STEP PIN  %s\n' "$target"
			continue
		fi
		gate_jobs_found="$gate_jobs_found$pinned_workflow|$pinned_job"$'\n'
		if [ "$occurrences" -gt 1 ]; then
			step_map_misses="${step_map_misses}AMBIGUOUS STEP PIN  $target
    is pinned to the CI step '$pinned_step', and $occurrences \`run:\` steps in
    ${workflows[*]} carry that name. A name-keyed lookup cannot say which of them
    it found the gate in, and unioning them is the hole: a second step with the
    pinned name, carrying the gate, satisfies the pin while the real step is
    gutted. Give the steps distinct names.
"
			step_map_miss_count=$((step_map_miss_count + 1))
			printf 'STEP PIN  %s\n' "$target"
			continue
		fi

		conditions="$(step_conditions_of "$pinned_step")"
		if [ -n "$conditions" ]; then
			step_map_misses="${step_map_misses}CONDITIONAL STEP  $target
    is pinned to the CI step '$pinned_step', which carries: $conditions.
    A step with an \`if:\` may not run, and one with \`continue-on-error: true\`
    cannot fail its job, so neither reaches the gate unconditionally — and this
    pin's whole justification is that dropping a gate becomes a reviewable edit
    rather than an invisible one. Adding a condition to the one step a gate is
    pinned to IS that invisible drop. Remove the condition, or move the gate to a
    step that runs on every push and PR and repin it.
"
			step_map_miss_count=$((step_map_miss_count + 1))
			printf 'STEP PIN  %s\n' "$target"
			continue
		fi

		while IFS= read -r a; do
			[ -n "$a" ] || continue
			if ! anchor_reached_in_step "$a" "$pinned_step"; then
				hit=0
				missing_anchors="$missing_anchors$a"$'\n'
			fi
		done <<<"$target_anchors"
	fi

	if is_excused "$target"; then
		if [ "$hit" -eq 1 ]; then
			stale="$stale$target"$'\n'
			stale_count=$((stale_count + 1))
		else
			excused_ok=$((excused_ok + 1))
			printf 'excused  %-32s %s\n' "$target" "$(excuse_reason "$target")"
		fi
		continue
	fi

	if [ "$hit" -eq 1 ]; then
		reached=$((reached + 1))
		printf 'reached  %s\n' "$target"
	else
		unreached="$unreached$target"$'\n'
		unreached_count=$((unreached_count + 1))
		printf 'MISSING  %s\n' "$target"
		while IFS= read -r a; do
			[ -n "$a" ] || continue
			if [ -n "$pinned_step" ]; then
				printf '           the step '"'"'%s'"'"' runs no command matching `%s`\n' "$pinned_step" "$a"
			else
				printf '           no CI run: step matches `%s`\n' "$a"
			fi
		done <<<"$missing_anchors"
	fi
done <<<"$closure"

while IFS= read -r target; do
	[ -n "$target" ] || continue
	printf 'no gate  %-32s recipe runs no checkable command\n' "$target"
done <<<"$nogate"

# ------------------------------------------- the anchor-collision rung (first)

# Normalization can only MERGE. If two gated closure members reduce to the same
# anchor set then the oracle above cannot tell them apart, and it has been
# comparing a SMALLER set than it appears to — so this runs before the oracle's
# verdict is reported, not after. lazily-rs measured anchors CREATING a collision
# that raw command lines do not have (two `cd $(DIR) && lake build` targets), so
# the rung is not hypothetical.
#
# It is also the only rung that catches a member-to-member repoint — `typecheck:`
# running `npm run build`. That leaves membership, classification and reach all
# unchanged and the command genuinely present in `make -n check`; the only trace
# is that two members now say the same thing.
declare -A anchor_owner=()
collisions=""
collision_count=0
if [ "${#gated_anchors[@]}" -gt 0 ]; then
	while IFS= read -r t; do
		[ -n "$t" ] || continue
		# Flatten to one line so the set is a single associative-array key.
		key="$(printf '%s' "${gated_anchors[$t]}" | tr '\n' '\036')"
		if [ -n "${anchor_owner[$key]:-}" ]; then
			collisions="${collisions}ANCHOR COLLISION  ${anchor_owner[$key]} and $t
    reduce to the SAME anchor set, so this guard cannot distinguish them and the
    oracle has been comparing a merged set:
$(printf '%s' "${gated_anchors[$t]}" | sed '/^$/d; s/^/      /')
    Either two targets really run the same gate — in which case one of them is
    not a gate and does not belong in '$ROOT_TARGET' — or one recipe was repointed at
    the other's command. Give them distinguishable commands, or drop one.
"
			collision_count=$((collision_count + 1))
			continue
		fi
		anchor_owner["$key"]="$t"
	done <<<"$(printf '%s\n' "${!gated_anchors[@]}" | LC_ALL=C sort)"
fi

# --------------------------------------------------- classification pin (C)

discovered_nogate="$(printf '%s' "$nogate" | sed '/^$/d' | LC_ALL=C sort -u)"
expected_nogate="$(as_set "${EXPECTED_NO_GATE_TARGETS[@]}")"

if [ "$discovered_nogate" != "$expected_nogate" ]; then
	while IFS= read -r t; do
		[ -n "$t" ] || continue
		pin_fail "'$t' now carries NO GATE, and EXPECTED_NO_GATE_TARGETS does not list it — its
    recipe runs no checkable command, so it is in '$ROOT_TARGET' under its old name and
    checks nothing. A neutered recipe (\`$t:\` / \`true\`) looks exactly like this.
    Restore the recipe; only list it here if a target in '$ROOT_TARGET' that checks
    nothing is the intended state, and say why on the line."
	done <<<"$(set_only_in_first "$discovered_nogate" "$expected_nogate")"
	while IFS= read -r t; do
		[ -n "$t" ] || continue
		pin_fail "EXPECTED_NO_GATE_TARGETS lists '$t', but it now carries a gate — the pin
    understates what this binding checks. Remove it from the pin."
	done <<<"$(set_only_in_first "$expected_nogate" "$discovered_nogate")"
fi

# ------------------------------------------- the step map's pins (both ways)

# One entry per member. `pinned_step_for` returns the FIRST match, so a second
# entry for the same member is dead text that the set comparison below cannot
# see: both directions would agree while the guard silently used one of the two.
seen_pin_members=" "
for e in "${EXPECTED_GATE_STEPS[@]}"; do
	m="${e%%|*}"
	if [ "$m" = "$e" ]; then
		pin_fail "EXPECTED_GATE_STEPS entry '$e' has no '|' separating the member from the step
    name, so it pins nothing. Write it as \"<member>|<the step's exact name:>\"."
		continue
	fi
	case "$seen_pin_members" in
	*" $m "*)
		pin_fail "EXPECTED_GATE_STEPS names '$m' more than once. Only the first entry is ever
    read, so the others are dead text a set comparison cannot see. Keep one."
		;;
	esac
	seen_pin_members="$seen_pin_members$m "
done

discovered_anchor_set="$(printf '%s' "$discovered_anchor_reached" | sed '/^$/d' | LC_ALL=C sort -u)"
expected_anchor_set="$(as_set "${EXPECTED_GATE_STEPS[@]%%|*}")"

if [ "$discovered_anchor_set" != "$expected_anchor_set" ]; then
	while IFS= read -r t; do
		[ -n "$t" ] || continue
		pin_fail "EXPECTED_GATE_STEPS pins a CI step for '$t', which is not a member CI reaches by
    spelling its command — it left the closure, became excused, or is now reached
    through \`$MAKE_BIN $t\`. A step pin for it asserts nothing. Remove the entry, or
    restore whatever made it anchor-reached."
	done <<<"$(set_only_in_first "$expected_anchor_set" "$discovered_anchor_set")"
	while IFS= read -r t; do
		[ -n "$t" ] || continue
		pin_fail "'$t' is reached by CI spelling its command, but EXPECTED_GATE_STEPS names no
    step for it. Add \"$t|<the exact name: of the step that runs it>\"."
	done <<<"$(set_only_in_first "$discovered_anchor_set" "$expected_anchor_set")"
fi

discovered_makeinv_set="$(printf '%s' "$discovered_make_invoked" | sed '/^$/d' | LC_ALL=C sort -u)"
expected_makeinv_set="$(as_set "${EXPECTED_MAKE_INVOKED_MEMBERS[@]}")"

if [ "$discovered_makeinv_set" != "$expected_makeinv_set" ]; then
	while IFS= read -r t; do
		[ -n "$t" ] || continue
		pin_fail "EXPECTED_MAKE_INVOKED_MEMBERS lists '$t', but CI no longer reaches it by running
    \`$MAKE_BIN $t\`. It now has a CI-side spelling of its own (or none at all), so the
    refusal of a step pin no longer applies: move it to EXPECTED_GATE_STEPS with the
    name of the step that runs it, or add an excuse if CI stopped running it."
	done <<<"$(set_only_in_first "$expected_makeinv_set" "$discovered_makeinv_set")"
	while IFS= read -r t; do
		[ -n "$t" ] || continue
		pin_fail "'$t' is reached by CI running \`$MAKE_BIN $t\` rather than by spelling its gate, and
    EXPECTED_MAKE_INVOKED_MEMBERS does not list it. Such a member is REFUSED a step
    pin because there is nothing CI-side to cross-check; say so by listing it here."
	done <<<"$(set_only_in_first "$discovered_makeinv_set" "$expected_makeinv_set")"
fi

# --------------------------------------------------------- activation verdicts

activation_errors=""
activation_error_count=0
activation_fail() {
	activation_errors="$activation_errors$1"$'\n'
	activation_error_count=$((activation_error_count + 1))
}

workflow_triggers() {
	awk -F'\t' -v wf="$1" '$1 == wf && $2 != "!SHAPE" && $3 == "" { print $2 }' "$wf_trig" |
		LC_ALL=C sort -u | paste -sd',' -
}
workflow_filters() {
	awk -F'\t' -v wf="$1" -v trigger="$2" \
		'$1 == wf && $2 == trigger && $3 != "" { print $3 }' "$wf_trig" |
		LC_ALL=C sort -u | paste -sd';' -
}
job_activation() {
	awk -F'\t' -v wf="$1" -v job="$2" '
		$1 == wf && $2 == job && $3 == "continue-on-error" { c = $4 }
		$1 == wf && $2 == job && $3 == "if" { i = $4 }
		$1 == wf && $2 == job && $3 == "needs" { n = $4 }
		END { printf "continue-on-error=%s;if=%s;needs=%s", c, i, n }
	' "$wf_act"
}
job_matrix() {
	awk -F'\t' -v wf="$1" -v job="$2" '$1 == wf && $2 == job && $3 == "matrix" { print $4 }' "$wf_act" |
		LC_ALL=C sort -u | paste -sd';' -
}

# Empty pins are the pre-fix implementation in another spelling.
for pin_name in EXPECTED_TRIGGERS EXPECTED_TRIGGER_FILTERS EXPECTED_GATE_JOBS EXPECTED_JOB_ACTIVATION EXPECTED_JOB_MATRIX; do
	eval 'pin_size=${#'"$pin_name"'[@]}'
	if [ "$pin_size" -eq 0 ]; then
		activation_fail "$pin_name is empty, so this guard pins nothing about workflow activation."
	fi
	eval 'pin_entries=("${'"$pin_name"'[@]}")'
	pin_rows="$(printf '%s\n' "${pin_entries[@]}" | LC_ALL=C sort)"
	pin_set="$(as_set "${pin_entries[@]}")"
	if [ "$pin_rows" != "$pin_set" ]; then
		activation_fail "$pin_name must be sorted, nonblank and duplicate-free; otherwise a row is dead or ambiguous."
	fi
done

expected_workflow_set="$(printf '%s\n' "${EXPECTED_TRIGGERS[@]%%|*}" | LC_ALL=C sort -u)"
counted_workflow_set="$(as_set "${workflows[@]}")"
if [ "$expected_workflow_set" != "$counted_workflow_set" ]; then
	activation_fail "EXPECTED_TRIGGERS workflow keys are '$expected_workflow_set'; $CONF counts '$counted_workflow_set'."
fi

# Exact trigger and filter values, with every pin key required exactly once.
for wf in "${workflows[@]}"; do
	want=""; found=0
	for e in "${EXPECTED_TRIGGERS[@]}"; do
		case "$e" in "$wf|"*) want="${e#*|}"; found=$((found + 1)) ;; esac
	done
	got="$(workflow_triggers "$wf")"
	if [ "$found" -ne 1 ] || [ "$got" != "$want" ]; then
		activation_fail "EXPECTED_TRIGGERS for '$wf' is '$want' ($found row(s)); workflow says '$got'."
	fi
	IFS=',' read -r -a actual_triggers <<<"$got"
	for trigger in "${actual_triggers[@]}"; do
		[ -n "$trigger" ] || continue
		want_filter=""; filter_found=0
		for e in "${EXPECTED_TRIGGER_FILTERS[@]}"; do
			rest="${e#*|}"; e_wf="${e%%|*}"; e_trigger="${rest%%|*}"
			if [ "$e_wf" = "$wf" ] && [ "$e_trigger" = "$trigger" ]; then
				want_filter="${rest#*|}"; filter_found=$((filter_found + 1))
			fi
		done
		got_filter="$(workflow_filters "$wf" "$trigger")"
		if [ "$filter_found" -ne 1 ] || [ "$got_filter" != "$want_filter" ]; then
			activation_fail "EXPECTED_TRIGGER_FILTERS for '$wf' trigger '$trigger' is '$want_filter' ($filter_found row(s)); workflow says '$got_filter'."
		fi
	done
	for required in "${REQUIRED_TRIGGERS[@]}"; do
		case ",$got," in *",$required,"*) ;; *) activation_fail "REQUIRED_TRIGGERS requires '$wf' to run on '$required'." ;; esac
	done
done

# A filter pin for a trigger that no longer exists is stale, not harmless text.
for e in "${EXPECTED_TRIGGER_FILTERS[@]}"; do
	wf="${e%%|*}"; rest="${e#*|}"; trigger="${rest%%|*}"
	case ",$(workflow_triggers "$wf")," in *",$trigger,"*) ;; *) activation_fail "EXPECTED_TRIGGER_FILTERS names absent trigger '$wf|$trigger'." ;; esac
done

# Floors: required triggers may not be path-filtered, and push must still cover
# the default branch. These requirements are independent of EXPECTED_*.
for wf in "${workflows[@]}"; do
	for trigger in "${REQUIRED_TRIGGERS[@]}"; do
		filters="$(workflow_filters "$wf" "$trigger")"
		case ";$filters;" in *";paths="* | *";paths-ignore="*)
			activation_fail "'$wf' trigger '$trigger' has a path filter; a gate-changing file can then bypass CI." ;;
		esac
	done
	push_filters="$(workflow_filters "$wf" push)"
	branches="$(printf '%s\n' "$push_filters" | tr ';' '\n' | sed -n 's/^branches=//p')"
	branches_ignore="$(printf '%s\n' "$push_filters" | tr ';' '\n' | sed -n 's/^branches-ignore=//p')"
	if [ -n "$branches" ]; then
		branch_ok=0
		IFS=',' read -r -a patterns <<<"$branches"
		for pattern in "${patterns[@]}"; do
			case "$pattern" in !*) activation_fail "'$wf' push branches contains negated pattern '$pattern', which this floor refuses to guess about." ;;
			esac
		# shellcheck disable=SC2254
		case "$REQUIRED_TRIGGER_BRANCH" in $pattern) branch_ok=1 ;; esac
		done
		[ "$branch_ok" -eq 1 ] || activation_fail "'$wf' push branches '$branches' do not include required branch '$REQUIRED_TRIGGER_BRANCH'."
	fi
	if [ -n "$branches_ignore" ]; then
		IFS=',' read -r -a patterns <<<"$branches_ignore"
		for pattern in "${patterns[@]}"; do
			# shellcheck disable=SC2254
			case "$REQUIRED_TRIGGER_BRANCH" in $pattern) activation_fail "'$wf' push branches-ignore '$branches_ignore' excludes required branch '$REQUIRED_TRIGGER_BRANCH'." ;; esac
		done
	fi
done

# Gate jobs are derived from resolved step identities, then compared as a set.
actual_gate_jobs="$(printf '%s' "$gate_jobs_found" | sed '/^$/d' | LC_ALL=C sort -u)"
expected_gate_jobs="$(as_set "${EXPECTED_GATE_JOBS[@]}")"
if [ "$actual_gate_jobs" != "$expected_gate_jobs" ]; then
	activation_fail "EXPECTED_GATE_JOBS is '$expected_gate_jobs'; resolved gate steps are '$actual_gate_jobs'."
fi

expected_make_step_members="$(printf '%s\n' "${EXPECTED_MAKE_INVOKED_STEPS[@]%%|*}" | LC_ALL=C sort)"
if [ "$expected_make_step_members" != "$expected_makeinv_set" ]; then
	activation_fail "EXPECTED_MAKE_INVOKED_STEPS member keys are '$expected_make_step_members'; EXPECTED_MAKE_INVOKED_MEMBERS is '$expected_makeinv_set'."
fi

for pin_name in EXPECTED_JOB_ACTIVATION EXPECTED_JOB_MATRIX; do
	eval 'pin_entries=("${'"$pin_name"'[@]}")'
	pin_keys=""
	for e in "${pin_entries[@]}"; do
		first="${e%%|*}"; rest="${e#*|}"; second="${rest%%|*}"
		pin_keys="$pin_keys$first|$second"$'\n'
	done
	pin_keys="$(printf '%s' "$pin_keys" | sed '/^$/d' | LC_ALL=C sort -u)"
	if [ "$pin_keys" != "$expected_gate_jobs" ]; then
		activation_fail "$pin_name job keys are '$pin_keys'; EXPECTED_GATE_JOBS is '$expected_gate_jobs'."
	fi
done

# Cross-check the two YAML readers at workflow+job granularity before an absent
# activation value is trusted.
while IFS=$'\t' read -r wf job; do
	[ -n "$wf" ] && [ -n "$job" ] || continue
	if ! awk -F'\t' -v wf="$wf" -v job="$job" '$1 == wf && $2 == job && $3 == "PRESENT" { found=1 } END { exit found ? 0 : 1 }' "$wf_act"; then
		activation_fail "workflow readers disagree: '$wf' job '$job' has run: steps but no activation presence row."
	fi
done < <(awk -F'\t' '{ print $1 "\t" $2 }' "$ci_steploc" | LC_ALL=C sort -u)

dup_activation="$(awk -F'\t' '$3 == "if" || $3 == "continue-on-error" || $3 == "needs" { n[$1 "|" $2 "|" $3]++ } END { for (k in n) if (n[k] > 1) print k }' "$wf_act" | LC_ALL=C sort)"
[ -z "$dup_activation" ] || activation_fail "duplicate job activation key(s): $dup_activation"

for gate_job in "${EXPECTED_GATE_JOBS[@]}"; do
	wf="${gate_job%%|*}"; job="${gate_job#*|}"
	want=""; found=0
	for e in "${EXPECTED_JOB_ACTIVATION[@]}"; do
		case "$e" in "$gate_job|"*) want="${e#*|*|}"; found=$((found + 1)) ;; esac
	done
	got="$(job_activation "$wf" "$job")"
	if [ "$found" -ne 1 ] || [ "$got" != "$want" ]; then
		activation_fail "EXPECTED_JOB_ACTIVATION for '$gate_job' is '$want' ($found row(s)); workflow says '$got'."
	fi
	want_matrix=""; matrix_found=0
	for e in "${EXPECTED_JOB_MATRIX[@]}"; do
		case "$e" in "$gate_job|"*) want_matrix="${e#*|*|}"; matrix_found=$((matrix_found + 1)) ;; esac
	done
	got_matrix="$(job_matrix "$wf" "$job")"
	if [ "$matrix_found" -ne 1 ] || [ "$got_matrix" != "$want_matrix" ]; then
		activation_fail "EXPECTED_JOB_MATRIX for '$gate_job' is '$want_matrix' ($matrix_found row(s)); workflow says '$got_matrix'."
	fi
	for forbidden in "${FORBIDDEN_ACTIVATION_LITERALS[@]}"; do
		case ";$got;" in *";$forbidden;"*) activation_fail "gate job '$gate_job' uses forbidden non-blocking activation '$forbidden'." ;; esac
	done
	case "$got" in *";needs="?*) activation_fail "gate job '$gate_job' has job-level needs; this binding requires its sole gate job to activate independently." ;; esac
done

# A guard that examined nothing must not report OK — the same vacuity rule the
# conformance guards apply (#lzvacuousrun). An oracle miss counts as examined:
# the target was measured and REFUSED, and letting it fall through to this line
# would replace a precise diagnosis with 'nothing was verified'.
if [ "$((reached + excused_ok + unreached_count + oracle_miss_count + step_map_miss_count))" -eq 0 ]; then
	echo "check-ci-reach: '$ROOT_TARGET' has no prerequisite target carrying a gate — nothing was verified" >&2
	exit 1
fi

status=0
if [ "$activation_error_count" -gt 0 ]; then
	echo >&2
	echo "check-ci-reach: workflow/job activation is not pinned and blocking (#verifyworkflowactually):" >&2
	while IFS= read -r line; do
		[ -n "$line" ] || continue
		printf '  - %s\n' "$line" >&2
	done <<<"$activation_errors"
	status=1
fi
if [ "$stale_count" -gt 0 ]; then
	echo >&2
	while IFS= read -r t; do
		[ -n "$t" ] || continue
		echo "check-ci-reach: '$t' is excused in $CONF but CI DOES reach it — remove the excuse" >&2
	done <<<"$stale"
	status=1
fi

if [ "$unreached_count" -gt 0 ]; then
	echo >&2
	echo "check-ci-reach: $unreached_count target(s) run by 'make $ROOT_TARGET' that no CI run: step reaches:" >&2
	while IFS= read -r t; do
		[ -n "$t" ] || continue
		echo "  - $t" >&2
	done <<<"$unreached"
	echo >&2
	echo "Reach is measured INSIDE each member's pinned CI step (EXPECTED_GATE_STEPS in" >&2
	echo "$0). So: add the command to that step; or, if CI runs the gate in a DIFFERENT" >&2
	echo "step, correct the member's pin; or add an excuse with a reason to $CONF. If the" >&2
	echo "recipe is what changed, it is the recipe that stopped running the gate." >&2
	status=1
fi

# The collision rung first: it says whether the oracle's verdict can be trusted
# at all, so a reader must see it before the oracle's.
if [ "$collision_count" -gt 0 ]; then
	echo >&2
	printf '%s' "$collisions" >&2
	status=1
fi

if [ "$step_map_miss_count" -gt 0 ]; then
	echo >&2
	printf '%s' "$step_map_misses" >&2
	status=1
fi

if [ "$oracle_miss_count" -gt 0 ]; then
	echo >&2
	printf '%s\n' "$oracle_misses" >&2
	if [ "$collision_count" -gt 0 ]; then
		echo "  (read the anchor collision above first — with two members reduced to one" >&2
		echo "   anchor set, the oracle was comparing fewer commands than it lists.)" >&2
	fi
	status=1
fi

if [ "$pin_error_count" -gt 0 ]; then
	echo >&2
	echo "check-ci-reach: the pinned closure of '$ROOT_TARGET' no longer matches what \`make\` runs:" >&2
	# One bullet per entry; an entry's own continuation lines are already indented
	# and must not each get a bullet of their own.
	while IFS= read -r line; do
		[ -n "$line" ] || continue
		case "$line" in
		[[:space:]]*) printf '    %s\n' "$(printf '%s' "$line" | sed 's/^[[:space:]]*//')" >&2 ;;
		*) printf '  - %s\n' "$line" >&2 ;;
		esac
	done <<<"$(printf '%s' "$pin_errors")"
	echo >&2
	echo "EXPECTED_CLOSURE_TARGETS, EXPECTED_NO_GATE_TARGETS, EXPECTED_GATE_STEPS and" >&2
	echo "EXPECTED_MAKE_INVOKED_MEMBERS live in $0. They are exact sets, not floors: the" >&2
	echo "point is that dropping a gate becomes a required, reviewable edit instead of a" >&2
	echo "count moving by one." >&2
	status=1
fi

if [ "$status" -eq 0 ]; then
	echo "check-ci-reach: OK — $reached target(s) reached by CI, $excused_ok excused, $nogate_count carrying no gate"
	echo "check-ci-reach: OK — closure pinned at ${#EXPECTED_CLOSURE_TARGETS[@]} target(s), ${#EXPECTED_NO_GATE_TARGETS[@]} of them legitimately carrying no gate; every gated command found in \`$MAKE_BIN -n $ROOT_TARGET\`, no two members sharing an anchor set"
	echo "check-ci-reach: OK — ${#EXPECTED_GATE_STEPS[@]} gate(s) pinned to an exact workflow/job/step identity, each step unique, unconditional, and running every anchor; ${#EXPECTED_MAKE_INVOKED_MEMBERS[@]} make-invoked member(s) pinned to an activation container"
	echo "check-ci-reach: OK — ${#EXPECTED_TRIGGERS[@]} workflow trigger set(s), ${#EXPECTED_TRIGGER_FILTERS[@]} trigger filter set(s), ${#EXPECTED_GATE_JOBS[@]} gate job(s), exact activation and matrix values, plus push/PR/main/no-path/blocking floors"
fi
exit "$status"
