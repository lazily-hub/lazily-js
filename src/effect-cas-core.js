// EffectCasCore — generic keyed compare-and-swap effect authority
// (`#lzeffectcas`).
//
// `LatestDurableProjectionCore` covers a latest-value write whose success is a
// single durable frontier. A live application often needs the same ownership
// algebra around an OPAQUE AUTHORITY TOKEN: apply a Git ref update only at one
// parent, mutate an editor document only at one authority hash, update a
// controller row only at one lineage/version. This pure core owns:
//
//  * stable effect identity and immutable epoch/plan identity;
//  * the authority token observed for the exact attempt;
//  * one in-flight attempt per key and actor-generation fencing;
//  * latest-wins pending intent, explicit supersession, retry eligibility, and
//    deterministic logical-clock retry times;
//  * exact attempt/receipt matching and a monotone `appliedThrough` frontier;
//  * the cursor and receipt lineage of an ordered multi-step effect plan; and
//  * a full-fidelity durable image (`durableState` / `EffectCasCore.hydrate`)
//    for crash recovery and cross-process persistence (`#lzeffectcasdurable`).
//
// The application adapter owns `observe(key)` and ONE atomic
// `compareAndApply(attempt)` boundary, and maps the backend result to exactly one
// of `applied {receipt, authority}`, `superseded {observed}`,
// `retryable {error}` or `rejected {error}`. It never retries, chooses a newer
// intent, clears retained work, or advances a frontier — those are decisions of
// this core. The core owns no thread, executor, timer, or I/O.
//
// Values are compared STRUCTURALLY (authority tokens, payloads, receipts,
// errors and whole intents), the JS rendering of Rust's `PartialEq`; pass
// `{ equals }` to the constructor to supply a domain equality. Keys index a
// `Map`, so they are compared by SameValueZero and should be primitives.
//
// Mirrors `lazily-rs/src/effect_cas_core.rs`; spec: lazily-spec
// docs/durable-sinks.md § Generic effect compare-and-swap.

export const EffectCasUpsertKind = Object.freeze({
  Accepted: "accepted",
  Unchanged: "unchanged",
  AlreadyApplied: "already_applied",
  StaleEpoch: "stale_epoch",
  EpochConflict: "epoch_conflict",
});

export const EffectCasClaimKind = Object.freeze({
  Claimed: "claimed",
  Empty: "empty",
  Busy: "busy",
  Waiting: "waiting",
  StaleGeneration: "stale_generation",
});

export const EffectCasAppliedKind = Object.freeze({
  StepApplied: "step_applied",
  Completed: "completed",
  Superseded: "superseded",
  Duplicate: "duplicate",
  UnknownAttempt: "unknown_attempt",
  StaleGeneration: "stale_generation",
});

export const EffectCasFailureKind = Object.freeze({
  Superseded: "superseded",
  Retrying: "retrying",
  Rejected: "rejected",
  UnknownAttempt: "unknown_attempt",
  StaleGeneration: "stale_generation",
});

export const EffectCasReconnectKind = Object.freeze({
  Advanced: "advanced",
  Unchanged: "unchanged",
  StaleGeneration: "stale_generation",
});

export const EffectTerminalKind = Object.freeze({
  Applied: "applied",
  Superseded: "superseded",
  Rejected: "rejected",
});

/** The only outcomes an application adapter may return. */
export const EffectApplyKind = Object.freeze({
  Applied: "applied",
  Superseded: "superseded",
  Retryable: "retryable",
  Rejected: "rejected",
});

/** Why a durable image cannot be hydrated. Hydration never repairs an image. */
export const EffectCasHydrateError = Object.freeze({
  DuplicateKey: "DuplicateKey",
  KeyMismatch: "KeyMismatch",
  CursorOutOfRange: "CursorOutOfRange",
  AttemptMismatch: "AttemptMismatch",
  FutureGeneration: "FutureGeneration",
});

/** Thrown by `EffectCasCore.hydrate`; `reason` is an `EffectCasHydrateError`. */
export class EffectCasHydrateFailure extends Error {
  constructor(reason) {
    super(`effect-CAS durable image refused: ${reason}`);
    this.name = "EffectCasHydrateFailure";
    this.reason = reason;
  }
}

