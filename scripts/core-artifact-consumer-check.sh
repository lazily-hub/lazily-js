#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/lazily-js-core-consumer.XXXXXX")"
trap 'rm -rf "$work"' EXIT

artifact_dir="$work/artifact"
consumer_dir="$work/consumer"
mkdir -p "$artifact_dir" "$consumer_dir"

package_json="$(npm pack --ignore-scripts --pack-destination "$artifact_dir" --json --silent)"
archive="$(node -e 'const r=JSON.parse(process.argv[1]); console.log((Array.isArray(r)?r:Object.values(r))[0].filename)' "$package_json")"
cp "$root/tests/core-artifact-consumer/package.json" "$consumer_dir/package.json"
cp "$root/tests/core-artifact-consumer/index.mjs" "$consumer_dir/index.mjs"

cd "$consumer_dir"
npm install --ignore-scripts --no-audit --no-fund "$artifact_dir/$archive"
node index.mjs

if grep -R -F "$root" package-lock.json node_modules/.package-lock.json >/dev/null 2>&1; then
  echo "core artifact consumer resolved the source checkout" >&2
  exit 1
fi
