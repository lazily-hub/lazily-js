// Runtime conformance manifest (#lazilyupgradeconformance, #lzassertunknownkeys).
//
// The static coverage guard greps test sources for fixture filenames. That catches
// a fixture nobody mentions, but not a fixture mentioned in a comment and
// hand-transcribed — the drift found in lazily-cpp's queue tests. Only observing
// the actual read proves the bytes were opened.
//
// This is a --require preload rather than an edit to ~73 readFileSync call sites.
// Wrapping the syscall is not a shortcut here, it is the stronger instrument: it
// records what the suite REALLY read, so a runner that stops loading a fixture is
// caught even if its source still names it. Editing call sites would record what
// each site claims to load.
//
// Three manifests are produced:
//
//   LAZILY_CONFORMANCE_MANIFEST          — which fixtures were opened.
//   LAZILY_CONFORMANCE_KEY_MANIFEST      — which assertion KEYS inside those
//                                          fixtures were actually read
//                                          (#lzassertunknownkeys).
//   LAZILY_CONFORMANCE_SCENARIO_MANIFEST — which SCENARIOS inside those fixtures
//                                          were actually replayed
//                                          (#lzscenariocoverage).
//
// The second is a level below the first. "The fixture was replayed" does not mean
// "the assertion the fixture exists for was checked": a runner that reads named
// keys out of an `assertions`/`expect`/`expected` block and lets anything it does
// not recognise fall through reports the fixture as replayed while never checking
// the field. In JavaScript that path is invisible — `const {a, b} = fx.expect`
// and `if ("x" in a)` both read an absent or misspelled key as "not my problem",
// so a corpus key no binding implements is skipped in silence.
//
// The recorder converts every key of a tracked assertion block into an accessor
// that records the read. Accessors, not a Proxy: a Proxy is not structured-
// cloneable and several runners `structuredClone` a fixture, while accessor
// properties survive structuredClone, JSON.stringify and assert.deepEqual (which
// invokes them, so a whole-block deepEqual correctly counts as consuming every
// key). `"x" in block` deliberately does NOT count as a read — membership is how
// the silent path is spelled; only fetching the value is consumption.
//
// A read is still not an assertion (#lzconsumednotasserted). A runner can read a
// key and discard it: a named `continue` inside a loop that iterates the block, a
// value bound and never compared, or an arm that reads the key and then compares
// against a hardcoded literal instead of the fixture's own value. Every one of
// those marks the key READ and proves nothing. So the recorder tracks a second
// fact — which keys reached a comparison against their own fixture value — and a
// third — which keys a runner declared it cannot assert here, with a reason.
//
// Those two facts cannot be inferred by watching property access, so they are
// reported by the runner through `test/support/assert-key.js`, whose helpers are
// the ONLY path that marks a key asserted. That is deliberate: an arm comparing
// against a literal reads the key and never routes through the helper, so it
// stays unasserted and the guard names it.
//
// The scenario ledger is the rung above all of that (#lzscenariocoverage). A
// fixture with several named scenarios can be PARTIALLY replayed and nothing
// notices: rung 1 asks only whether the FILE was opened, and rungs 2-3 bind only
// the blocks a runner reaches, so an unreplayed scenario contributes no
// unconsumed and no unasserted key. Worse, key records USED to be keyed by
// `fixture\t<bare block name>\tkey`, so sibling scenarios sharing an `expect` key
// name masked each other outright — `collections/stableid_alignment.json` had a
// scenario this runner never touched, hidden behind another scenario's
// `key_equal`. The `block` component is now the block's JSON PATH
// (#lzjsblocknamemasking), so that half is closed; the rung remains, because a
// scenario nothing entered still produces no record for any rung to read.
//
// So this recorder also registers every element of a `scenarios` array against
// its fixture, resolving the scenario's id in the corpus-wide fixed order
// (`id`, else `name` — there is no positional fallback, #lzspecscenarioids), and exposes a
// channel the runner marks a replay through. The registration is what lets the
// runner mark WITHOUT naming its own fixture, exactly as `blockOwner` does for
// keys — a runner that names the fixture is making a claim, and a claim rots.
//
// All of this is a no-op when the env vars are unset, so a plain `node --test` is
// unaffected.
const fs = require("node:fs");
const path = require("node:path");

