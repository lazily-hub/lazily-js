#!/usr/bin/env bash
# Conformance-coverage guard (#portconformancecoverage).
#
# Fails the build when the canonical corpus in ../lazily-spec/conformance/ grows a
# fixture that no test in this repo even mentions. That is the drift this guard
# exists for: a fixture lands upstream, every binding stays green, and nobody
# learns that one of them is not replaying it.
#
# This binding uses the RUNTIME manifest, not the static grep it started with
# (#lazilyupgradeconformance). `test/support/conformance-manifest.cjs` is preloaded
# into the test run and records every file the suite actually reads from the
# conformance corpus. So a fixture named in a comment but hand-transcribed — the
# drift found in lazily-cpp's queue tests — is caught here, which a source grep
# cannot do.
#
# A missing manifest is missing EVIDENCE and fails. It is not "no fixtures were
# read"; it means the suite was not run with the recorder attached, and passing in
# that state is exactly the vacuous green this guard exists to prevent.
set -euo pipefail

SPEC_DIR="${LAZILY_SPEC_CONFORMANCE_DIR:-../lazily-spec/conformance}"

# A missing corpus is a legitimate local state (no sibling checkout) and an
# illegitimate CI state (#lzvacuousrun). Skipping under CI is the vacuous green
# this guard exists to prevent: every rung below reasons about fixtures the run
# OPENED, so an absent corpus reports OK over nothing at all — zero opened
# fixtures also means zero uncovered fixtures and zero stale excuses, so nothing
# else here can contradict it. This mirrors how the missing MANIFEST below is
# already treated: missing evidence, not evidence of absence. Locally it stays a
# skip, because a contributor without the sibling is not making a false claim.
if [ ! -d "$SPEC_DIR" ]; then
  if [ -n "${CI:-}" ]; then
    echo "ERROR: canonical corpus not found at $SPEC_DIR, and CI is set." >&2
    echo "       Under CI this is missing EVIDENCE, not evidence of absence: the" >&2
    echo "       checkout is wrong, not the corpus. Exiting 0 here would report" >&2
    echo "       conformance OK having examined zero fixtures (#lzvacuousrun)." >&2
    exit 1
  fi
  echo "SKIP: canonical corpus not found at $SPEC_DIR (clone the lazily-spec sibling)" >&2
  echo "      Local checkout only — this would be a hard failure under CI." >&2
  exit 0
fi

# Fixtures deliberately not covered by this binding yet. Each entry is a claim that
# someone looked; shrinking this list is the work. Adding to it silently is how the
# guard rots, so keep a reason with any new entry.
#
# This is the coarsest of three allowlists at three resolutions. Read it together
# with `EXCUSED_SCENARIOS` in scripts/check-scenario-coverage.mjs (individual
# scenarios of a fixture this binding DOES open, #lzscenariocoverage) and
# `DECLARED_UNCONSUMED` in scripts/check-assertion-keys.mjs (individual assertion
# keys it does not consume). Between them they are the complete statement of what
# lazily-js does not prove against the canonical corpus. A scenario of a fixture
# listed HERE must not also appear in EXCUSED_SCENARIOS — that guard rejects it,
# because the fixture is never opened and the gap is already reported on this line.
KNOWN_UNCOVERED=(
  "arena_blob.json"
  "reliable-sync/coalesce_bounds_outbox.json"
  "reliable-sync/liveness_lease_eviction.json"
  # The canonical journal-decoder trace has no JavaScript replay runner yet.
  "reliable-sync/outbox_journal_decode.json"
)

MANIFEST="${LAZILY_CONFORMANCE_MANIFEST:-build/conformance-fixtures-loaded.txt}"
TEST_DIRS=("test")
EXTS=(".js")

collect_sources() {
  for d in "${TEST_DIRS[@]}"; do
    [ -d "$d" ] || continue
    for e in "${EXTS[@]}"; do
      find "$d" -type f -name "*$e" -print0
    done
  done
}

if [ ! -s "$MANIFEST" ]; then
  echo "FAIL: no conformance manifest at $MANIFEST." >&2
  echo "      Run the suite with LAZILY_CONFORMANCE_MANIFEST set and the recorder" >&2
  echo "      preloaded (see the \`test\` script in package.json). An absent manifest" >&2
  echo "      is missing evidence, not evidence of absence." >&2
  exit 1
fi
OPENED="$(sort -u "$MANIFEST")"

missing=0
total=0
covered=0
while IFS= read -r fixture; do
  total=$((total + 1))
  name="$(basename "$fixture")"
  # Here-string, NOT a pipe. With `set -o pipefail`, `printf ... | grep -q` reports
  # FAILURE when grep matches: grep -q exits immediately on the first hit, printf
  # takes SIGPIPE writing the rest, and pipefail surfaces printf's death as the
  # pipeline's status. The check then inverts — every covered fixture is reported
  # missing. That is exactly how it behaved before this line changed.
  if grep -qxF "$fixture" <<< "$OPENED"; then
    covered=$((covered + 1))
    continue
  fi
  excused=0
  for known in "${KNOWN_UNCOVERED[@]:-}"; do
    if [ "$known" = "$fixture" ]; then excused=1; break; fi
  done
  if [ "$excused" -eq 0 ]; then
    echo "ERROR: canonical fixture '$fixture' was NOT opened by the suite." >&2
    echo "       A runner may still name it in source while no longer reading it —" >&2
    echo "       that is the drift this manifest exists to catch. Replay it, or add it" >&2
    echo "       to KNOWN_UNCOVERED with a reason." >&2
    missing=$((missing + 1))
  fi
