.PHONY: check build typecheck test test-interop-peer conformance-coverage assertion-keys \
    scenario-coverage ci-reach bench bench-scale benchmark benchmark-update benchmark-check

# Every gate is its own target rather than a line in one monolithic recipe. A
# monolithic `check` is opaque to the CI-reachability guard below: it can only
# report the whole target as reached or missing, so a reader cannot see WHICH
# gate CI stopped running. Split like this, the guard prints one line per gate.
# The order here is the order the gates must run in: the conformance rungs audit
# evidence files that `test` writes, so they are useless before it.
check: build typecheck test test-interop-peer conformance-coverage assertion-keys \
    scenario-coverage ci-reach

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
