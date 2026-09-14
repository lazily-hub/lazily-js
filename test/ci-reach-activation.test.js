// Workflow/job activation regression matrix (#verifyworkflowactually).
//
// Every case runs the real guard against a private scratch tree. The healthy
// precheck is load-bearing: a red baseline makes an expected-red mutation
// vacuous, and a skipped replacement is indistinguishable from a survived one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const workflow = ".github/workflows/ci.yml";
const onBlock = `on:
  push:
    branches:
      - main
  pull_request:
  workflow_dispatch:
`;
const jobLine = "  test:\n";

function scratchTree() {
  const root = mkdtempSync(join(tmpdir(), "lazily-js-ci-reach-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  for (const relative of [
    "Makefile",
    "scripts/check-ci-reach.sh",
    "scripts/ci-reach.conf",
    workflow,
  ]) {
    copyFileSync(join(repoRoot, relative), join(root, relative));
  }
  return root;
}

function runGuard(root) {
  return spawnSync("bash", ["scripts/check-ci-reach.sh"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function replaceOnce(root, relative, before, after) {
  const path = join(root, relative);
  const source = readFileSync(path, "utf8");
  assert.equal(
    source.split(before).length - 1,
    1,
    `mutation target must occur exactly once in ${relative}: ${JSON.stringify(before)}`,
  );
  const changed = source.replace(before, after);
  assert.notEqual(changed, source, `mutation did not change ${relative}`);
  writeFileSync(path, changed);
}

function healthy(root) {
  const result = runGuard(root);
  assert.equal(
    result.status,
    0,
    `unmutated scratch tree is not green:\n${result.stdout}${result.stderr}`,
  );
  assert.match(result.stdout, /exact activation and matrix values/);
}

function mutateAndRun(mutate) {
  const root = scratchTree();
  try {
    healthy(root);
    mutate(root);
    return runGuard(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function assertRed(result, diagnostic) {
  assert.equal(result.status, 1, `mutation was accepted:\n${result.stdout}${result.stderr}`);
  assert.match(result.stderr, diagnostic);
}

test("activation literals describe the checked-in workflow", () => {
  const workflowSource = readFileSync(join(repoRoot, workflow), "utf8");
  const guardSource = readFileSync(join(repoRoot, "scripts", "check-ci-reach.sh"), "utf8");
  assert.equal(workflowSource.split(onBlock).length - 1, 1);
  for (const literal of [
    ".github/workflows/ci.yml|pull_request,push,workflow_dispatch",
    ".github/workflows/ci.yml|push|branches=main",
    ".github/workflows/ci.yml|test|continue-on-error=;if=;needs=",
    '\t".github/workflows/ci.yml|test|"\n',
  ]) {
    assert.equal(
      guardSource.split(literal).length - 1,
      1,
      `activation literal must appear exactly once: ${literal}`,
    );
  }
});

for (const [label, injected] of [
  ["job if false", "    if: false\n"],
  ["job condition false on required events", "    if: github.event_name == 'schedule'\n"],
  ["job continue-on-error", "    continue-on-error: true\n"],
  ["job dependency", "    needs: setup\n"],
]) {
  test(`${label} is refused`, () => {
    const result = mutateAndRun((root) => replaceOnce(root, workflow, jobLine, jobLine + injected));
    assertRed(result, /EXPECTED_JOB_ACTIVATION|requires its sole gate job|non-blocking/);
  });
}

test("dispatch-only workflow is refused", () => {
  const result = mutateAndRun((root) =>
    replaceOnce(root, workflow, onBlock, "on:\n  workflow_dispatch:\n"),
  );
  assertRed(result, /EXPECTED_TRIGGERS/);
});

test("removing the pull_request trigger is refused", () => {
  const result = mutateAndRun((root) => replaceOnce(root, workflow, "  pull_request:\n", ""));
  assertRed(result, /REQUIRED_TRIGGERS|EXPECTED_TRIGGERS/);
});

test("adding a trigger is refused in the surplus direction", () => {
  const result = mutateAndRun((root) =>
    replaceOnce(
      root,
      workflow,
      "  workflow_dispatch:\n",
      "  schedule:\n    - cron: '0 0 * * *'\n  workflow_dispatch:\n",
    ),
  );
  assertRed(result, /unsupported YAML shape|EXPECTED_TRIGGERS/);
});

test("narrowing push away from main is refused", () => {
  const result = mutateAndRun((root) =>
    replaceOnce(root, workflow, "      - main\n", "      - release\n"),
  );
  assertRed(result, /required branch|EXPECTED_TRIGGER_FILTERS/);
});

test("introducing a path filter is refused", () => {
  const result = mutateAndRun((root) =>
    replaceOnce(root, workflow, "      - main\n", "      - main\n    paths:\n      - src/**\n"),
  );
  assertRed(result, /path filter|EXPECTED_TRIGGER_FILTERS/);
});

test("moving an unchanged gate step to another job is refused", () => {
  const step = `      - name: Build (syntax check every entry point)
        run: npm run build
`;
  const result = mutateAndRun((root) => {
    replaceOnce(root, workflow, step, "");
    const path = join(root, workflow);
    const source = readFileSync(path, "utf8");
    writeFileSync(path, `${source}\n  moved:\n    runs-on: ubuntu-latest\n    steps:\n${step}`);
  });
  assertRed(result, /MOVED STEP PIN|EXPECTED_GATE_JOBS/);
});

test("moving the make-invoked gate step to another job is refused", () => {
  const step = `      - name: Format gate (make fmt)
        run: make fmt
`;
  const result = mutateAndRun((root) => {
    replaceOnce(root, workflow, step, "");
    const path = join(root, workflow);
    const source = readFileSync(path, "utf8");
    writeFileSync(
      path,
      `${source}\n  moved-format:\n    runs-on: ubuntu-latest\n    steps:\n${step}`,
    );
  });
  assertRed(result, /DEAD MAKE STEP PIN|EXPECTED_GATE_JOBS/);
});

test("renaming the gate job is refused", () => {
  const result = mutateAndRun((root) => replaceOnce(root, workflow, jobLine, "  gates:\n"));
  assertRed(result, /MOVED STEP PIN|EXPECTED_GATE_JOBS|EXPECTED_JOB_ACTIVATION/);
});

test("adding a matrix to the gate job is refused", () => {
  const result = mutateAndRun((root) =>
    replaceOnce(
      root,
      workflow,
      jobLine,
      `${jobLine}    strategy:\n      matrix:\n        node: [22, 24]\n`,
    ),
  );
  assertRed(result, /EXPECTED_JOB_MATRIX/);
});

test("unsupported flow-style on syntax fails closed", () => {
  const result = mutateAndRun((root) =>
    replaceOnce(root, workflow, onBlock, "on: [push, pull_request, workflow_dispatch]\n"),
  );
  assertRed(result, /unsupported YAML shape/);
});

test("command and job-aware reader skew fails closed", () => {
  const result = mutateAndRun((root) =>
    replaceOnce(
      root,
      workflow,
      "jobs:\n",
      "orphan:\n  - name: Parser skew\n    run: npm run build\njobs:\n",
    ),
  );
  assertRed(result, /workflow readers disagree/);
});

test("trigger floors survive a workflow-and-pin laundering edit", () => {
  const result = mutateAndRun((root) => {
    replaceOnce(root, workflow, onBlock, "on:\n  workflow_dispatch:\n");
    replaceOnce(
      root,
      "scripts/check-ci-reach.sh",
      ".github/workflows/ci.yml|pull_request,push,workflow_dispatch",
      ".github/workflows/ci.yml|workflow_dispatch",
    );
    for (const row of [
      '\t".github/workflows/ci.yml|pull_request|"\n',
      '\t".github/workflows/ci.yml|push|branches=main"\n',
    ]) {
      replaceOnce(root, "scripts/check-ci-reach.sh", row, "");
    }
  });
  assertRed(result, /REQUIRED_TRIGGERS/);
});

test("main and no-path floors survive matching pin edits", () => {
  for (const [workflowBefore, workflowAfter, pinBefore, pinAfter, diagnostic] of [
    [
      "      - main\n",
      "      - release\n",
      ".github/workflows/ci.yml|push|branches=main",
      ".github/workflows/ci.yml|push|branches=release",
      /required branch/,
    ],
    [
      "      - main\n",
      "      - main\n    paths:\n      - src/**\n",
      ".github/workflows/ci.yml|push|branches=main",
      ".github/workflows/ci.yml|push|branches=main;paths=src/**",
      /path filter/,
    ],
  ]) {
    const result = mutateAndRun((root) => {
      replaceOnce(root, workflow, workflowBefore, workflowAfter);
      replaceOnce(root, "scripts/check-ci-reach.sh", pinBefore, pinAfter);
    });
    assertRed(result, diagnostic);
  }
});

test("blocking floor survives matching job activation pin edit", () => {
  const result = mutateAndRun((root) => {
    replaceOnce(root, workflow, jobLine, `${jobLine}    continue-on-error: true\n`);
    replaceOnce(
      root,
      "scripts/check-ci-reach.sh",
      ".github/workflows/ci.yml|test|continue-on-error=;if=;needs=",
      ".github/workflows/ci.yml|test|continue-on-error=true;if=;needs=",
    );
  });
  assertRed(result, /forbidden non-blocking activation/);
});
