// Per-route Core negative controls for scripts/generate-core-conformance.mjs.
//
// A mutant only counts as killed when the runner rejected it through a LIBRARY
// divergence: test/reactive-graph/engine.js prints one
// `DIVERGENCE <model>/<fixture>...#<site>:<key> — got X, want Y` line whenever a
// check's comparison of the library's observed value against the (mutated)
// expectation fails. Any other non-zero exit (a TypeError on an unknown node id,
// an unknown scenario, an unconsumed key) proves the runner READ the leaf, not
// that the assertion over the library discriminates, so it is recorded as a
// non-discriminating mutant and the next leaf is tried.

import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PROSE_KEYS = new Set(["comment", "description", "note", "notes", "why"]);
export const MAX_MUTANTS_PER_ROUTE = 8;
const DIVERGENCE_LINE =
  /^\s*DIVERGENCE (?:Context|ThreadSafeContext|AsyncContext)\/([^\s#[]+)(?:\[[^\]]*\])?#\S+ \S+ got .*, want .*$/gm;

export function pointerEscape(value) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every concrete assertion block a route pointer resolves to, with its path. */
export function matches(node, segments, path = "") {
  if (segments.length === 0) return isObject(node) ? [[node, path]] : [];
  const [head, ...tail] = segments;
  if (head === "*") {
    const children = Array.isArray(node)
      ? node.map((value, index) => [String(index), value])
      : isObject(node)
        ? Object.entries(node)
        : [];
    return children.flatMap(([key, value]) =>
      matches(value, tail, `${path}/${pointerEscape(key)}`),
    );
  }
  if (node !== null && typeof node === "object" && head in node) {
    return matches(node[head], tail, `${path}/${pointerEscape(head)}`);
  }
  return [];
}

/**
 * The replacement for one scalar assertion leaf, or `undefined` if not mutable.
 * Growing a map or a list would fabricate a node id or scenario label the replay
 * never created, and the runner then fails on its own lookup.
 */
export function mutateLeaf(value) {
  if (typeof value === "boolean") return !value;
  if (typeof value === "number") return value + 1_000_003;
  if (typeof value === "string") return `${value}__core_mutant__`;
  if (value === null) return "__core_mutant__";
  return undefined;
}

/** Every mutable scalar leaf beneath an assertion block, in document order. */
export function assertionLeaves(value, path) {
  let children;
  if (Array.isArray(value)) children = value.map((child, index) => [index, child]);
  else if (isObject(value)) {
    children = Object.entries(value).filter(
      ([key, child]) => !(PROSE_KEYS.has(key) && typeof child === "string"),
    );
  } else return [];
  return children.flatMap(([key, child]) => {
    const childPath = `${path}/${pointerEscape(String(key))}`;
    if (child !== null && typeof child === "object") return assertionLeaves(child, childPath);
    return mutateLeaf(child) === undefined ? [] : [[value, key, childPath]];
  });
}

export function routeLeaves(document, pointer) {
  const segments = pointer
    .split("/")
    .slice(1)
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  return matches(document, segments).flatMap(([block, path]) => assertionLeaves(block, path));
}

/** The runner's library-divergence lines that name `fixtureName`. */
export function divergenceLines(output, fixtureName) {
  return [...output.matchAll(DIVERGENCE_LINE)]
    .filter((match) => match[1] === fixtureName)
    .map((match) => match[0].trim());
}

function failureExcerpt(output) {
  const lines = output.split("\n").filter((line) => /\berror:|Error\b/.test(line));
  return lines.length > 0 ? lines.slice(0, 5).join("\n").slice(0, 1000) : output.slice(-1000);
}

/**
 * Mutate one assertion leaf at a time until a library divergence rejects it.
 * `runner(root)` replays the corpus rooted at `root` and returns a spawnSync-
 * shaped `{ status, stdout, stderr, error }`.
 */
export function killRoute({ corpus, rel, route, mutationRoot, runner, fail }) {
  const pristine = JSON.parse(readFileSync(join(corpus, rel), "utf8"));
  const leafCount = routeLeaves(pristine, route).length;
  if (leafCount === 0) fail(`${rel}#${route} has no machine assertion to perturb`);
  const fixtureName = rel.split("/").at(-1);
  const notDiscriminating = [];
  for (let attempt = 0; attempt < Math.min(leafCount, MAX_MUTANTS_PER_ROUTE); attempt++) {
    // A fresh parse per attempt: exactly one leaf differs from the corpus.
    const document = structuredClone(pristine);
    const [container, key, leafPath] = routeLeaves(document, route)[attempt];
    const before = container[key];
    container[key] = mutateLeaf(before);
    const mutation = { json_pointer: leafPath, before, after: container[key] };
    rmSync(mutationRoot, { recursive: true, force: true });
    cpSync(corpus, mutationRoot, { recursive: true });
    writeFileSync(join(mutationRoot, rel), `${JSON.stringify(document, null, 2)}\n`);
    const probe = runner(mutationRoot);
    if (probe.error || probe.status === null) {
      fail(`negative control did not complete for ${rel}#${leafPath}`);
    }
    if (probe.status === 0) fail(`negative control survived for ${rel}#${leafPath}`);
    const output = `${probe.stdout ?? ""}${probe.stderr ?? ""}`;
    const divergences = divergenceLines(output, fixtureName);
    if (divergences.length > 0) {
      return {
        mutation,
        rejected_by: "divergence",
        observed_exit_code: probe.status,
        divergences: divergences.slice(0, 10),
        non_discriminating_mutants: notDiscriminating,
      };
    }
    notDiscriminating.push({
      mutation,
      rejected_by: "other_failure",
      observed_exit_code: probe.status,
      output_excerpt: failureExcerpt(output),
    });
  }
  return fail(
    `no mutated assertion leaf of ${rel}#${route} was rejected by a library divergence ` +
      `(${notDiscriminating.length} mutant(s) failed for another reason: ` +
      `${JSON.stringify(notDiscriminating.map((item) => item.mutation.json_pointer))})`,
  );
}
