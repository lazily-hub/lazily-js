.PHONY: check fmt fmt-fix build typecheck test test-interop-peer conformance-coverage assertion-keys \
scenario-coverage assertion-ordering-check ci-reach bench bench-scale benchmark benchmark-update benchmark-check

# Every gate is its own target rather than a line in one monolithic recipe. A
# monolithic `check` is opaque to the CI-reachability guard below: it can only
# report the whole target as reached or missing, so a reader cannot see WHICH
# gate CI stopped running. Split like this, the guard prints one line per gate.
# The order here is the order the gates must run in: the conformance rungs audit
# evidence files that `test` writes, so they are useless before it.
check: fmt build typecheck test test-interop-peer conformance-coverage assertion-keys \
scenario-coverage assertion-ordering-check ci-reach

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
