// Fixture-flag hygiene (#lzsiblingrunnermasking).
//
// `#lzflagcoercion` found eight places where this binding turned a fixture's flag
// into a boolean verdict by COERCING it — `Boolean(want)`, `if (want)`,
// `entry.restart ? … : …`, `step.predicate === true`. Every one is fixed. Nothing
// stopped the next one, and three of the eight were only caught because a SECOND
// runner over the same fixture happened to be strict:
// `collections-family-conformance.test.js` asserted `invalidates.membership`
// through `Boolean(want)` while `collections.test.js` ran a type-strict deep
// equality over the whole `invalidates` object. The same corpus edit was green or
// red depending on which files the test command selected. A defect whose detection
// depends on a second file being selected is detected by neither file.
//
// lazily-cpp closed its half by DELETING `lazily_test::Json::as_bool()`, so the
// weak spelling became a compile error. JavaScript has no such lever:
// `Boolean(x)`, `if (x)` and `x ? a : b` are syntax, truthiness has no
// interception hook (`Symbol.toPrimitive` is not consulted by `ToBoolean`), and
// `assert.equal` is already `strictEqual` here because all 71 test files import
// `node:assert/strict`. So the only way to make the spelling unavailable rather
// than merely unused is a SOURCE gate, and this is it.
//
// What it asserts: inside this binding's tests, a value that the canonical corpus
// spells as a JSON boolean may not reach a boolean position by coercion. It must
// go through `requireFlag()` (which requires the type and fails BY NAME), through
// `assertKey`/`assertBlock`/`assertKeySet` (whose `deepStrictEqual` separates
// `false` from `"false"` by construction), or through an explicit comparison
// against a non-boolean literal (`step.op === "advance"`), which is not a flag
// read at all.
//
// Two things make this precise rather than a heuristic:
//
//   1. The flag VOCABULARY is derived from the corpus, not typed here. A property
//      name is a flag if any fixture anywhere under the conformance corpus ever
//      holds a boolean under it. That is why `closed`, `dropped`, `membership` and
//      `order` are covered even though each is also spelled as an object or a
//      number elsewhere in the corpus — a name-is-only-ever-a-boolean rule would
//      have missed four of the eight sites `#lzflagcoercion` fixed.
//   2. The scan is an AST walk (the TypeScript parser, a declared devDependency),
//      never a regex. A regex over these files mis-parses apostrophes inside
//      comments and silently stops finding call sites — a guard that under-reports
//      is worse than no guard.
//
// It is deliberately NOT a whole-program dataflow analysis. It resolves a flag
// through three bindings, which are the three the real defects used: a member read
// (`entry.restart`), a local alias of one (`const want = expected.closed`), and
// the fixture-value parameter of an assert-helper callback (`(want) => …`). A
// fourth hop would be evadable anyway; what closes the hole is that the DEFAULT is
// deny, so a site that wants to coerce has to argue for itself in ALLOWLIST below.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

const SPEC_DIR_OVERRIDDEN = process.env.LAZILY_SPEC_CONFORMANCE_DIR !== undefined;
const SPEC_DIR = process.env.LAZILY_SPEC_CONFORMANCE_DIR ?? "../lazily-spec/conformance";
const TEST_ROOT = "test";

