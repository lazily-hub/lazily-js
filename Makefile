.PHONY: check typecheck bench bench-scale benchmark benchmark-update benchmark-check

check:
	npm run build
	npm run typecheck
	npm test
	npm run test:interop-peer
	./scripts/check-conformance-coverage.sh
	node scripts/check-assertion-keys.mjs

typecheck:
	npm run typecheck

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
