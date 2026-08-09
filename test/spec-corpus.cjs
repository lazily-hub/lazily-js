// The ONE place this repo resolves the canonical lazily-spec corpus
// (#lzoverrideallrunners).
//
// Every conformance runner used to spell `join(here, "..", "..",
// "lazily-spec", "conformance", ...)` for itself — forty-odd copies of the same
// sibling-relative constant. Three of them had since grown a
// `LAZILY_SPEC_CONFORMANCE_DIR` override and the rest had not, which meant the
// SUITE and the three coverage guards that audit it (`check-conformance-coverage.sh`,
// `check-assertion-keys.mjs`, `check-scenario-coverage.mjs`, all of which read
// that env var) could be pointed at two DIFFERENT corpora. A
// corpus-perturbation probe — copy the corpus, flip one assertion value, prove
// the suite reddens — could not reach the runners at all, so "the suite really
// replays the corpus" was an untested claim.
//
// Routing every runner through here makes the override work BY CONSTRUCTION: a
// runner cannot opt out without reintroducing the sibling path, and
// `test/conformance-guard.test.js` fails when one does.
//
// CJS on purpose. `test/support/conformance-manifest.cjs` is preloaded with
// `node --require` and must attribute fixture opens relative to the SAME
// resolved root; a CJS module can be `require`d by the recorder and `import`ed
// by the ESM runners, so there is exactly one resolution and no second copy to
// drift.
//
// Scope of the override: the CONFORMANCE corpus only, which is what the env var
// names. `lazily-spec/schemas` and the other non-corpus subtrees always resolve
// against the canonical sibling (see `schemaPath`), because a scratch copy of
// the conformance corpus does not carry them and silently resolving them under
// it would turn a schema gate green over nothing.
const fs = require("node:fs");
const path = require("node:path");

const ENV_VAR = "LAZILY_SPEC_CONFORMANCE_DIR";

// test/ -> repo root -> sibling checkout.
const canonicalSpecRoot = path.join(__dirname, "..", "..", "lazily-spec");
const canonicalConformanceRoot = path.join(canonicalSpecRoot, "conformance");

const override = process.env[ENV_VAR];
const overrideActive = override !== undefined;

// An explicitly-set-but-unreadable override FAILS CLOSED. It must never fall
// back to the canonical sibling (a probe would then silently measure the
// unperturbed corpus and report a vacuous green) and it must never degrade to a
// skip (a skip is the same vacuous green wearing a different colour). An empty
// value is a set value: it is a broken path, not an absent one.
function resolveConformanceRoot() {
  if (!overrideActive) return canonicalConformanceRoot;
  const resolved = override === "" ? "" : path.resolve(override);
  let stat = null;
  try {
    stat = fs.statSync(resolved);
  } catch (cause) {
    throw new Error(
      `${ENV_VAR}=${JSON.stringify(override)} is set but cannot be read (${cause.code ?? cause.message}). ` +
        "An explicit corpus override must not fall back to the canonical sibling: " +
        "falling back would replay the UNPERTURBED corpus and report a green that proves nothing.",
      { cause },
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `${ENV_VAR}=${JSON.stringify(override)} is set but is not a directory. ` +
        "An explicit corpus override must name the conformance root, e.g. /tmp/scratch-corpus/conformance.",
    );
  }
  return resolved;
}

const conformanceRoot = resolveConformanceRoot();

/** Absolute path of the given corpus-relative segments inside the resolved corpus. */
function specPath(...segments) {
  return path.join(conformanceRoot, ...segments);
}

/** Whether the given corpus-relative segments exist inside the resolved corpus. */
function fixtureExists(...segments) {
  return fs.existsSync(specPath(...segments));
}

const CLONE_HINT =
  "clone the canonical sibling: " +
  "git clone --depth 1 https://github.com/lazily-hub/lazily-spec.git ../lazily-spec";

function missingFixtureMessage(...segments) {
  const where = overrideActive ? `${ENV_VAR}=${override}` : "the canonical sibling";
  return (
    `missing canonical spec fixture ${specPath(...segments)} (corpus root from ${where}) — ` +
    CLONE_HINT
  );
}

/** Raw UTF-8 text of a corpus fixture. Throws — never skips — when absent. */
function readFixtureText(...segments) {
  if (!fixtureExists(...segments)) throw new Error(missingFixtureMessage(...segments));
  return fs.readFileSync(specPath(...segments), "utf8");
}

/** Parsed corpus fixture. Throws — never skips — when absent. */
function loadFixture(...segments) {
  return JSON.parse(readFixtureText(...segments));
}

/** `.json` entries of a corpus directory, sorted. Throws when the directory is absent. */
function listFixtures(...segments) {
  const dir = specPath(...segments);
  if (!fs.existsSync(dir)) throw new Error(missingFixtureMessage(...segments));
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

/**
 * Non-corpus spec assets (JSON Schema, proto, docs). ALWAYS canonical: the
 * conformance override deliberately does not move these, see the header.
 */
const schemasRoot = path.join(canonicalSpecRoot, "schemas");

function schemaPath(relativePath) {
  return path.join(schemasRoot, relativePath);
}

module.exports = {
  ENV_VAR,
  CLONE_HINT,
  canonicalSpecRoot,
  canonicalConformanceRoot,
  conformanceRoot,
  overrideActive,
  specPath,
  fixtureExists,
  readFixtureText,
  loadFixture,
  listFixtures,
  schemasRoot,
  schemaPath,
  missingFixtureMessage,
};