// Sites where a weak boolean spelling lands on a name that matches a corpus flag
// but is NOT a corpus value. Each entry is keyed by file and by the ROOT
// identifier of the expression, so it excuses `p.commutative` in merge.test.js
// and nothing else. A stale entry — one no violation reaches any more — fails the
// build below, the same way KNOWN_UNCOVERED and DECLARED_UNCONSUMED do.
//
// A `this.x` receiver needs no entry: `this` is a class or object-literal method's
// own receiver and is never a parsed fixture, so it is excluded structurally.
const ALLOWLIST = [
  {
    file: "test/merge.test.js",
    root: "p",
    reason:
      "`p` iterates POLICIES, a table of merge policies DECLARED IN THIS FILE. " +
      "`p.commutative` / `p.idempotent` are the library's own algebraic metadata, " +
      "and the tests assert a counterexample for every policy whose flag is clear, " +
      "so the flag cannot silently gate the whole property away.",
  },
  {
    file: "test/nodekey-null-leniency.test.js",
    root: "raw",
    reason:
      "`raw` is the return of `rawMsgpackKey()`, a locally built `{present, nil}` " +
      "witness read straight off the wire bytes. It is the SECOND witness that " +
      "arbitrates the decoder; it carries no fixture value.",
  },
  {
    file: "test/nodekey-null-leniency.test.js",
    root: "onWire",
    reason:
      '`onWire` is the return of `wireKey()`: `"key" in obj ? {present:true,value} : ' +
      "{present:false}`, built in this file from the scenario's wire BYTES. `present` " +
      "is the witness's own field, decided by `in`, not a value the corpus spells.",
  },
  {
    file: "test/blob-backend-discriminator.test.js",
    root: "onWire",
    reason:
      "`onWire` is the return of `wireBackend()`, the same locally built " +
      "`{present, value}` witness over the descriptor's wire bytes as in " +
      "nodekey-null-leniency. Its `present` is decided by `in` on the decoded tree.",
  },
  {
    file: "test/ingress.test.js",
    root: "sc",
    reason:
      "`sc` is a scope object out of `out.change.scopes`, produced by the ingress " +
      "CORE under test. `sc.value` / `sc.authority` / `sc.retry` are the library's " +
      "own observations; these three tests drive the core directly and open no " +
      "fixture at all.",
  },
  {
    file: "test/reliable-sync.test.js",
    root: "wire",
    reason:
      "`wire` is `makeWire()`'s locally built transport stub (`{sent, inbound, up, " +
      "sourceErr}`) for the SyncDriver loop-shape unit tests, which have no fixture. " +
      "`wire.up` is the stub's own state, scripted by the test.",
  },
];

const problems = [];
const allowlistUsed = new Set();

// ---- corpus preamble, identical in shape to the other rungs ----
//
// An EXPLICIT override that cannot be read is never a skip and never a fallback
// (#lzoverrideallrunners): falling back to the canonical sibling would derive the
// flag vocabulary from a corpus nobody asked for.
if (SPEC_DIR_OVERRIDDEN && !existsSync(SPEC_DIR)) {
  console.error(`ERROR: LAZILY_SPEC_CONFORMANCE_DIR is set to '${SPEC_DIR}' but that is not a`);
  console.error("       readable directory. An explicit corpus override must fail closed.");
  process.exit(1);
}
if (!existsSync(SPEC_DIR)) {
  if (process.env.CI) {
    console.error(`ERROR: canonical corpus not found at ${SPEC_DIR}, and CI is set.`);
    console.error("       Under CI this is missing EVIDENCE, not evidence of absence: the");
    console.error("       flag vocabulary is derived from the corpus, so without it this");
    console.error("       guard would report OK having recognised zero flags (#lzvacuousrun).");
    process.exit(1);
  }
  console.error(`SKIP: canonical corpus not found at ${SPEC_DIR} (clone the lazily-spec sibling)`);
  console.error("      Local checkout only — this would be a hard failure under CI.");
  process.exit(0);
}

// ---- 1. the flag vocabulary, DERIVED from the corpus ----
const flagNames = new Set();
let corpusFixtures = 0;

function collectFlagNames(value) {
  if (Array.isArray(value)) {
    for (const element of value) collectFlagNames(element);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "boolean") flagNames.add(key);
    collectFlagNames(child);
  }
}

function walkCorpus(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkCorpus(path);
      continue;
    }
    if (!entry.name.endsWith(".json")) continue;
    corpusFixtures += 1;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      problems.push(
        `ERROR: ${path} is not parseable JSON (${error.message}). The flag vocabulary` +
          " this guard derives from the corpus would be incomplete, so it cannot report OK.",
      );
      continue;
    }
    collectFlagNames(parsed);
  }
}
walkCorpus(SPEC_DIR);

// A JSON key that is not a JavaScript identifier can never appear as `x.key` or as
// a shorthand binding, so it contributes nothing a source scan could match. The
// corpus carries several (`"100"`, `"7"`) as map keys.
const identifierFlags = new Set([...flagNames].filter((name) => /^[A-Za-z_$][\w$]*$/.test(name)));

// ---- 2. the test sources ----
function testSources(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...testSources(path));
      continue;
    }
    if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs") || entry.name.endsWith(".cjs")) {
      found.push(path);
    }
  }
  return found.sort();
}