done < <(cd "$SPEC_DIR" && find . -name '*.json' | sed 's|^\./||' | sort)

# A stale allowlist is its own drift, in two directions (#lzcovallowlistrot):
#
#   1. An entry naming a fixture that no longer exists means the corpus moved and
#      nobody updated the excuse.
#   2. An entry naming a fixture the suite DOES open means the excuse outlived the
#      gap it described. That rot understates coverage — the guard keeps reporting
#      a fixture as known-uncovered while the suite is in fact replaying it, and
#      nothing here would ever notice.
#
# The covered-check above and the stale-check below use the same `grep -qxF`
# against the same `$OPENED` set on purpose: an entry can never be counted as
# covered by one and excused by the other.
for known in "${KNOWN_UNCOVERED[@]:-}"; do
  if [ ! -f "$SPEC_DIR/$known" ]; then
    echo "ERROR: KNOWN_UNCOVERED lists '$known', which is not in the canonical corpus." >&2
    missing=$((missing + 1))
    continue
  fi
  if grep -qxF "$known" <<< "$OPENED"; then
    echo "ERROR: KNOWN_UNCOVERED lists '$known', but the suite DID open it." >&2
    echo "       The excuse is stale: this fixture is covered. Delete the entry from" >&2
    echo "       KNOWN_UNCOVERED in $0 — an excuse left behind understates coverage" >&2
    echo "       and hides the fact that the gap it named is already closed." >&2
    missing=$((missing + 1))
  fi
done

# ---- The evidence channel guards itself ----
#
# Everything above asks "did the suite open fixture X?" and answers it out of the
# manifest; nothing yet asks whether the manifest is describing THIS corpus. A
# recorded id that resolves to no file under $SPEC_DIR means the recorder dropped
# or interleaved writes, or the evidence file is left over from a run against a
# different corpus — and coverage computed from it is wrong in both directions:
# the count is inflated by ids nobody can resolve, and a fixture the suite
# stopped opening can hide behind them. The scenario ledger in
# check-scenario-coverage.mjs already makes this check on its own ids; this is
# the fixture-manifest half.
while IFS= read -r id; do
  [ -n "$id" ] || continue
  if [ ! -f "$SPEC_DIR/$id" ]; then
    echo "ERROR: manifest records '$id', which names no file in $SPEC_DIR." >&2
    echo "       The recorder is dropping or interleaving writes, or this evidence" >&2
    echo "       file was written against a different corpus; coverage computed from" >&2
    echo "       this manifest cannot be trusted." >&2
    missing=$((missing + 1))
  fi
done <<< "$OPENED"

if [ "$missing" -gt 0 ]; then
  echo "conformance coverage FAILED: $missing problem(s)" >&2
  exit 1
fi

# ---- Positive-evidence floor (#lzvacuousrun) ----
# Everything above reasons about fixtures this run OPENED, so all of it is
# vacuously satisfied by an empty population: zero fixtures means zero uncovered
# fixtures and zero stale excuses. The loop cannot distinguish "nothing is wrong"
# from "nothing was examined", so assert the magnitude explicitly before
# reporting OK. Do not lower these to fix a red run — a drop here means the
# corpus or the recorder shrank, which is the finding.
# Raised 130 -> 131 when codec/blob_backend_discriminator.json landed
# (#lzblobbackendstrict) and took the observed run from 135 to 136 opened.
# Raised 131 -> 132 for capability-handshake negotiation
# (#lzhandshakedeadfields), which took the observed run from 136 to 137 opened.
MIN_FIXTURES="${MIN_FIXTURES:-132}"
if [ "$total" -eq 0 ]; then
  echo "ERROR: the corpus at $SPEC_DIR listed ZERO fixtures." >&2
  echo "       Every check above is vacuously green over an empty population." >&2
  exit 1
fi
if [ "$covered" -lt "$MIN_FIXTURES" ]; then
  echo "ERROR: only $covered distinct canonical fixtures were OPENED, expected >= $MIN_FIXTURES." >&2
  echo "       A replay was removed, renamed, or short-circuited, or the recorder" >&2
  echo "       detached mid-run. Do not lower MIN_FIXTURES to fix this." >&2
  exit 1
fi

echo "conformance coverage OK: $covered/$total canonical fixtures OPENED by the suite" \
     "(${#KNOWN_UNCOVERED[@]} listed as known-uncovered; runtime manifest — these bytes were really read)"
