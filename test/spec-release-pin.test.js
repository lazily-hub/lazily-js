import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SPEC_TAG = "v0.43.0";
const SPEC_COMMIT = "4b34879b26566a0616b97cf661ac4f1a23762af6";

function workflow(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("CI and release verification pin the same immutable lazily-spec release", () => {
  const ci = workflow(".github/workflows/ci.yml");
  const release = workflow(".github/workflows/release.yml");

  assert.match(
    ci,
    new RegExp(
      `git clone --depth 1 --branch ${SPEC_TAG.replaceAll(".", "\\.")} ` +
        "https://github\\.com/lazily-hub/lazily-spec\\.git \\.\\./lazily-spec",
    ),
    "CI must fetch the named lazily-spec release tag",
  );
  assert.ok(
    ci.includes(`rev-parse HEAD)\" = \"${SPEC_COMMIT}\"`),
    "CI must verify that the release tag peels to the reviewed commit",
  );
  assert.match(
    release,
    new RegExp(
      `repository: lazily-hub/lazily-spec[\\s\\S]*?ref: ${SPEC_COMMIT}[\\s\\S]*?path: lazily-spec`,
    ),
    "release verification must check out the reviewed lazily-spec commit",
  );
});