// The helpers whose callback receives the FIXTURE's own value as its first
// parameter. Inside such a callback the parameter IS a corpus value by
// construction, so a weak spelling on it needs no vocabulary lookup — which is
// what caught `Boolean(want)` and `if (wantStable)` in the collections family
// runner, where the key name arrives as a variable rather than a literal.
const VALUE_CALLBACK_HELPERS = new Map([
  ["assertKeyWith", 2],
  ["assertKeySet", 2],
]);

const sources = testSources(TEST_ROOT);
let booleanPositions = 0;
let requireFlagSites = 0;
let flagReads = 0;

// The identifier an access chain hangs off, so ALLOWLIST can excuse one object
// rather than one property name. Calls and optional chains are unwrapped too:
// `alive.get(p)?.value` roots at `alive`, not at the CallExpression.
function rootOf(node) {
  let current = node;
  for (;;) {
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current) ||
      ts.isCallExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isParenthesizedExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

// Array predicates: the callback's return value IS a boolean verdict, so a
// concise arrow body that is nothing but a flag read is a truthiness test with no
// `if` in sight. `death.open_set.filter((e) => e.present)` is exactly that shape,
// and it drives the whole liveness model in reliable-sync. `.map` is NOT here:
// returning the flag itself is not a verdict about it.
const PREDICATE_METHODS = new Set([
  "filter",
  "some",
  "every",
  "find",
  "findLast",
  "findIndex",
  "findLastIndex",
]);

/**
 * Does `node` denote a corpus flag value?
 *
 * Three bindings, which are the three the real defects used:
 *   - `X.flag` where `flag` is in the corpus vocabulary and `X` is not `this`;
 *   - an identifier aliasing one (`const want = expected.closed`, or a
 *     `{ closed }` destructure);
 *   - the fixture-value parameter of an assert-helper callback.
 * Returns the reason string used in the report, or null.
 */
function flagBinding(node, aliases) {
  const inner = ts.isParenthesizedExpression(node) ? node.expression : node;
  if (ts.isPropertyAccessExpression(inner) && ts.isIdentifier(inner.name)) {
    if (!identifierFlags.has(inner.name.text)) return null;
    const root = rootOf(inner);
    if (root.kind === ts.SyntaxKind.ThisKeyword) return null;
    const rootName = ts.isIdentifier(root) ? root.text : null;
    return { text: inner.getText(), rootName, why: "the corpus spells this key as a JSON boolean" };
  }
  if (ts.isIdentifier(inner)) {
    for (let i = aliases.length - 1; i >= 0; i -= 1) {
      const hit = aliases[i].get(inner.text);
      if (hit !== undefined) return { text: inner.text, rootName: inner.text, why: hit };
    }
  }
  return null;
}

function report(file, node, sourceFile, spelling, binding) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const allowed = ALLOWLIST.find((entry) => entry.file === file && entry.root === binding.rootName);
  if (allowed !== undefined) {
    allowlistUsed.add(`${allowed.file}\t${allowed.root}`);
    return;
  }
  problems.push(
    `ERROR: ${file}:${line + 1} coerces the fixture flag \`${binding.text}\` with ` +
      `${spelling} — ${binding.why}.\n` +
      "       A coerced flag makes a verdict out of a value that carries none: " +
      '`Boolean("false")` is TRUE, `if ("false")` takes the true arm, `1 == true`, ' +
      "and `x === true` is silently FALSE for a wrong type rather than an error. A\n" +
      "       mistyped fixture flag then reads as asserting one thing while the run checks " +
      "the opposite, and passes (#lzflagcoercion). Route it through `requireFlag(value, " +
      "name[, whenAbsent])`,\n" +
      "       or assert it with `assertKey`, whose `deepStrictEqual` separates `false` from " +
      '`"false"`. If this name is NOT a corpus value, add it to ALLOWLIST in ' +
      "scripts/check-flag-hygiene.mjs with a reason (#lzsiblingrunnermasking).",
  );
}

