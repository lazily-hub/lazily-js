.PHONY: check bench benchmark benchmark-update benchmark-check

check:
	npm run build
	npm test

bench:
	node bench/context.bench.mjs

benchmark:
	node scripts/run-benchmarks.mjs

benchmark-update:
	node scripts/run-benchmarks.mjs

benchmark-check:
	node scripts/run-benchmarks.mjs --check
