// EgressCore — the graph-agnostic delivery authority of the transport-agnostic
// reactive egress family (`#lzegress`).
//
// Egress is the send-side mirror of reactive ingress. This core owns every
// decision that makes delivery correct:
//
//  * monotone sequence assignment — `(generation, sequence)` is the transport
//    idempotency identity;
//  * the pending queue and the bounded unacknowledged (in-flight) window;
//  * the monotone cumulative acknowledgement watermark;
//  * retry attempts, bounded exponential backoff, and exhaustion; and
//  * the producer-generation fence.
//
// It owns no graph handles and performs no I/O. Every mutator returns the set of
// reader kinds it invalidated (`EgressChange`) beside its outcome, so the three
// graph shells (`EgressCell`, `ThreadSafeEgressCell`, `AsyncEgressCell`) project
// the same state as Computeds and invalidate exactly what moved — a no-op or a
// stale-generation transition invalidates nothing.
//
// `RelayCell`/`Outbox` stay the conflation/backpressure layer ahead of enqueue,
// `DurableOutbox`/`SpillStore` the persistence layer, and
// `LatestDurableProjectionCore` the latest-keyed-projection sink. None of them
// moves sequence assignment, acknowledgement authority, or the fence into an
// Effect.
//
// Mirrors `lazily-rs/src/egress_core.rs`; spec: lazily-spec/docs/transport-egress.md.

/** Why an `EgressPolicy` was refused. */
export const EgressConfigError = Object.freeze({
  ZeroInflightLimit: "ZeroInflightLimit",
  ZeroRetryBase: "ZeroRetryBase",
  RetryCeilingBelowBase: "RetryCeilingBelowBase",
});

export const EgressClaimKind = Object.freeze({
  Claimed: "claimed",
  Empty: "empty",
  WindowFull: "window_full",
  StaleGeneration: "stale_generation",
});

export const EgressAckKind = Object.freeze({
  Advanced: "advanced",
  Unchanged: "unchanged",
  /** `through` names a sequence never assigned (`through >= nextSequence`). */
  BeyondSent: "beyond_sent",
  StaleGeneration: "stale_generation",
});

export const EgressFailureKind = Object.freeze({
  Retrying: "retrying",
  Exhausted: "exhausted",
  UnknownSequence: "unknown_sequence",
  StaleGeneration: "stale_generation",
});

export const EgressRetryActionKind = Object.freeze({
  Scheduled: "scheduled",
  UnknownSequence: "unknown_sequence",
  StaleGeneration: "stale_generation",
});

export const EgressReconnectKind = Object.freeze({
  Advanced: "advanced",
  Unchanged: "unchanged",
  StaleGeneration: "stale_generation",
});

/** The default policy, matching lazily-rs `EgressPolicy::default()`. */
export function defaultEgressPolicy() {
  return { inflightLimit: 64, retryBudget: 3, retryBase: 10, retryCeiling: 1000 };
}

function requireCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, got ${String(value)}`);
  }
  return value;
}

/** The reader-kind invalidation set of one transition. */
function change(pending = false, inflight = false, ackedThrough = false, retry = false) {
  return Object.freeze({ pending, inflight, ackedThrough, retry });
}

const NO_CHANGE = change();

/** True when a transition invalidated no reader kind. */
export function egressChangeIsEmpty(c) {
  return !c.pending && !c.inflight && !c.ackedThrough && !c.retry;
}

function envelopeOf(record) {
  return Object.freeze({
    generation: record.generation,
    sequence: record.sequence,
    attempt: record.attempt,
    payload: record.payload,
  });
}

function retryOf(sequence, attempt, backoff, exhausted) {
  return Object.freeze({ sequence, attempt, backoff, exhausted });
}

/** Pure egress delivery authority. */
export class EgressCore {
  /**
   * @param {number} generation the producer incarnation that owns the first send
   *   attachment.
   * @param {{inflightLimit?: number, retryBudget?: number, retryBase?: number,
   *   retryCeiling?: number}} [policy] merged over `defaultEgressPolicy()`.
   */
  constructor(generation, policy = {}) {
    const merged = { ...defaultEgressPolicy(), ...policy };
    requireCount(generation, "generation");
    requireCount(merged.inflightLimit, "inflightLimit");
    requireCount(merged.retryBudget, "retryBudget");
    requireCount(merged.retryBase, "retryBase");
    requireCount(merged.retryCeiling, "retryCeiling");
    if (merged.inflightLimit === 0) throw new Error(EgressConfigError.ZeroInflightLimit);
    if (merged.retryBase === 0) throw new Error(EgressConfigError.ZeroRetryBase);
    if (merged.retryCeiling < merged.retryBase) {
      throw new Error(EgressConfigError.RetryCeilingBelowBase);
    }
    this._policy = Object.freeze(merged);
    this._generation = generation;
    this._nextSequence = 0;
    /** @type {number | null} */
    this._ackedThrough = null;
    /** Oldest sequence first. */
    this._pending = [];
    /** sequence -> record; iterated in ascending sequence order. */
    this._inflight = new Map();
    /** Retry-parked records awaiting `retryNow`. */
    this._failed = new Map();
    /** @type {object | null} */
    this._retry = null;
  }

  policy() {
    return this._policy;
  }

  get generation() {
    return this._generation;
  }

  get nextSequence() {
    return this._nextSequence;
  }

  /** The pending projection, oldest sequence first. */
  pending() {
    return this._pending.map(envelopeOf);
  }

  /** The unacknowledged window, ascending sequence. */
  inflight() {
    return [...this._inflight.values()].sort((a, b) => a.sequence - b.sequence).map(envelopeOf);
  }

  /** The cumulative acknowledgement watermark, or null before the first ACK. */
  ackedThrough() {
    return this._ackedThrough;
  }

  /** The most recent failure's retry evidence, or null. */
  retry() {
    return this._retry;
  }

  _stale() {
    return Object.freeze({ kind: "stale_generation", current: this._generation });
  }

  /** Assign the next sequence and place `payload` in the pending projection. */
  enqueue(payload) {
    const sequence = this._nextSequence;
    this._nextSequence += 1;
    this._pending.push({ generation: this._generation, sequence, attempt: 0, payload });
    return { change: change(true), sequence };
  }

  /**
   * Move the oldest pending record into the unacknowledged window. `generation`
   * is the one the caller's transport attachment captured; an attachment from a
   * superseded incarnation cannot claim.
   */
  claim(generation) {
    if (generation !== this._generation) return { change: NO_CHANGE, claim: this._stale() };
    if (this._inflight.size >= this._policy.inflightLimit) {
      return { change: NO_CHANGE, claim: Object.freeze({ kind: EgressClaimKind.WindowFull }) };
    }
    const record = this._pending.shift();
    if (record === undefined) {
      return { change: NO_CHANGE, claim: Object.freeze({ kind: EgressClaimKind.Empty }) };
    }
    record.generation = this._generation;
    record.attempt += 1;
    this._inflight.set(record.sequence, record);
    const retryChanged = this._retry !== null && this._retry.sequence === record.sequence;
    if (retryChanged) this._retry = null;
    return {
      change: change(true, true, false, retryChanged),
      claim: Object.freeze({ kind: EgressClaimKind.Claimed, envelope: envelopeOf(record) }),
    };
  }

  /** Advance the cumulative watermark and prune every record at or below it. */
  ack(generation, through) {
    if (generation !== this._generation) return { change: NO_CHANGE, ack: this._stale() };
    requireCount(through, "through");
    // Refuse an acknowledgement past the end of the sequence space BEFORE the
    // watermark check: a sequence never assigned cannot have been delivered, and
    // admitting it would prune records enqueued later without ever sending them.
    if (through >= this._nextSequence) {
      return {
        change: NO_CHANGE,
        ack: Object.freeze({ kind: EgressAckKind.BeyondSent, nextSequence: this._nextSequence }),
      };
    }
    if (this._ackedThrough !== null && through <= this._ackedThrough) {
      return {
        change: NO_CHANGE,
        ack: Object.freeze({ kind: EgressAckKind.Unchanged, through: this._ackedThrough }),
      };
    }
    const inflightBefore = this._inflight.size;
    const pendingBefore = this._pending.length;
    this._ackedThrough = through;
    for (const sequence of [...this._inflight.keys()]) {
      if (sequence <= through) this._inflight.delete(sequence);
    }
    for (const sequence of [...this._failed.keys()]) {
      if (sequence <= through) this._failed.delete(sequence);
    }
    this._pending = this._pending.filter((record) => record.sequence > through);
    const retryChanged = this._retry !== null && this._retry.sequence <= through;
    if (retryChanged) this._retry = null;
    return {
      change: change(
        this._pending.length !== pendingBefore,
        this._inflight.size !== inflightBefore,
        true,
        retryChanged,
      ),
      ack: Object.freeze({ kind: EgressAckKind.Advanced, through }),
    };
  }

  /**
   * Record a failed send of an in-flight record. While budget remains the record
   * is PARKED (not re-queued) until `retryNow`, so a failing transport cannot
   * spin the attachment Effect in an immediate reactive retry loop.
   */
  fail(generation, sequence) {
    if (generation !== this._generation) return { change: NO_CHANGE, failure: this._stale() };
    const record = this._inflight.get(sequence);
    if (record === undefined) {
      return {
        change: NO_CHANGE,
        failure: Object.freeze({ kind: EgressFailureKind.UnknownSequence }),
      };
    }
    this._inflight.delete(sequence);
    const exhausted = record.attempt > this._policy.retryBudget;
    const retry = retryOf(sequence, record.attempt, this._backoff(record.attempt), exhausted);
    this._retry = retry;
    if (!exhausted) this._failed.set(sequence, record);
    return {
      change: change(false, true, false, true),
      failure: Object.freeze({
        kind: exhausted ? EgressFailureKind.Exhausted : EgressFailureKind.Retrying,
        retry,
      }),
    };
  }

  /** Return a parked record to pending, in sequence order, once its backoff elapsed. */
  retryNow(generation, sequence) {
    if (generation !== this._generation) return { change: NO_CHANGE, action: this._stale() };
    const record = this._failed.get(sequence);
    if (record === undefined) {
      return {
        change: NO_CHANGE,
        action: Object.freeze({ kind: EgressRetryActionKind.UnknownSequence }),
      };
    }
    this._failed.delete(sequence);
    this._insertPendingOrdered(record);
    const retryChanged = this._retry !== null && this._retry.sequence === sequence;
    if (retryChanged) this._retry = null;
    return {
      change: change(true, false, false, retryChanged),
      action: Object.freeze({ kind: EgressRetryActionKind.Scheduled, sequence }),
    };
  }

  /**
   * Fence the previous attachment and replay every unacknowledged in-flight or
   * retry-parked record under `generation`. The ACK watermark and the sequence
   * space survive; only the producer incarnation changes.
   */
  reconnect(generation) {
    requireCount(generation, "generation");
    if (generation < this._generation) {
      return { change: NO_CHANGE, reconnect: this._stale() };
    }
    if (generation === this._generation) {
      return {
        change: NO_CHANGE,
        reconnect: Object.freeze({ kind: EgressReconnectKind.Unchanged, generation }),
      };
    }
    this._generation = generation;
    const replayed = this._inflight.size + this._failed.size;
    const replay = [...this._inflight.values(), ...this._failed.values()].sort(
      (a, b) => a.sequence - b.sequence,
    );
    this._inflight = new Map();
    this._failed = new Map();
    for (const record of replay) this._insertPendingOrdered(record);
    for (const record of this._pending) record.generation = generation;
    const retryChanged = this._retry !== null;
    this._retry = null;
    // Every retained pending envelope was rewritten to the new generation, so
    // the pending projection changed even when nothing was replayed into it.
    const pendingChanged = replayed > 0 || this._pending.length > 0;
    return {
      change: change(pendingChanged, replayed > 0, false, retryChanged),
      reconnect: Object.freeze({ kind: EgressReconnectKind.Advanced, generation, replayed }),
    };
  }

  _insertPendingOrdered(record) {
    const position = this._pending.findIndex((existing) => existing.sequence > record.sequence);
    if (position === -1) this._pending.push(record);
    else this._pending.splice(position, 0, record);
  }

  /** `min(retryCeiling, retryBase * 2^(attempt - 1))`. */
  _backoff(attempt) {
    const shift = Math.min(Math.max(attempt - 1, 0), 63);
    return Math.min(this._policy.retryCeiling, this._policy.retryBase * 2 ** shift);
  }
}