function scan(file) {
  const text = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const aliases = [new Map()];

  const check = (node, spelling) => {
    if (node === undefined) return;
    booleanPositions += 1;
    const binding = flagBinding(node, aliases);
    if (binding !== null) report(file, node, sourceFile, spelling, binding);
  };

  const declareAliases = (name, initializer, scope) => {
    if (ts.isIdentifier(name)) {
      if (initializer === undefined) return;
      const binding = flagBinding(initializer, aliases);
      if (binding !== null) {
        scope.set(name.text, `it aliases the fixture flag \`${binding.text}\``);
      }
      return;
    }
    if (ts.isObjectBindingPattern(name)) {
      for (const element of name.elements) {
        // `const { closed } = initial` and `const { closed: want } = initial`.
        const key = element.propertyName ?? element.name;
        if (!ts.isIdentifier(key) || !ts.isIdentifier(element.name)) continue;
        if (!identifierFlags.has(key.text)) continue;
        scope.set(
          element.name.text,
          `it destructures the fixture flag \`${key.text}\` out of \`${
            initializer === undefined ? "a fixture block" : initializer.getText().slice(0, 40)
          }\``,
        );
      }
    }
  };

  const visit = (node) => {
    // A new lexical scope for aliases. Function-like nodes and blocks both get
    // one, so an alias cannot leak out of the function that bound it and collide
    // with an unrelated local of the same name elsewhere in the file.
    const opensScope =
      ts.isFunctionLike(node) || ts.isBlock(node) || ts.isSourceFile(node) || ts.isCaseBlock(node);
    if (opensScope) aliases.push(new Map());
    const scope = aliases[aliases.length - 1];

    // The fixture-value parameter of an assert-helper callback.
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : ts.isIdentifier(node.expression)
          ? node.expression.text
          : null;
      if (callee === "requireFlag") requireFlagSites += 1;
      const cbIndex = callee === null ? undefined : VALUE_CALLBACK_HELPERS.get(callee);
      if (cbIndex !== undefined) {
        const cb = node.arguments[cbIndex];
        if (cb !== undefined && ts.isFunctionLike(cb) && cb.parameters.length > 0) {
          const param = cb.parameters[0].name;
          if (ts.isIdentifier(param)) {
            // The callback's own scope is pushed when the walk reaches it; record
            // the parameter in the scope the CALL sits in, which encloses it.
            scope.set(
              param.text,
              `it is the fixture-value parameter of \`${callee}\`, so it holds the corpus value itself`,
            );
          }
        }
      }
      if (callee === "Boolean" && node.arguments.length === 1) {
        check(node.arguments[0], "`Boolean(x)`");
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        PREDICATE_METHODS.has(node.expression.name.text) &&
        node.arguments.length > 0 &&
        ts.isArrowFunction(node.arguments[0]) &&
        !ts.isBlock(node.arguments[0].body)
      ) {
        check(
          node.arguments[0].body,
          `\`.${node.expression.name.text}((x) => flag)\` — the callback's return value IS the verdict`,
        );
      }
      // `assert.ok(x)` is a truthiness verdict exactly like `if (x)`.
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "ok" &&
        node.arguments.length > 0
      ) {
        check(node.arguments[0], "`assert.ok(x)`");
      }
    }

    if (ts.isVariableDeclaration(node)) declareAliases(node.name, node.initializer, scope);

    if (ts.isIfStatement(node)) check(node.expression, "`if (x)`");
    if (ts.isWhileStatement(node) || ts.isDoStatement(node)) check(node.expression, "`while (x)`");
    if (ts.isForStatement(node) && node.condition !== undefined) {
      check(node.condition, "`for (; x;)`");
    }
    if (ts.isConditionalExpression(node)) check(node.condition, "`x ? a : b`");
    if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
      check(node.operand, "`!x`");
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
        check(node.left, "`x && y` / `x || y`");
        check(node.right, "`x && y` / `x || y`");
      }
      const comparison =
        op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
        op === ts.SyntaxKind.EqualsEqualsToken ||
        op === ts.SyntaxKind.ExclamationEqualsToken;
      if (comparison) {
        const isBool = (n) =>
          n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword;
        // `x === true` is the shape lazily-go shipped: silently FALSE for a wrong
        // type rather than an error. `assertKey` is the spelling that fails.
        if (isBool(node.right)) check(node.left, "`x === true` / `x === false`");
        if (isBool(node.left)) check(node.right, "`true === x` / `false === x`");
      }
    }

    // Population evidence, independent of whether anything was flagged: how many
    // corpus-flag reads this file performs at all. A traversal that silently stops
    // finding property accesses collapses this to zero and trips the floor below.
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.name) &&
      identifierFlags.has(node.name.text) &&
      rootOf(node).kind !== ts.SyntaxKind.ThisKeyword
    ) {
      flagReads += 1;
    }

    ts.forEachChild(node, visit);
    if (opensScope) aliases.pop();
  };

  visit(sourceFile);
}

