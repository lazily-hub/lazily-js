.PHONY: check bench bench-scale benchmark benchmark-update benchmark-check

check:
	npm run build
	npm test
	npm run test:interop-peer
	./scripts/check-conformance-coverage.sh

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
