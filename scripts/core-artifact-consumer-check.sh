#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/lazily-js-core-consumer.XXXXXX")"
trap 'rm -rf "$work"' EXIT

artifact_dir="$work/artifact"
consumer_dir="$work/consumer"
mkdir -p "$artifact_dir" "$consumer_dir"

cp "$root/tests/core-artifact-consumer/package.json" "$consumer_dir/package.json"
cp "$root/tests/core-artifact-consumer/index.mjs" "$consumer_dir/index.mjs"

cd "$consumer_dir"
if [[ -n "${LAZILY_CORE_ARTIFACT_VERSION:-}" ]]; then
  npm install --ignore-scripts --no-audit --no-fund "@lazily-hub/lazily-js@$LAZILY_CORE_ARTIFACT_VERSION"
else
  package_json="$(cd "$root" && npm pack --ignore-scripts --pack-destination "$artifact_dir" --json --silent)"
  archive="$(node -e 'const r=JSON.parse(process.argv[1]); console.log((Array.isArray(r)?r:Object.values(r))[0].filename)' "$package_json")"
  npm install --ignore-scripts --no-audit --no-fund "$artifact_dir/$archive"
fi
node index.mjs

if grep -R -F "$root" package-lock.json node_modules/.package-lock.json >/dev/null 2>&1; then
  echo "core artifact consumer resolved the source checkout" >&2
  exit 1
fi

if [[ -n "${LAZILY_CORE_ARTIFACT_VERSION:-}" ]]; then
  node -e 'const p=require("./node_modules/@lazily-hub/lazily-js/package.json"); if (p.version !== process.argv[1]) process.exit(1)' "$LAZILY_CORE_ARTIFACT_VERSION"
fi