for (const file of sources) scan(file);

// ---- 3. the allowlist cannot rot ----
for (const entry of ALLOWLIST) {
  if (!allowlistUsed.has(`${entry.file}\t${entry.root}`)) {
    problems.push(
      `ERROR: ALLOWLIST excuses \`${entry.root}\` in ${entry.file}, but no coerced flag` +
        " read there reaches it any more. The excuse outlived the site it described:" +
        " delete the entry. An excuse left behind is a hole nobody is watching.",
    );
  }
}

// ---- 4. the scan guards itself (#lzvacuousrun) ----
//
// Everything above is vacuously satisfied by an empty scan: zero sources means
// zero violations, and so does a vocabulary of zero flag names or a traversal
// that reaches no boolean position. Each floor below is PINNED TO REALITY with no
// margin, so it fails the moment the population shrinks — a floor you never
// watched fail is a floor you have not verified. Re-derive from this guard's own
// output when a change moves a count; never lower one to fix a red run.
const MIN_SOURCES = Number(process.env.MIN_FLAG_HYGIENE_SOURCES ?? "77");
const MIN_FLAG_NAMES = Number(process.env.MIN_CORPUS_FLAG_NAMES ?? "176");
const MIN_BOOLEAN_POSITIONS = Number(process.env.MIN_BOOLEAN_POSITIONS ?? "1696");
const MIN_FLAG_READS = Number(process.env.MIN_FLAG_READS ?? "556");

if (sources.length < MIN_SOURCES) {
  problems.push(
    `ERROR: only ${sources.length} test source(s) were scanned, expected >= ${MIN_SOURCES}.` +
      " An empty or truncated scan reports OK over nothing at all. Do not lower" +
      " MIN_FLAG_HYGIENE_SOURCES to fix this.",
  );
}
if (identifierFlags.size < MIN_FLAG_NAMES) {
  problems.push(
    `ERROR: the corpus at ${SPEC_DIR} yielded only ${identifierFlags.size} identifier-shaped` +
      ` flag name(s) across ${corpusFixtures} fixture(s), expected >= ${MIN_FLAG_NAMES}.` +
      " The vocabulary this guard recognises is derived from the corpus, so a shrunken" +
      " vocabulary silently stops recognising flags rather than reporting anything.",
  );
}
if (booleanPositions < MIN_BOOLEAN_POSITIONS) {
  problems.push(
    `ERROR: the walk reached only ${booleanPositions} boolean position(s), expected >=` +
      ` ${MIN_BOOLEAN_POSITIONS}. The AST traversal is not reaching the expressions it` +
      " is supposed to inspect, so a clean report proves nothing.",
  );
}
if (flagReads < MIN_FLAG_READS) {
  problems.push(
    `ERROR: the walk saw only ${flagReads} read(s) of a corpus flag name, expected >=` +
      ` ${MIN_FLAG_READS}. Either the runners stopped reading the corpus's flags or the` +
      " vocabulary lookup is no longer matching; both make a clean report vacuous.",
  );
}

if (problems.length > 0) {
  for (const line of problems) console.error(line);
  console.error(`fixture-flag hygiene FAILED: ${problems.length} problem(s)`);
  process.exit(1);
}

console.error(
  `fixture-flag hygiene OK: ${sources.length} test source(s) scanned by AST against` +
    ` ${identifierFlags.size} flag name(s) DERIVED from ${corpusFixtures} canonical fixture(s);` +
    ` ${booleanPositions} boolean position(s) inspected, ${flagReads} corpus-flag read(s) seen,` +
    ` ${requireFlagSites} requireFlag() site(s), ${ALLOWLIST.length} allowlisted non-fixture` +
    " name(s) (floors " +
    `${MIN_SOURCES}/${MIN_FLAG_NAMES}/${MIN_BOOLEAN_POSITIONS}/${MIN_FLAG_READS}, pinned to reality)`,
);