const out = process.env.LAZILY_CONFORMANCE_MANIFEST;
const keyOut = process.env.LAZILY_CONFORMANCE_KEY_MANIFEST;
const scenarioOut = process.env.LAZILY_CONFORMANCE_SCENARIO_MANIFEST;
// Rung 0 (#lznullformblind): which assertion BLOCKS this run instrumented at
// all. Every rung above is scoped to a block the recorder reached; a block it
// never reached has no presence record, so its keys are not unread — nothing
// reads them — and the fixture reports exactly nothing. The guard script
// declares the other side of this ledger by reading the corpus off DISK, which
// is what makes it a cross-check rather than the recorder agreeing with itself.
const blockOut = process.env.LAZILY_CONFORMANCE_BLOCK_MANIFEST;
// Both the key tracker and the scenario ledger need the parsed fixture, so the
// JSON.parse hook and the walk are shared by them.
const walkOut = keyOut || scenarioOut || blockOut;

if (out || walkOut) {
  // Attribution is relative to the RESOLVED corpus root, never to a hardcoded
  // "lazily-spec/conformance" substring (#lzoverrideallrunners). With the
  // substring, pointing the suite at a scratch copy whose path does not contain
  // it stopped recording opens entirely — every guard then reported OK over an
  // empty ledger, which is the vacuous green the whole ladder exists to
  // prevent. `test/spec-corpus.cjs` is the single seam the runners resolve
  // through, so recorder and suite cannot disagree about which corpus is live.
  const corpusRoot = require("../spec-corpus.cjs").conformanceRoot;
  const marker = corpusRoot.endsWith(path.sep) ? corpusRoot : corpusRoot + path.sep;
  const opened = new Set();
  // `fixture\tblock\tkey\tP` present, `...\tR` read, `...\tA` asserted,
  // `...\tX\t<reason>` excused, `...\tD\t<names>` discharged as prose,
  // `...\tO` the fixture's value is a JSON OBJECT, `...\tK` its KEY SET was
  // checked (#lzsubblockkeyset).
  const keyRecords = new Set();
  // `bound\t<digest>` for every assertion block this run instrumented, keyed by
  // the block's CONTENT and never by its `block` name: runners and fixtures
  // spell those inconsistently (`assertions`, `expect`, `expect_after`) and the
  // recorder books every per-frame block under the same bare name, so a
  // name-keyed ledger would silently miss the mismatch instead of reporting it.
  const blockRecords = new Set();
  // Instrumented block object -> `fixture\tblock`, so the assertion helpers can
  // attribute a mark without the runner naming its own fixture.
  const blockOwner = new WeakMap();
  // Parsed fixture ROOT object -> `fixture`, the same trick one level out.
  // `verifyProse(fixture)` is fixture-scoped (#lzprosekeyconvention), so it needs
  // an identity for the whole file rather than for one of its blocks — and a
  // runner handing back the object it parsed is not making a claim it could get
  // wrong, exactly as `blockOwner` and `scenarioOwner` are not.
  const fixtureRoot = new WeakMap();
  // The live prose ledger, `fixture` -> what the CURRENT test asserted, excused
  // and discharged for it. Drained at each verification, because a "run" is one
  // test and not one process (#lzprosekeyconvention).
  const liveLedger = new Map();
  const ledgerFor = (rel) => {
    let live = liveLedger.get(rel);
    if (live === undefined) {
      live = {
        assertedIds: new Set(),
        assertedNames: new Set(),
        excusedIds: new Set(),
        claims: [],
      };
      liveLedger.set(rel, live);
    }
    return live;
  };
  // Every tracked block that DECLARES `assertions.prose`, in parse order:
  // `{ rel, block, object, declared }`. The declaration is read off the corpus
  // before any accessor is installed, so the recorder never credits itself with
  // the read that `verifyProse` must perform.
  const proseBlocks = [];
  // Scenario object -> `fixture\tid`, the same trick one level up: the scenario
  // helpers mark a replay by handing back the object the runner is replaying.
  const scenarioOwner = new WeakMap();
  // `fixture\tid` for every scenario a runner really replayed.
  const scenarioRecords = new Set();
  // Fixture text -> corpus-relative id, so JSON.parse can attribute a parse to
  // the bytes a corpus read returned.
  const corpusText = new Map();
  // Some runners rewrite the text before parsing it (the stdlib loader quotes
  // 64-bit literals so they survive as BigInt). Those parses must still be
  // attributed, so a leading-window index backs up the exact match. A window
  // claimed by two fixtures is set to null and stops matching, so the fallback
  // can never attribute a parse to the wrong fixture — and a parse that matches
  // neither leaves the fixture with no key records at all, which the guard
  // reports as missing evidence rather than passing in silence.
  const PREFIX = 200;
  const corpusPrefix = new Map();

  const relId = (file) => {
    try {
      const raw = typeof file === "string" ? file : file?.toString?.();
      if (!raw) return null;
      // The corpus root is absolute and normalized, so the prefix test is
      // anchored rather than a substring search: a path that merely CONTAINS
      // the root's spelling somewhere in the middle is not a corpus read.
      const p = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(raw);
      if (!p.startsWith(marker)) return null;
      // Store the id relative to the conformance root, matching the corpus listing.
      return p.slice(marker.length).split(path.sep).join("/");
    } catch {
      // Never let bookkeeping break a test run.
      return null;
    }
  };

  const record = (file) => {
    const rel = relId(file);
    if (rel) opened.add(rel);
    return rel;
  };

  // Blocks whose keys are machine-checkable assertions. `invariants` is
  // deliberately absent: its values are English prose naming a property the
  // fixture's `steps` encode, so there is nothing to compare a runner's
  // observation against. That exemption is ENFORCED below rather than assumed —
  // a non-string value in an `invariants` block is a machine-checkable assertion
  // hiding in the one block nothing checks, and it throws.
  // `expect_initial` / `expect_after` are the same kind of block under a
  // phase-qualified name (`collections/semtree_incremental.json`). Leaving them
  // out let a whole assertion block sit outside both rungs, which is the gap
  // the tracked-name list exists to close.
  //
  // This list is a CLOSED set, and that is the point of the rung-0 cross-check
  // (#lzunboundblockguard): a block name the corpus grows and this list does not
  // carry is invisible HERE by construction — no accessor, no presence record,
  // no key. So the guard's declaring side does NOT reuse this list. It reads the
  // corpus off disk under an OPEN name rule (anything spelled `assert*` /
  // `expect*`) and reports any block it inventories that this recorder did not
  // bind. A name added upstream therefore fails the build with a message naming
  // the block, instead of silently sitting outside every rung.
  const TRACKED = new Set(["assertions", "expect", "expected", "expect_initial", "expect_after"]);

  // Prose keys inside a tracked block. Their values are English sentences about
  // the step, not values to compare, so they are exempt from read, assertion and
  // excuse accounting alike. The exemption is conditional on the value REALLY
  // being a string, for the same reason the `invariants` exemption is enforced: a
  // machine-checkable value must never be able to hide behind a prose name.
  //
  // `reason` is deliberately NOT here. In this corpus it carries error
  // discriminators (`clock_regression`, `deadline_overflow`,
  // `operation_unavailable`) that a runner must compare, so exempting it would
  // silence a real assertion.
  //
  // This by-NAME exemption is the reserved-annotation rule of
  // #lzprosekeyconvention, and it is only safe where the key annotates a step or
  // a scenario. It is therefore switched OFF for a block that declares
  // `assertions.prose`: there the CORPUS says which keys are paragraphs, a
  // binding must not decide for itself, and `frame_roundtrip_json.json` declares
  // exactly one — `note`. Leaving the name exemption in force there would file
  // the corpus's own declaration under the guard that exempts it from being
  // checked at all.
  const PROSE = new Set(["comment", "description", "note", "notes", "why"]);
  const isProse = (key, value) => PROSE.has(key) && typeof value === "string";

  // The corpus's own declaration of which sibling keys are paragraphs
  // (#lzprosekeyconvention). An array of strings, or null when the block does not
  // declare one.
  const declaredProse = (object) => {
    const value = object.prose;
    if (!Array.isArray(value)) return null;
    return value.every((name) => typeof name === "string") ? value.slice() : null;
  };

  const remember = (data, rel) => {
    try {
      const text = data.toString("utf8");
      corpusText.set(text, rel);
      const head = text.slice(0, PREFIX);
      if (head.length < PREFIX) return;
      const claimed = corpusPrefix.get(head);
      corpusPrefix.set(head, claimed === undefined || claimed === rel ? rel : null);
    } catch {
      // Bookkeeping only.
    }
  };

  const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

  // FNV-1a over the block's canonical JSON. A content key, so a block is booked
  // by what it SAYS rather than by what a runner or a fixture chose to call it.
  const blockDigest = (object) => {
    let text;
    try {
      text = JSON.stringify(object);
    } catch {
      return null;
    }
    if (typeof text !== "string") return null;
    let hash = 0xcbf29ce484222325n;
    for (const byte of Buffer.from(text, "utf8")) {
      hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
    }
    return hash.toString(16).padStart(16, "0");
  };

  const instrumentBlock = (rel, block, object) => {
    // BEFORE any accessor is installed, and before the prose/presence walk
    // below: the digest has to be over the block as the corpus wrote it, because
    // the guard's declaring side computes it from the bytes on disk.
    if (blockOut) {
      const digest = blockDigest(object);
      if (digest !== null) blockRecords.add(`bound\t${digest}`);
    }
    blockOwner.set(object, `${rel}\t${block}`);
    const declared = declaredProse(object);
    if (declared !== null) proseBlocks.push({ rel, block, object, declared });
    for (const [key, value] of Object.entries(object)) {
      if (declared === null && isProse(key, value)) continue;
      keyRecords.add(`${rel}\t${block}\t${key}\tP`);
      // The SHAPE of the fixture's own value, declared off the corpus bytes at
      // parse time and never from anything a runner says (#lzsubblockkeyset).
      // An object-valued assertion key is the one shape whose contents can drift
      // without any rung noticing: the key itself reports consumed and asserted
      // while a check that named five sub-fields compares the sixth against
      // nothing — the null form one level down, INSIDE an assertion key rather
      // than beside one. The guard pairs this record with the `K` mark below.
      if (isPlainObject(value)) keyRecords.add(`${rel}\t${block}\t${key}\tO`);
      Object.defineProperty(object, key, {
        enumerable: true,
        configurable: true,
        get() {
          keyRecords.add(`${rel}\t${block}\t${key}\tR`);
          return value;
        },
        set(next) {
          // Some runners mutate a clone to prove the runner itself fails on drift.
          Object.defineProperty(object, key, {
            enumerable: true,
            configurable: true,
            writable: true,
            value: next,
          });
        },
      });
    }
  };

  // The corpus-wide scenario id resolution order (#lzscenariocoverage):
  //
  //   1. `id` if present
  //   2. else `name` if present
  //
  // There is no third step (#lzspecscenarioids). It used to fall back to the
  // positional index spelled `#<n>`, which let the ledger record a scenario BY
  // POSITION — and a positional entry silently rebinds to a DIFFERENT scenario
  // when the corpus array is reordered, with nothing turning red: the guard
  // compares "index 1 was replayed" against whatever now sits at index 1 and
  // agrees with itself. The fallback was load-bearing for exactly one fixture,
  // `collections/mergecell_algebra.json`, whose scenarios were distinguishable
  // only by `policy`; they now carry ids, and lazily-spec's
  // `scenario-identity-check` keeps every scenario identified. A hole with no
  // users is one waiting to become load-bearing again, so an unidentified
  // scenario throws here instead.
  //
  // A BLANK id is refused for the same reason: accepting it would file every
  // blank-id scenario in the corpus under one ledger entry, which reads as
  // "replayed" the moment any one of them runs.
  const identifier = (value) =>
    typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  const scenarioId = (scenario, index) => {
    const id = identifier(scenario.id);
    if (id !== "") return id;
    const name = identifier(scenario.name);
    if (name !== "") return name;
    throw new Error(
      `scenario at index ${index} carries neither \`id\` nor \`name\`. The replay ledger ` +
        "would have to record it by POSITION, where inserting a scenario ahead of it " +
        "silently rebinds that entry to a different scenario. Give it a stable id " +
        "upstream in lazily-spec (#lzspecscenarioids).",
    );
  };

  // Keys that IDENTIFY or narrate a scenario rather than drive one
  // (#lzscenariobodyskip). Reading only these is looking at the label, not
  // replaying: a dispatch chain that reads `scenario.name`, matches no arm and
  // falls through has replayed nothing, and a by-name lookup walks past every
  // scenario ahead of the match. Booking on those reads would let exactly the
  // skip this rung exists to catch hide behind the helper.
  //
  // No scenario in the corpus carries only these, so every scenario is reachable
  // through some payload key; one that stopped being reachable would be reported
  // as unreplayed, which is the correct answer for a scenario nothing can enter.
  const SCENARIO_LABEL_KEYS = new Set([
    "comment",
    "description",
    "id",
    "label",
    "name",
    "note",
    "notes",
    "reason",
    "why",
  ]);

  // Booking rides on the first read of a scenario's PAYLOAD, never on the yield
  // that handed it over (#lzscenariobodyskip). A generator cannot tell a loop
  // body that ran from one that `continue`d — both just come back for the next
  // item — so booking at the yield calls a skipped scenario covered, which is
  // the defect. The steps/ops/frames/expect of a scenario are only read by a
  // runner about to replay it.
  //
  // Accessors, not a Proxy, for the same reasons `instrumentBlock` uses them:
  // the identity the ledger keys on stays the fixture's own object, so
  // `recordScenario` and `structuredClone` both keep working, and the booking
  // is intrinsic to the scenario rather than to the helper that handed it out —
  // a runner that iterates `fixture.scenarios` by hand books exactly the same.
  const registerScenarios = (rel, list) => {
    list.forEach((scenario, index) => {
      if (!isPlainObject(scenario)) return;
      const id = `${rel}\t${scenarioId(scenario, index)}`;
      scenarioOwner.set(scenario, id);
      for (const [key, value] of Object.entries(scenario)) {
        if (SCENARIO_LABEL_KEYS.has(key)) continue;
        Object.defineProperty(scenario, key, {
          enumerable: true,
          configurable: true,
          get() {
            scenarioRecords.add(id);
            return value;
          },
          set(next) {
            Object.defineProperty(scenario, key, {
              enumerable: true,
              configurable: true,
              writable: true,
              value: next,
            });
          },
        });
      }
    });
  };

  // `where` is the block's JSON PATH inside the fixture, not its bare name
  // (#lzjsblocknamemasking). A key record is `fixture\tblock\tkey`, so booking
  // every per-frame block under the bare name `assertions` made SIBLINGS COLLAPSE
  // ONTO ONE RECORD: `frames[0].assertions` and `frames[3].assertions` were the
  // same id, and a key asserted in one marked the other asserted too. That is the
  // same masking `#lzscenariocoverage` found between sibling SCENARIOS, one level
  // down and inside a single fixture, and it hid the defect in both directions —
  // a key read in one sibling and never asserted in another reported consumed,
  // and an object-valued key key-set-checked in one sibling discharged the
  // obligation for all of them.
  //
  // The path spelling is the SAME one the guard's disk-side inventory prints
  // (`frames[0].assertions`, `steps[2].expect[1]`), so a failure here names a
  // site a reader can go and open, and a KNOWN_UNBOUND_BLOCKS entry and a key
  // record talk about the same coordinates.
  const walk = (rel, node, where) => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(rel, item, `${where}[${index}]`));
      return;
    }
    if (!isPlainObject(node)) return;
    // Read the raw entries BEFORE any accessor is installed on this node, so the
    // walk never records itself as a consumer.
    for (const [key, value] of Object.entries(node)) {
      const path = where === "" ? key : `${where}.${key}`;
      if (key === "invariants" && isPlainObject(value)) {
        for (const [name, claim] of Object.entries(value)) {
          if (typeof claim !== "string") {
            throw new Error(
              `${rel}: invariants.${name} is not prose (${typeof claim}). ` +
                "`invariants` is exempt from key-consumption tracking because its " +
                "values are English descriptions of what `steps` encode. A value " +
                "with a machine-checkable shape belongs in `expect`/`expected` " +
                "where the consumption guard can see it.",
            );
          }
        }
        continue;
      }
      walk(rel, value, path);
      if ((keyOut || blockOut) && TRACKED.has(key) && isPlainObject(value)) {
        instrumentBlock(rel, path, value);
      }
      // An ARRAY-valued tracked block (#lzunboundblockguard). `steps[].expect` in
      // `signaling/anti_spoof_session.json` is a LIST of expected emissions, and
      // the object-only test above walked straight past all eight of them: every
      // rung is scoped to a block the recorder instrumented, so those blocks had
      // no presence record, no keys, and reported exactly nothing while the
      // runner compared them by hand. Each plain-object element is a block in its
      // own right, named `<path>[<index>]`.
      if ((keyOut || blockOut) && TRACKED.has(key) && Array.isArray(value)) {
        value.forEach((item, index) => {
          if (isPlainObject(item)) instrumentBlock(rel, `${path}[${index}]`, item);
        });
      }
      // AFTER the descent, never before: registration installs payload accessors
      // on each scenario, and the walk above reads every one of those keys. Doing
      // this first books the whole array as replayed at parse time — the recorder
      // recording itself, which is the same self-crediting mistake the raw-entries
      // note at the top of this loop exists to prevent.
      if (key === "scenarios" && Array.isArray(value) && scenarioOut) {
        registerScenarios(rel, value);
      }
    }
  };

  for (const fn of ["readFileSync", "readFile"]) {
    const original = fs[fn];
    if (typeof original !== "function") continue;
    fs[fn] = function (file, ...rest) {
      const rel = record(file);
      const result = original.call(this, file, ...rest);
      if (walkOut && rel && (typeof result === "string" || Buffer.isBuffer(result))) {
        remember(result, rel);
      }
      return result;
    };
  }
  const originalPromises = fs.promises?.readFile;
  if (typeof originalPromises === "function") {
    fs.promises.readFile = function (file, ...rest) {
      const rel = record(file);
      const promise = originalPromises.call(this, file, ...rest);
      if (!walkOut || !rel) return promise;
      return promise.then((result) => {
        try {
          if (typeof result === "string" || Buffer.isBuffer(result)) remember(result, rel);
        } catch {
          // Bookkeeping only.
        }
        return result;
      });
    };
  }

  if (keyOut) {
    // The channel `test/support/assert-key.js` marks through. It is installed on
    // `globalThis` because the recorder is a CJS `--require` preload and the
    // runners are ESM; there is no import edge between them.
    //
    // `owner()` returning null means the object handed in is not a tracked
    // assertion block — a nested plain object inside one, or a structuredClone of
    // one. Marking is then a no-op, and the helper still performs the comparison;
    // the guard reports the original block's key as read-but-not-asserted, which
    // is the correct outcome for a runner asserting against a copy.
    globalThis.__lazilyConformanceKeys = {
      owner(object) {
        if (!isPlainObject(object)) return null;
        return blockOwner.get(object) ?? null;
      },
      mark(object, key, tag, reason) {
        const id = this.owner(object);
        if (id === null) return false;
        // Prose keys carry no presence record, so they carry no mark either.
        if (!keyRecords.has(`${id}\t${key}\tP`)) return false;
        keyRecords.add(tag === "X" ? `${id}\t${key}\tX\t${reason}` : `${id}\t${key}\t${tag}`);
        const [rel, block] = id.split("\t");
        const live = ledgerFor(rel);
        if (tag === "A") {
          live.assertedIds.add(`${block}\t${key}`);
          live.assertedNames.add(key);
        } else if (tag === "X") {
          live.excusedIds.add(`${block}\t${key}`);
        }
        return true;
      },

      // ---- Object-valued keys (#lzsubblockkeyset) ----
      //
      // `descend` binds an object-valued key's VALUE as a tracked block in its
      // own right, named `<block>.<key>`. Every rung above then applies to the
      // sub-keys exactly as it applies to a top-level one: a sub-key the runner
      // never reads is NEVER CONSUMED, and one it reads without comparing is
      // READ BUT NEVER ASSERTED. That is the whole point — the tracker holds the
      // sub-block's key set, so a field added upstream fails rather than being
      // compared against nothing, and no call site has to remember a field count.
      //
      // Instrumenting LAZILY, at the descent rather than at parse time, is
      // deliberate: binding every object-valued key of every parsed fixture
      // would manufacture presence records for sub-keys of keys a runner
      // legitimately consumes whole (a deep equality over the object compares
      // every one of them without ever reading them individually), and those
      // would then report as unconsumed. The obligation is created by the
      // runner asking for it.
      descend(object, key) {
        const id = this.owner(object);
        if (id === null) return null;
        if (!keyRecords.has(`${id}\t${key}\tP`)) return null;
        // Through the block's own accessor, so the descent counts as the read.
        const child = object[key];
        if (!isPlainObject(child)) return null;
        const [rel, block] = id.split("\t");
        // Idempotent: a fixture replayed by two tests descends twice, and
        // re-instrumenting would install accessors over accessors.
        if (blockOwner.get(child) === undefined) instrumentBlock(rel, `${block}.${key}`, child);
        keyRecords.add(`${id}\t${key}\tK`);
        return child;
      },

      // ---- Prose-key discharge ledger (#lzprosekeyconvention) ----
      //
      // A prose key is discharged, never asserted and never excused, by NAMING
      // the executable keys that carry its obligation. The ledger below is what
      // makes that naming falsifiable: it is fixture-scoped, because
      // `epoch_disambiguation` is discharged by `expect.frame_epoch` and
      // `expect.blob_epoch`, which are asserted long after the `assertions`
      // block that states it is finished.

      // The fixture id for a parsed corpus fixture ROOT or for one of its
      // tracked blocks. Null for anything else — a copy, or a hand-built object.
      fixtureOf(object) {
        if (!isPlainObject(object)) return null;
        const own = blockOwner.get(object);
        if (own !== undefined) return own.split("\t")[0];
        return fixtureRoot.get(object) ?? null;
      },

      // Every tracked block of `rel` that declared `prose`, with the block
      // object so the verifier can read the declaration through its accessor —
      // that read is what CONSUMES `prose`.
      proseBlocks(rel) {
        return proseBlocks
          .filter((entry) => entry.rel === rel)
          .map((entry) => ({
            block: entry.block,
            object: entry.object,
            declared: [...entry.declared],
          }));
      },

      // Record a discharge claim. `names` are key names, matched by name in ANY
      // block of the same fixture when the claim is verified.
      markProse(object, key, names) {
        const id = this.owner(object);
        if (id === null) return false;
        if (!keyRecords.has(`${id}\t${key}\tP`)) return false;
        keyRecords.add(`${id}\t${key}\tD\t${names.join(",")}`);
        const [rel, block] = id.split("\t");
        ledgerFor(rel).claims.push({ block, key, names: [...names] });
        return true;
      },

      // The live ledger for `rel`, CLEARED as it is handed over.
      //
      // A "run" is one TEST, not one process (#lzprosekeyconvention). This
      // recorder is a process-global `--require` preload and `keyRecords` spans
      // the whole suite, so deriving the verifier's asserted set from the
      // manifest — which is what this used to do — would let a discharge in one
      // test be satisfied by an assertion in another test that happened to
      // replay the same fixture. That is the accident-of-collocation the
      // fixture-scoped ledger exists to bound, one level up. The manifest still
      // records everything; only the VERIFIER's view is scoped and drained.
      takeLedger(rel) {
        const live = ledgerFor(rel);
        liveLedger.delete(rel);
        return live;
      },

      // The fixture's replay reached its verification point. A fixture that
      // declares `prose` and carries no such record failed to verify, which the
      // manifest script reports exactly as it reports an unconsumed key: an
      // unverified claim is not a checked claim.
      markVerified(rel) {
        keyRecords.add(`${rel}\t*\t*\tV`);
      },
    };
  }

  if (scenarioOut) {
    // The channel `test/support/scenario.js` marks a replay through, installed on
    // `globalThis` for the same reason as the key channel: the recorder is a CJS
    // `--require` preload and the runners are ESM.
    //
    // `owner()` returning null means the object handed in is not an element of a
    // corpus fixture's `scenarios` array — a hand-built object, or a
    // structuredClone of a real scenario. Unlike the key channel this is NOT
    // absorbed quietly: a scenario whose replay cannot be attributed would be
    // reported by the guard as never replayed, and "your runner replayed a copy"
    // is a far more useful failure than that. The helper turns it into a throw.
    globalThis.__lazilyConformanceScenarios = {
      owner(scenario) {
        if (!isPlainObject(scenario)) return null;
        return scenarioOwner.get(scenario) ?? null;
      },
      record(scenario) {
        const id = this.owner(scenario);
        if (id === null) return false;
        scenarioRecords.add(id);
        return true;
      },
    };
  }

  if (walkOut) {
    const originalParse = JSON.parse;
    JSON.parse = function (text, reviver) {
      const value = originalParse.call(this, text, reviver);
      if (corpusText.size !== 0) {
        let key = null;
        if (typeof text === "string") key = text;
        else if (Buffer.isBuffer(text)) key = text.toString("utf8");
        let rel = key === null ? undefined : corpusText.get(key);
        if (!rel && key !== null && key.length >= PREFIX) {
          rel = corpusPrefix.get(key.slice(0, PREFIX)) ?? undefined;
        }
        if (rel) {
          // Register the ROOT before the descent: `verifyProse(fixture)` is
          // handed the parsed fixture itself, and a runner that never names its
          // own fixture id cannot name the wrong one.
          if (isPlainObject(value)) fixtureRoot.set(value, rel);
          walk(rel, value, "");
        }
      }
      return value;
    };
  }

  // Append rather than truncate: `node --test test/*.test.js` may run more than one
  // process, and each must contribute what it read.
  const flush = (file, lines) => {
    if (!file || lines.size === 0) return;
    try {
      fs.appendFileSync(file, [...lines].sort().join("\n") + "\n");
    } catch {
      // A manifest we cannot write is reported by the script as missing evidence,
      // which is the correct outcome — never mask it by failing the suite here.
    }
  };

  process.on("exit", () => {
    flush(out, opened);
    flush(keyOut, keyRecords);
    flush(blockOut, blockRecords);
    flush(scenarioOut, scenarioRecords);
  });
}