/**
 * Structural equality over JSON-like values (primitives, arrays, plain objects),
 * the default stand-in for Rust's derived `PartialEq`.
 */
export function structuralEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!structuralEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const key of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !structuralEqual(a[key], b[key])) {
      return false;
    }
  }
  return true;
}

function requireCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, got ${String(value)}`);
  }
  return value;
}

/** A stable effect identity: a non-empty string (Rust `EffectIdentity`). */
export function effectIdentity(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("an effect identity must be a non-empty string");
  }
  return value;
}

/**
 * Build an immutable desired effect. One epoch names exactly one identity and
 * one non-empty ordered plan.
 */
export function effectIntent({ identity, epoch, key, expected, plan }) {
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new RangeError("an effect plan must contain at least one step");
  }
  return Object.freeze({
    identity: effectIdentity(identity),
    epoch: requireCount(epoch, "epoch"),
    key,
    expected,
    plan: Object.freeze([...plan]),
  });
}

const NO_CHANGE = Object.freeze({ state: false });
const CHANGED = Object.freeze({ state: true });

function attemptIdentityEqual(a, b) {
  return (
    a !== null &&
    b !== null &&
    a !== undefined &&
    b !== undefined &&
    a.effect === b.effect &&
    a.generation === b.generation &&
    a.epoch === b.epoch &&
    a.step === b.step &&
    a.attempt === b.attempt
  );
}

function freezePending(p) {
  return Object.freeze({
    intent: p.intent,
    nextStep: p.nextStep,
    expected: p.expected,
    receipts: Object.freeze([...p.receipts]),
    nextAttempt: p.nextAttempt,
    readyAt: p.readyAt,
  });
}

function terminal(kind, intent, receipts, extra) {
  return Object.freeze({
    kind,
    identity: intent.identity,
    epoch: intent.epoch,
    ...extra,
    receipts: Object.freeze([...receipts]),
  });
}

function emptyEntry() {
  return {
    pending: null,
    inflight: null,
    retry: null,
    appliedThrough: null,
    terminal: null,
    terminalIntent: null,
  };
}

function defaultCompareKeys(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Pure keyed effect-CAS orchestration authority. */
export class EffectCasCore {
  /**
   * @param {number} generation the actor generation that owns the first claims.
   * @param {{equals?: (a: unknown, b: unknown) => boolean,
   *   compareKeys?: (a: unknown, b: unknown) => number}} [options]
   */
  constructor(generation, options = {}) {
    this._generation = requireCount(generation, "generation");
    this._equals = options.equals ?? structuralEqual;
    this._compareKeys = options.compareKeys ?? defaultCompareKeys;
    /** @type {Map<unknown, ReturnType<typeof emptyEntry>>} */
    this._keys = new Map();
  }

  get generation() {
    return this._generation;
  }

  _sortedKeys() {
    return [...this._keys.keys()].sort(this._compareKeys);
  }

  _keyState(entry) {
    return Object.freeze({
      pending: entry.pending,
      inflight: entry.inflight === null ? null : entry.inflight.attempt,
      retry: entry.retry,
      appliedThrough: entry.appliedThrough,
      terminal: entry.terminal,
    });
  }

  /** The reader projection of one key, or null for a key never upserted. */
  state(key) {
    const entry = this._keys.get(key);
    return entry === undefined ? null : this._keyState(entry);
  }

  /** The reader projection of every key, in key order. */
  snapshot() {
    return Object.freeze({
      generation: this._generation,
      keys: Object.freeze(
        this._sortedKeys().map((key) =>
          Object.freeze({ key, state: this._keyState(this._keys.get(key)) }),
        ),
      ),
    });
  }

  /** Keys whose pending work is claimable at logical time `now`. */
  pendingKeys(now) {
    return this._sortedKeys().filter((key) => {
      const entry = this._keys.get(key);
      return (
        entry.inflight === null &&
        entry.pending !== null &&
        (entry.pending.readyAt === null || entry.pending.readyAt <= now)
      );
    });
  }

  _intentEqual(a, b) {
    return (
      a.identity === b.identity &&
      a.epoch === b.epoch &&
      this._equals(a.key, b.key) &&
      this._equals(a.expected, b.expected) &&
      a.plan.length === b.plan.length &&
      a.plan.every((step, i) => this._equals(step, b.plan[i]))
    );
  }

  /** Record a desired effect. Only a strictly newer epoch replaces retained work. */
  upsertDesired(intentInput) {
    const intent = Object.isFrozen(intentInput) ? intentInput : effectIntent(intentInput);
    let entry = this._keys.get(intent.key);
    if (entry === undefined) {
      entry = emptyEntry();
      this._keys.set(intent.key, entry);
    }
    if (entry.appliedThrough !== null && intent.epoch <= entry.appliedThrough) {
      return {
        change: NO_CHANGE,
        outcome: Object.freeze({
          kind: EffectCasUpsertKind.AlreadyApplied,
          appliedThrough: entry.appliedThrough,
        }),
      };
    }
    const pendingIntent = entry.pending?.intent ?? null;
    const inflightIntent = entry.inflight?.retained.intent ?? null;
    const epochs = [
      pendingIntent?.epoch,
      inflightIntent?.epoch,
      entry.terminalIntent?.epoch,
    ].filter((epoch) => epoch !== undefined);
    if (epochs.length > 0) {
      const current = Math.max(...epochs);
      if (intent.epoch < current) {
        return {
          change: NO_CHANGE,
          outcome: Object.freeze({ kind: EffectCasUpsertKind.StaleEpoch, current }),
        };
      }
      if (intent.epoch === current) {
        const same = [pendingIntent, inflightIntent, entry.terminalIntent].some(
          (existing) => existing !== null && this._intentEqual(existing, intent),
        );
        return {
          change: NO_CHANGE,
          outcome: Object.freeze({
            kind: same ? EffectCasUpsertKind.Unchanged : EffectCasUpsertKind.EpochConflict,
          }),
        };
      }
    }
    if (entry.pending !== null) {
      const superseded = entry.pending;
      entry.terminalIntent = superseded.intent;
      entry.terminal = terminal(
        EffectTerminalKind.Superseded,
        superseded.intent,
        superseded.receipts,
        {
          observed: null,
        },
      );
    }
    entry.pending = freezePending({
      intent,
      nextStep: 0,
      expected: intent.expected,
      receipts: [],
      nextAttempt: 1,
      readyAt: null,
    });
    entry.retry = null;
    return { change: CHANGED, outcome: Object.freeze({ kind: EffectCasUpsertKind.Accepted }) };
  }

  /** Move `key`'s eligible pending work into its sole in-flight slot. */
  claim(key, generation, now) {
    if (generation !== this._generation) {
      return {
        change: NO_CHANGE,
        outcome: Object.freeze({
          kind: EffectCasClaimKind.StaleGeneration,
          current: this._generation,
        }),
      };
    }
    const entry = this._keys.get(key);
    if (entry === undefined) {
      return { change: NO_CHANGE, outcome: Object.freeze({ kind: EffectCasClaimKind.Empty }) };
    }
    if (entry.inflight !== null) {
      return { change: NO_CHANGE, outcome: Object.freeze({ kind: EffectCasClaimKind.Busy }) };
    }
    const pending = entry.pending;
    if (pending === null) {
      return { change: NO_CHANGE, outcome: Object.freeze({ kind: EffectCasClaimKind.Empty }) };
    }
    if (pending.readyAt !== null && now < pending.readyAt) {
      return {
        change: NO_CHANGE,
        outcome: Object.freeze({ kind: EffectCasClaimKind.Waiting, retryAt: pending.readyAt }),
      };
    }
    entry.pending = null;
    const attempt = Object.freeze({
      identity: Object.freeze({
        effect: pending.intent.identity,
        generation,
        epoch: pending.intent.epoch,
        step: pending.nextStep,
        attempt: pending.nextAttempt,
      }),
      key: pending.intent.key,
      expected: pending.expected,
      payload: pending.intent.plan[pending.nextStep],
      priorReceipts: pending.receipts,
    });
    entry.inflight = { retained: pending, attempt };
    return {
      change: CHANGED,
      outcome: Object.freeze({ kind: EffectCasClaimKind.Claimed, attempt }),
    };
  }

  /** Match the exact attempt and retain its receipt. */
  recordApplied(key, attempt, receipt, authority) {
    if (attempt.generation !== this._generation) {
      return {
        change: NO_CHANGE,
        outcome: Object.freeze({
          kind: EffectCasAppliedKind.StaleGeneration,
          current: this._generation,
        }),
      };
    }
    const entry = this._keys.get(key);
    const unknown = {
      change: NO_CHANGE,
      outcome: Object.freeze({ kind: EffectCasAppliedKind.UnknownAttempt }),
    };
    if (entry === undefined) return unknown;
    if (
      entry.terminal !== null &&
      entry.terminal.receipts.some(
        (known) =>
          attemptIdentityEqual(known.attempt, attempt) && this._equals(known.receipt, receipt),
      )
    ) {
      return {
        change: NO_CHANGE,
        outcome: Object.freeze({ kind: EffectCasAppliedKind.Duplicate }),
      };
    }
    if (
      entry.inflight === null ||
      !attemptIdentityEqual(entry.inflight.attempt.identity, attempt)
    ) {
      return unknown;
    }
    const retained = entry.inflight.retained;
    entry.inflight = null;
    const receipts = [
      ...retained.receipts,
      Object.freeze({ attempt: attemptIdentityOf(attempt), receipt, authority }),
    ];
    entry.retry = null;

    if (entry.pending !== null && entry.pending.intent.epoch > retained.intent.epoch) {
      entry.terminalIntent = retained.intent;
      entry.terminal = terminal(EffectTerminalKind.Superseded, retained.intent, receipts, {
        observed: authority,
      });
      return {
        change: CHANGED,
        outcome: Object.freeze({ kind: EffectCasAppliedKind.Superseded }),
      };
    }

    const nextStep = retained.nextStep + 1;
    if (nextStep < retained.intent.plan.length) {
      entry.pending = freezePending({
        intent: retained.intent,
        nextStep,
        expected: authority,
        receipts,
        nextAttempt: 1,
        readyAt: null,
      });
      return {
        change: CHANGED,
        outcome: Object.freeze({ kind: EffectCasAppliedKind.StepApplied, nextStep }),
      };
    }

    const epoch = retained.intent.epoch;
    entry.appliedThrough =
      entry.appliedThrough === null ? epoch : Math.max(entry.appliedThrough, epoch);
    entry.terminalIntent = retained.intent;
    entry.terminal = terminal(EffectTerminalKind.Applied, retained.intent, receipts, {});
    return {
      change: CHANGED,
      outcome: Object.freeze({
        kind: EffectCasAppliedKind.Completed,
        appliedThrough: entry.appliedThrough,
      }),
    };
  }

  /** The comparison failed; the adapter mutated nothing. Terminal supersession. */
  recordSuperseded(key, attempt, observed) {
    return this._finishFailed(key, attempt, { kind: "superseded", observed });
  }

  /** Restore the same identity/cursor with the next attempt at logical `retryAt`. */
  recordRetryable(key, attempt, error, retryAt) {
    requireCount(retryAt, "retryAt");
    return this._finishFailed(key, attempt, { kind: "retryable", error, retryAt });
  }

  /** Terminal, permanent rejection. Never aliases retry. */
  recordRejected(key, attempt, error) {
    return this._finishFailed(key, attempt, { kind: "rejected", error });
  }

  /**
   * Route one adapter result. `apply` is `{kind: "applied", receipt, authority}`,
   * `{kind: "superseded", observed}`, `{kind: "retryable", error}` or
   * `{kind: "rejected", error}`; `retryAt` is used only for `retryable`.
   */
  recordOutcome(key, attempt, apply, retryAt) {
    switch (apply?.kind) {
      case EffectApplyKind.Applied:
        return this.recordApplied(key, attempt, apply.receipt, apply.authority);
      case EffectApplyKind.Superseded:
        return this.recordSuperseded(key, attempt, apply.observed);
      case EffectApplyKind.Retryable:
        return this.recordRetryable(key, attempt, apply.error, retryAt);
      case EffectApplyKind.Rejected:
        return this.recordRejected(key, attempt, apply.error);
      default:
        throw new TypeError(`unknown effect apply outcome ${String(apply?.kind)}`);
    }
  }

  /** Fence older receipts and requeue each in-flight cursor under the same identity. */
  reconnect(newGeneration) {
    requireCount(newGeneration, "generation");
    if (newGeneration < this._generation) {
      return {
        change: NO_CHANGE,
        outcome: Object.freeze({
          kind: EffectCasReconnectKind.StaleGeneration,
          current: this._generation,
        }),
      };
    }
    if (newGeneration === this._generation) {
      return {
        change: NO_CHANGE,
        outcome: Object.freeze({
          kind: EffectCasReconnectKind.Unchanged,
          generation: this._generation,
        }),
      };
    }
    this._generation = newGeneration;
    let requeued = 0;
    let superseded = 0;
    for (const key of this._sortedKeys()) {
      const entry = this._keys.get(key);
      if (entry.inflight === null) continue;
      const retained = entry.inflight.retained;
      entry.inflight = null;
      if (entry.pending !== null && entry.pending.intent.epoch > retained.intent.epoch) {
        entry.terminalIntent = retained.intent;
        entry.terminal = terminal(
          EffectTerminalKind.Superseded,
          retained.intent,
          retained.receipts,
          {
            observed: null,
          },
        );
        superseded += 1;
      } else {
        entry.pending = freezePending({
          ...retained,
          nextAttempt: retained.nextAttempt + 1,
          readyAt: null,
        });
        requeued += 1;
      }
    }
    return {
      change: CHANGED,
      outcome: Object.freeze({
        kind: EffectCasReconnectKind.Advanced,
        generation: newGeneration,
        requeued,
        superseded,
      }),
    };
  }

  _finishFailed(key, attempt, failure) {
    if (attempt.generation !== this._generation) {
      return {
        change: NO_CHANGE,
        outcome: Object.freeze({
          kind: EffectCasFailureKind.StaleGeneration,
          current: this._generation,
        }),
      };
    }
    const entry = this._keys.get(key);
    if (
      entry === undefined ||
      entry.inflight === null ||
      !attemptIdentityEqual(entry.inflight.attempt.identity, attempt)
    ) {
      return {
        change: NO_CHANGE,
        outcome: Object.freeze({ kind: EffectCasFailureKind.UnknownAttempt }),
      };
    }
    const retained = entry.inflight.retained;
    entry.inflight = null;
    const newerPending =
      entry.pending !== null && entry.pending.intent.epoch > retained.intent.epoch;
    const supersede = (observed) => {
      entry.retry = null;
      entry.terminalIntent = retained.intent;
      entry.terminal = terminal(EffectTerminalKind.Superseded, retained.intent, retained.receipts, {
        observed,
      });
      return {
        change: CHANGED,
        outcome: Object.freeze({ kind: EffectCasFailureKind.Superseded }),
      };
    };
    switch (failure.kind) {
      case "superseded":
        return supersede(failure.observed);
      case "retryable":
        if (newerPending) return supersede(null);
        entry.retry = Object.freeze({
          attempt: attemptIdentityOf(attempt),
          error: failure.error,
          retryAt: failure.retryAt,
        });
        entry.pending = freezePending({
          ...retained,
          nextAttempt: retained.nextAttempt + 1,
          readyAt: failure.retryAt,
        });
        return {
          change: CHANGED,
          outcome: Object.freeze({ kind: EffectCasFailureKind.Retrying, retryAt: failure.retryAt }),
        };
      default:
        entry.retry = null;
        entry.terminalIntent = retained.intent;
        entry.terminal = terminal(EffectTerminalKind.Rejected, retained.intent, retained.receipts, {
          error: failure.error,
        });
        return {
          change: CHANGED,
          outcome: Object.freeze({ kind: EffectCasFailureKind.Rejected }),
        };
    }
  }

  // -- durable image (#lzeffectcasdurable) -----------------------------------

  /**
   * Full-fidelity image for crash recovery and cross-process persistence. Unlike
   * `snapshot()` it carries the retained intent behind an in-flight attempt and
   * the last terminal intent, so it can restore the core. Keys are a list so a
   * non-string key survives JSON.
   */
  durableState() {
    return Object.freeze({
      generation: this._generation,
      keys: Object.freeze(
        this._sortedKeys().map((key) => {
          const entry = this._keys.get(key);
          return Object.freeze({
            key,
            pending: entry.pending,
            inflight:
              entry.inflight === null
                ? null
                : Object.freeze({
                    retained: entry.inflight.retained,
                    attempt: entry.inflight.attempt,
                  }),
            retry: entry.retry,
            appliedThrough: entry.appliedThrough,
            terminal: entry.terminal,
            terminalIntent: entry.terminalIntent,
          });
        }),
      ),
    });
  }

  /**
   * Restore a core from `durableState()` (or its JSON round-trip) before the
   * runtime becomes live. A corrupt image throws `EffectCasHydrateFailure`; it is
   * never repaired, so no adapter call runs on invented state. A recovering
   * actor then calls `reconnect` with a newer generation to fence the crashed
   * actor and replay its retained work under the same effect identity.
   */
  static hydrate(state, options = {}) {
    const core = new EffectCasCore(requireCount(state.generation, "generation"), options);
    const equals = core._equals;
    const fail = (reason) => {
      throw new EffectCasHydrateFailure(reason);
    };
    const validateRetained = (key, retained) => {
      if (!equals(retained.intent.key, key)) fail(EffectCasHydrateError.KeyMismatch);
      if (
        !Number.isSafeInteger(retained.nextStep) ||
        retained.nextStep < 0 ||
        retained.nextStep >= retained.intent.plan.length
      ) {
        fail(EffectCasHydrateError.CursorOutOfRange);
      }
    };
    const thawIntent = (intent) => (intent === null ? null : effectIntent(intent));
    const thawPending = (p) =>
      p === null
        ? null
        : freezePending({
            intent: effectIntent(p.intent),
            nextStep: p.nextStep,
            expected: p.expected,
            receipts: p.receipts.map((r) =>
              Object.freeze({ ...r, attempt: attemptIdentityOf(r.attempt) }),
            ),
            nextAttempt: p.nextAttempt,
            readyAt: p.readyAt,
          });
    for (const durable of state.keys) {
      if (core._keys.has(durable.key)) fail(EffectCasHydrateError.DuplicateKey);
      const pending = thawPending(durable.pending);
      if (pending !== null) validateRetained(durable.key, pending);
      const terminalIntent = thawIntent(durable.terminalIntent);
      if (terminalIntent !== null && !equals(terminalIntent.key, durable.key)) {
        fail(EffectCasHydrateError.KeyMismatch);
      }
      let inflight = null;
      if (durable.inflight !== null) {
        const retained = thawPending(durable.inflight.retained);
        validateRetained(durable.key, retained);
        const a = durable.inflight.attempt;
        if (a.identity.generation > state.generation) fail(EffectCasHydrateError.FutureGeneration);
        const matches =
          equals(a.key, durable.key) &&
          a.identity.effect === retained.intent.identity &&
          a.identity.epoch === retained.intent.epoch &&
          a.identity.step === retained.nextStep &&
          a.identity.attempt === retained.nextAttempt &&
          equals(a.expected, retained.expected) &&
          equals(a.payload, retained.intent.plan[retained.nextStep]) &&
          structuralEqual(a.priorReceipts, retained.receipts);
        if (!matches) fail(EffectCasHydrateError.AttemptMismatch);
        inflight = {
          retained,
          attempt: Object.freeze({
            identity: attemptIdentityOf(a.identity),
            key: a.key,
            expected: a.expected,
            payload: a.payload,
            priorReceipts: retained.receipts,
          }),
        };
      }
      const t = durable.terminal;
      core._keys.set(durable.key, {
        pending,
        inflight,
        retry:
          durable.retry === null
            ? null
            : Object.freeze({
                ...durable.retry,
                attempt: attemptIdentityOf(durable.retry.attempt),
              }),
        appliedThrough: durable.appliedThrough,
        terminal:
          t === null
            ? null
            : Object.freeze({
                ...t,
                receipts: Object.freeze(
                  t.receipts.map((r) =>
                    Object.freeze({ ...r, attempt: attemptIdentityOf(r.attempt) }),
                  ),
                ),
              }),
        terminalIntent,
      });
    }
    return core;
  }
}

/** A frozen copy of an exact attempt identity. */
function attemptIdentityOf(identity) {
  return Object.freeze({
    effect: identity.effect,
    generation: identity.generation,
    epoch: identity.epoch,
    step: identity.step,
    attempt: identity.attempt,
  });
}
