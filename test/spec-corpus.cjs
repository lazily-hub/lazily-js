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
// names. `lazily-spec/schemas` and the other non-corpus subtrees are NOT moved
// by it, because a scratch copy of the conformance corpus does not carry them
// and silently resolving them under it would turn a schema gate green over
// nothing.
//
// That scoping is preserved and its consequence is not (#lzspecschemasoverride).
// The schemas root used to be a hardcoded `../lazily-spec/schemas` with no
// override at all, so a probe that needed to perturb a SCHEMA — flip a
// `type_tag` out of the closed `agent-doc-state.json` enum, change a `required`
// list `schema-conformance.test.js` validates against — had nowhere to point
// except the shared sibling checkout. Perturbing that dirties a repo ten
// bindings read and reddens all ten at once, so nobody did, and "these runners
// really validate against these bytes" stayed an untested claim — the same
// defect #lzoverrideallrunners fixed one level up for the corpus.
//
// `LAZILY_SPEC_SCHEMAS_DIR` is therefore a SECOND, INDEPENDENT override. Neither
// variable derives from the other, so a corpus-only scratch copy still resolves
// schemas canonically (the property the hardcoded path was buying), and a
// schemas-only scratch copy still replays the canonical corpus.
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

// ---------------------------------------------------------------------------
// Schemas seam (#lzspecschemasoverride)
// ---------------------------------------------------------------------------

const SCHEMAS_ENV_VAR = "LAZILY_SPEC_SCHEMAS_DIR";

const canonicalSchemasRoot = path.join(canonicalSpecRoot, "schemas");

const schemasOverride = process.env[SCHEMAS_ENV_VAR];
const schemasOverrideActive = schemasOverride !== undefined;

// Same fail-closed rule as `resolveConformanceRoot`, for the same reason. An
// explicitly-set-but-unreadable schemas root must never fall back to the
// canonical sibling (a probe would then validate against the UNPERTURBED
// schemas and report a vacuous green) and must never degrade to a skip. An
// empty value is a set value: a broken path, not an absent one.
//
// Resolution is EAGER and throws at module load, which is this binding's
// equivalent of lazily-go's TestMain guard: every runner imports this module, so
// a broken override cannot be routed around by running a subset of the suite.
function resolveSchemasRoot() {
  if (!schemasOverrideActive) return canonicalSchemasRoot;
  const resolved = schemasOverride === "" ? "" : path.resolve(schemasOverride);
  let stat = null;
  try {
    stat = fs.statSync(resolved);
  } catch (cause) {
    throw new Error(
      `${SCHEMAS_ENV_VAR}=${JSON.stringify(schemasOverride)} is set but cannot be read (${cause.code ?? cause.message}). ` +
        "An explicit schemas override must not fall back to the canonical sibling: " +
        "falling back would validate against the UNPERTURBED schemas and report a green that proves nothing.",
      { cause },
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `${SCHEMAS_ENV_VAR}=${JSON.stringify(schemasOverride)} is set but is not a directory. ` +
        "An explicit schemas override must name the JSON-schema root, e.g. /tmp/scratch-schemas.",
    );
  }
  return resolved;
}

/**
 * Non-corpus spec assets (JSON Schema, proto, docs). The canonical sibling
 * unless `LAZILY_SPEC_SCHEMAS_DIR` names another root; the CONFORMANCE override
 * deliberately does not move these, see the header.
 */
const schemasRoot = resolveSchemasRoot();

function schemaPath(relativePath) {
  return path.join(schemasRoot, relativePath);
}

module.exports = {
  ENV_VAR,
  SCHEMAS_ENV_VAR,
  CLONE_HINT,
  canonicalSpecRoot,
  canonicalConformanceRoot,
  canonicalSchemasRoot,
  conformanceRoot,
  overrideActive,
  schemasOverrideActive,
  specPath,
  fixtureExists,
  readFixtureText,
  loadFixture,
  listFixtures,
  schemasRoot,
  schemaPath,
  missingFixtureMessage,
};
