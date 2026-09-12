.PHONY: check fmt fmt-fix build typecheck test test-interop-peer conformance-coverage assertion-keys \
scenario-coverage assertion-ordering-check flag-hygiene ci-reach bench bench-scale benchmark benchmark-update \
benchmark-check

# ---- One run id per invocation (#lzstalemanifest) ----
#
# The four evidence files under build/ are written by the recorder preloaded into
# `npm test` and read afterwards by three SEPARATE processes (the conformance
# rungs below). Nothing in that handoff used to prove the bytes came from THIS
# invocation. `node --test` keeps no test cache, so the exposure here is not a
# cached test task but the LEFTOVER FILE: build/ holds whatever the last writer
# left, including a single-file run with the four manifest env vars set by hand
# (how #lzsiblingrunnermasking bisected 70 runners one at a time). Demonstrated
# with no node process started at all: rungs 1-4 read an earlier run's manifests
# and reported 147/156 fixtures, 638/638 blocks, 3813 asserted keys and 157/157
# scenarios OK.
#
# `:=` and not `=`: a recursively-expanded variable re-runs $(shell) at every
# reference, so `test` would stamp one id and the rungs would demand another --
# which fails closed, but for the wrong reason and with a message that sends the
# reader hunting a stale file that does not exist.
#
# An id already in the ENVIRONMENT is kept, which is how one CI job hands one id
# to its separate test and rung steps. `origin` and not `?=`, because `?=`
# defines a recursively-expanded variable and would reintroduce exactly the
# re-expansion this comment rules out.
#
# Consequence, and it is the intended one: a guard reached in a DIFFERENT make
# invocation from the one that ran the tests refuses, because its id is new. Run
# them together -- `make check`, or `make test assertion-keys` for one gate. To
# re-read a gate against evidence already on disk, adopt that run's id in the
# open:
#   LAZILY_CONFORMANCE_RUN_ID=$$(sed -n '1s/^# lazily-run-id //p' \
#     build/conformance-fixtures-loaded.txt) node scripts/check-assertion-keys.mjs
# There is deliberately no flag for it. A flag that lets a guard accept evidence
# it cannot date is the hole this variable closes, wearing a name.
ifeq ($(origin LAZILY_CONFORMANCE_RUN_ID),undefined)
LAZILY_CONFORMANCE_RUN_ID := $(shell printf 'make-%s-%s' "$$(date +%s%N)" "$$$$")
endif
export LAZILY_CONFORMANCE_RUN_ID

# Every gate is its own target rather than a line in one monolithic recipe. A
# monolithic `check` is opaque to the CI-reachability guard below: it can only
# report the whole target as reached or missing, so a reader cannot see WHICH
# gate CI stopped running. Split like this, the guard prints one line per gate.
# The order here is the order the gates must run in: the conformance rungs audit
# evidence files that `test` writes, so they are useless before it.
check: fmt build typecheck test test-interop-peer conformance-coverage assertion-keys \
scenario-coverage assertion-ordering-check flag-hygiene ci-reach

# The formatting GATE (#lazilyformattinggate). This binding had no formatting
# floor: `build` is the lint equivalent (node --check per entry point) and
# `typecheck` reads like it might cover style, but neither looks at formatting,
# so drift stayed invisible until someone read a diff.
#
# prettier is pinned to an EXACT version in devDependencies — no caret. Three
# gates in this family have now been bitten by pinning the style and not the
# implementation (clang-format defaults moving between majors, zig `master`
# resolving to a different nightly in CI than locally, `dart format` picking a
# different style from build state). A caret range would reintroduce exactly
# that: prettier ships style changes in minors, so `^3.9.6` is a gate whose
# verdict changes on npm's schedule rather than on anything a contributor did.
#
# --check is the gate; `fmt-fix` writes and is not in `check`.
fmt:
	npm run format

fmt-fix:
	npm run format:fix

# `npm run build` is this repo's lint equivalent: it syntax-checks every
# published entry point with `node --check` and regenerates the size budgets.
build:
	npm run build

typecheck:
	npm run typecheck

test:
	npm test

test-interop-peer:
	npm run test:interop-peer

conformance-coverage:
	./scripts/check-conformance-coverage.sh

assertion-keys:
	node scripts/check-assertion-keys.mjs

scenario-coverage:
	node scripts/check-scenario-coverage.mjs

assertion-ordering-check:
	python3 ../lazily-spec/scripts/check-assertion-ordering.py --binding js --root .

# Fails when a test COERCES a value the canonical corpus spells as a JSON boolean
# (#lzsiblingrunnermasking). Reads only the corpus and the test sources, so unlike
# the four rungs above it needs no evidence file and does not depend on `test`.
flag-hygiene:
	node scripts/check-flag-hygiene.mjs

# Fails when `make check` runs a gate no CI workflow reaches (#lzcheckcireachguard).
# The interop peer gate sat in every binding's `check` and in no binding's
# workflow for months. It guards itself: `ci-reach` is in `check`, so CI has to
# run it too or this guard reports itself MISSING.
ci-reach:
	./scripts/check-ci-reach.sh

bench:
	node bench/context.bench.mjs

bench-scale:
	node --max-old-space-size=8192 bench/scale.bench.mjs

benchmark:
	node scripts/run-benchmarks.mjs

benchmark-update:
	node scripts/run-benchmarks.mjs

benchmark-check:
	node scripts/run-benchmarks.mjs --check
