// IngressCore — the graph-agnostic admission algebra behind every ingress
// flavor (`#designimplementtransport`).
//
// Same split `keyed-order.js` makes for the map family and `queue.js` makes for
// the broadcast family, and for the same reason: deciding whether an inbound
// envelope is *admissible* touches no handle and awaits nothing, so the
// single-threaded, thread-safe, and async shells share it verbatim — while
// **reactivity deliberately stays out**. Invalidation is a graph write, so each
// flavor mints its own per-scope readers on its own graph and clears exactly the
// set the core reports.
//
// Every mutator therefore returns an `IngressChange` — *which* reader kinds the
// transition dirtied — rather than performing the invalidation itself. That
// return value is the whole contract between the core and a shell, and it is a
// pure function of the transition, which is what makes the plane portable across
// flavors without re-deriving values per flavor.
//
// Transport-agnostic by construction: the core never touches a transport. An
// envelope is a value carrying its own provenance — generation, sequence,
// stampedAt — so a WebSocket frame, an RPC response, and a polled page are the
// *same* input once decoded. That is what makes stale rejection, dedupe,
// reorder, freshness, and backpressure independent of how bytes arrived, and it
// is why IngressTransportKind exists only to derive a *schedule*.
//
// Readiness, authority, and retry are derives, not imperative refresh calls:
// they are pure functions of scope state on ScopeView that each shell exposes as
// a Computed. Freshness is time-dependent, so it enters through an explicit
// tick(now) rather than a hidden clock read — the same discipline TimerCell uses,
// and the reason staleness transitions are deterministic in fixtures.
//
// Private state uses the `_` prefix, matching `reactive-family.js` and
// `thread-safe-reactive-family.js`.
//
// Spec: `lazily-spec/docs/transport-ingress.md`.

import { Overflow } from "./relay.js";

// ---------------------------------------------------------------------------
// Vocabulary — string-valued enums, spelled exactly as the canonical corpus
// spells them, so a runner needs no translation table that could drift.
// ---------------------------------------------------------------------------

/**
 * How envelopes reach a scope. Event delivery is the default and needs no
 * schedule; the other two exist so a deployment without an event channel still
 * has a *bounded* fallback rather than an unbounded refresh loop.
 */
export const IngressTransportKind = Object.freeze({
  /** Server-initiated delivery (WebSocket, SSE, in-proc channel). Preferred. */
  EventChannel: "event_channel",
  /** Client-initiated, but triggered by an out-of-band event, not a timer. */
  RpcTriggered: "rpc_triggered",
  /** Client-initiated on a bounded interval. The fallback of last resort. */
  BoundedPolling: "bounded_polling",
});

/** Where a scope is in its lifecycle. Scopes are keyed and independent. */
export const IngressLifecycle = Object.freeze({
  /** Opened, nothing delivered yet. */
  Opening: "opening",
  /** Delivering. */
  Live: "live",
  /** Disconnected but retained: state and cursors survive for replay. */
  Suspended: "suspended",
  /** Terminal until reopened. Admits nothing. */
  Closed: "closed",
});

/** The derived answer to "can a consumer trust this scope right now?". */
export const IngressReadiness = Object.freeze({
  /** No such scope. */
  Unknown: "unknown",
  /** Open, nothing delivered yet. */
  Warming: "warming",
  /** Delivered and inside the freshness horizon. */
  Ready: "ready",
  /** Delivered, but the newest accepted stamp is older than the horizon. */
  Stale: "stale",
  /** Disconnected; retained state may be replayed. */
  Suspended: "suspended",
  /** Terminal. */
  Closed: "closed",
});

/**
 * Why an envelope was refused. Every variant is a *decision*, not a failure —
 * dropping a superseded envelope is correct behaviour and is receipted as such.
 */
export const IngressDropReason = Object.freeze({
  /** The generation is below the scope's fence: a zombie producer. */
  StaleGeneration: "stale_generation",
  /** The sequence was already delivered in this generation. */
  DuplicateSequence: "duplicate_sequence",
  /** The sequence is already sitting in the reorder buffer. */
  DuplicateBuffered: "duplicate_buffered",
  /** The reorder buffer is full and this envelope does not fill the gap. */
  ReorderWindowOverflow: "reorder_window_overflow",
  /** now - stampedAt exceeds the freshness horizon. */
  Expired: "expired",
  /** The hot window is at highWater under a bounding overflow policy. */
  Backpressure: "backpressure",
  /** The scope is closed; it admits nothing until reopened. */
  ScopeClosed: "scope_closed",
});

/**
 * A transport- or decode-level failure attributed to a scope. Distinct from a
 * drop: an error means we could not *decide*, so it drives retry.
 */
export const IngressError = Object.freeze({
  /** The transport closed or reset under us. */
  TransportClosed: "transport_closed",
  /** The frame could not be decoded into an envelope. */
  DecodeFailed: "decode_failed",
  /** The producer reported that our generation is no longer authoritative. */
  AuthorityLost: "authority_lost",
});

/** The discriminant of an admission outcome. */
export const IngressAdmissionKind = Object.freeze({
  /** Delivered in order; the window holds exactly this one op. */
  Accepted: "accepted",
  /** Delivered in order and coalesced with at least one other op. */
  Conflated: "conflated",
  /** Held pending an earlier sequence. Nothing is visible yet. */
  Buffered: "buffered",
  /** A newer producer incarnation took over; sequence expectations reset. */
  GenerationHandoff: "generation_handoff",
  /** Refused, with the reason receipted. */
  Dropped: "dropped",
  /** Refused by Overflow.Block; the producer must retry after a drain. */
  Blocked: "blocked",
});

/**
 * Which receipt channel a receipt belongs to. The three are separate reader
 * kinds because they have separate consumers: a projection wants accepts, a
 * dashboard wants drops, a supervisor wants errors.
 */
export const IngressReceiptChannel = Object.freeze({
  Accepted: "accepted",
  Dropped: "dropped",
  Error: "error",
});

/** Why a policy was refused at construction time. */
export const IngressConfigError = Object.freeze({
  /** Overflow.Conflate chosen for a non-conflating merge policy. */
  ConflateNotBounding: "ConflateNotBounding",
  /** A zero receipt capacity would discard every receipt it just minted. */
  ZeroReceiptCapacity: "ZeroReceiptCapacity",
});

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * Bounds and taxes, all flavor-neutral. Field names are camelCase; the
 * canonical corpus spells them snake_case and its runner converts.
 */
export function defaultIngressPolicy(overrides = {}) {
  return {
    /** How many out-of-order envelopes may be held per scope. 0 disables reordering. */
    reorderWindow: 8,
    /** now - stampedAt above this marks a scope stale; an arriving envelope that old is dropped. */
    freshnessHorizon: 1000,
    /** Merged-op count at which `overflow` engages. */
    highWater: 64,
    /** What to do at highWater. */
    overflow: Overflow.Conflate,
    /** Retained receipts, oldest evicted first. */
    receiptCapacity: 256,
    /** First retry backoff; doubles per consecutive error. */
    retryBase: 10,
    /** Backoff clamp. */
    retryCeiling: 10000,
    ...overrides,
  };
}

/**
 * Derive the delivery schedule for `kind`. A poll interval is offered only
 * where event delivery is unavailable, and never zero — "we polled a transport
 * that pushes" and "we polled in a tight loop" are both unrepresentable rather
 * than merely discouraged.
 */
export function ingressSchedule(kind, pollInterval) {
  return Object.freeze({
    kind,
    pollInterval: kind === IngressTransportKind.BoundedPolling ? Math.max(1, pollInterval) : null,
  });
}

/**
 * One decoded inbound message, with the provenance admission needs.
 *
 * `generation` fences a producer incarnation (a reconnect, a redeploy, a build
 * skew); `sequence` orders within a generation; `stampedAt` is the producer's
 * logical time, which is what freshness is measured against.
 */
export function ingressEnvelope(key, generation, sequence, stampedAt, payload) {
  return { key, generation, sequence, stampedAt, payload };
}

/** Whether an admission outcome became visible to readers. */
export function isDelivered(admission) {
  return (
    admission.kind === IngressAdmissionKind.Accepted ||
    admission.kind === IngressAdmissionKind.Conflated ||
    admission.kind === IngressAdmissionKind.GenerationHandoff
  );
}

/** The channel a receipt is read from. */
export function receiptChannel(receipt) {
  switch (receipt.outcome.kind) {
    case "accepted":
      return IngressReceiptChannel.Accepted;
    case "dropped":
      return IngressReceiptChannel.Dropped;
    case "error":
      return IngressReceiptChannel.Error;
    // Receipts are minted only by `IngressCore._pushReceipt` in this module, so
    // the outcome vocabulary is closed and internal — nothing decodes one off a
    // wire. The old `default: return Error` meant a receipt shape this module
    // no longer mints (or one a caller hand-rolled) was routed to the error
    // channel and counted as a delivery failure that never happened.
    default:
      throw new TypeError(`unknown ingress receipt outcome kind: ${String(receipt.outcome.kind)}`);
  }
}

// ---------------------------------------------------------------------------
// The invalidation set — the whole contract between core and shell
// ---------------------------------------------------------------------------

/** Nothing changed: the shell must not clear a reader. */
function noScopeChange() {
  return { value: false, readiness: false, authority: false, retry: false };
}

function allScopeChange() {
  return { value: true, readiness: true, authority: true, retry: true };
}

function readinessOnly() {
  return { value: false, readiness: true, authority: false, retry: false };
}

function valueOnly() {
  return { value: true, readiness: false, authority: false, retry: false };
}

function retryOnly() {
  return { value: false, readiness: false, authority: false, retry: true };
}

/**
 * What materializing a previously-unknown scope changes: an unknown scope reads
 * Unknown/null, so its first appearance moves readiness and authority — and
 * nothing else. A reader that observed a key before it opened must learn that
 * it did.
 */
function creationChange() {
  return { value: false, readiness: true, authority: true, retry: false };
}

function unionScopeChange(a, b) {
  return {
    value: a.value || b.value,
    readiness: a.readiness || b.readiness,
    authority: a.authority || b.authority,
    retry: a.retry || b.retry,
  };
}

function scopeChangeIsEmpty(change) {
  return !(change.value || change.readiness || change.authority || change.retry);
}

/** An empty IngressChange. */
export function emptyIngressChange() {
  return {
    /** @type {Array<[unknown, {value: boolean, readiness: boolean, authority: boolean, retry: boolean}]>} */
    scopes: [],
    acceptedReceipts: false,
    droppedReceipts: false,
    errorReceipts: false,
  };
}

/** Whether a transition dirtied nothing at all. */
export function ingressChangeIsEmpty(change) {
  return (
    change.scopes.length === 0 &&
    !change.acceptedReceipts &&
    !change.droppedReceipts &&
    !change.errorReceipts
  );
}

function markScope(change, key, scopeChange) {
  if (!scopeChangeIsEmpty(scopeChange)) {
    change.scopes.push([key, scopeChange]);
  }
}

function markChannel(change, channel) {
  if (channel === IngressReceiptChannel.Accepted) change.acceptedReceipts = true;
  else if (channel === IngressReceiptChannel.Dropped) change.droppedReceipts = true;
  else change.errorReceipts = true;
}

// ---------------------------------------------------------------------------
// ScopeView — the read-only projection every derive is computed from
// ---------------------------------------------------------------------------

/**
 * A shell's reader closures call these and nothing else, which is why the three
 * flavors cannot disagree about readiness, authority, or retry.
 */
export class ScopeView {
  constructor(fields) {
    /** @type {string} lifecycle position */
    this.lifecycle = fields.lifecycle;
    /** @type {number} generation fence */
    this.generation = fields.generation;
    /** @type {number | null} in-order watermark */
    this.deliveredThrough = fields.deliveredThrough;
    /** @type {number} producer stamp of the newest delivered envelope */
    this.stampedAt = fields.stampedAt;
    /** @type {number} buffered out-of-order envelopes */
    this.buffered = fields.buffered;
    /** @type {number} merged ops in the hot window */
    this.windowDepth = fields.windowDepth;
    /** @type {number} consecutive errors since the last delivery */
    this.consecutiveErrors = fields.consecutiveErrors;
    /** @type {number} logical now, as of the last tick */
    this.observedNow = fields.observedNow;
    /** @type {object} bounds in force */
    this.policy = fields.policy;
    Object.freeze(this);
  }

  /** Whether the newest delivered stamp is inside the freshness horizon. */
  isFresh() {
    return Math.max(0, this.observedNow - this.stampedAt) <= this.policy.freshnessHorizon;
  }

  /**
   * Derived readiness. A scope that has never delivered is Warming, not Stale,
   * because there is no stamp to be old.
   */
  readiness() {
    switch (this.lifecycle) {
      case IngressLifecycle.Closed:
        return IngressReadiness.Closed;
      case IngressLifecycle.Suspended:
        return IngressReadiness.Suspended;
      case IngressLifecycle.Opening:
        return IngressReadiness.Warming;
      default:
        if (this.deliveredThrough === null) return IngressReadiness.Warming;
        return this.isFresh() ? IngressReadiness.Ready : IngressReadiness.Stale;
    }
  }

  /** Derived authority. A closed scope claims none. */
  authority() {
    if (this.lifecycle === IngressLifecycle.Closed) return null;
    return {
      generation: this.generation,
      deliveredThrough: this.deliveredThrough,
      stampedAt: this.stampedAt,
    };
  }

  /** The first sequence not yet delivered in order. */
  resumeFrom() {
    return this.deliveredThrough === null ? 0 : this.deliveredThrough + 1;
  }

  /**
   * Whether the scope is holding a gap open — an out-of-order buffer that a
   * replay, not a retry, is the fix for.
   */
  hasGap() {
    return this.buffered > 0;
  }

  /**
   * Derived retry. `null` while no error is outstanding — a healthy scope has
   * no backoff, rather than a zero one.
   */
  retry() {
    if (this.consecutiveErrors === 0) return null;
    const shift = Math.min(31, Math.max(0, this.consecutiveErrors - 1));
    const backoff = Math.min(this.policy.retryCeiling, this.policy.retryBase * 2 ** shift);
    return { attempt: this.consecutiveErrors, backoff, resumeFrom: this.resumeFrom() };
  }
}

// ---------------------------------------------------------------------------
// Scope — mutable per-key admission state
// ---------------------------------------------------------------------------

class Scope {
  constructor(generation) {
    this.lifecycle = IngressLifecycle.Opening;
    this.generation = generation;
    /** @type {number | null} */
    this.deliveredThrough = null;
    this.stampedAt = 0;
    /** @type {Map<number, {payload: unknown, stampedAt: number}>} */
    this.pending = new Map();
    // `hasWindow` rather than a null window: a payload may legitimately BE
    // null, and "empty window" must stay distinguishable from "a null op was
    // delivered". Readers project the empty window as null, matching
    // QueueCell's head reader.
    this.hasWindow = false;
    /** @type {unknown} */
    this.windowValue = null;
    this.windowDepth = 0;
    this.consecutiveErrors = 0;
  }

  view(observedNow, policy) {
    return new ScopeView({
      lifecycle: this.lifecycle,
      generation: this.generation,
      deliveredThrough: this.deliveredThrough,
      stampedAt: this.stampedAt,
      buffered: this.pending.size,
      windowDepth: this.windowDepth,
      consecutiveErrors: this.consecutiveErrors,
      observedNow,
      policy,
    });
  }

  nextExpected() {
    return this.deliveredThrough === null ? 0 : this.deliveredThrough + 1;
  }

  /**
   * Everything a reader can observe *about shape rather than payload*. The
   * buffered path diffs these to derive its invalidation set, so "a buffered
   * envelope invalidates nothing" is a computed fact rather than a claim — and
   * the handoff-then-buffer case (which clears the window) cannot slip through.
   */
  stamp() {
    return [this.lifecycle, this.generation, this.deliveredThrough, this.hasWindow];
  }

  liveOrOpening() {
    return this.deliveredThrough === null ? IngressLifecycle.Opening : IngressLifecycle.Live;
  }
}

// ---------------------------------------------------------------------------
// IngressCore
// ---------------------------------------------------------------------------

/**
 * Keyed lifecycle scopes, an admission algebra, and a bounded receipt log. No
 * context, no handles, nothing awaited — each flavor wraps this in its own
 * shell and owns its own reactivity.
 */
export class IngressCore {
  /**
   * @param {object} policy see {@link defaultIngressPolicy}
   * @param {{merge: (old: unknown, op: unknown) => unknown, conflates: boolean}} mergePolicy
   *   Validated against the overflow choice exactly as RelayCell validates it:
   *   Conflate bounds nothing for a non-conflating merge.
   */
  constructor(policy, mergePolicy) {
    if (policy.overflow === Overflow.Conflate && !mergePolicy.conflates) {
      throw new Error(IngressConfigError.ConflateNotBounding);
    }
    if (policy.receiptCapacity === 0) {
      throw new Error(IngressConfigError.ZeroReceiptCapacity);
    }
    this._policy = Object.freeze({ ...policy });
    this._merge = mergePolicy;
    /** @type {Map<unknown, Scope>} */
    this._scopes = new Map();
    /** @type {Array<object>} */
    this._receipts = [];
    this._nextReceiptOffset = 0;
    this._observedNow = 0;
  }

  /** The bounds in force. */
  policy() {
    return this._policy;
  }

  /** Every known scope key, for a shell rebuilding its reader table. */
  scopeKeys() {
    return [...this._scopes.keys()];
  }

  /** Read-only projection of one scope, or null when unknown. */
  view(key) {
    const scope = this._scopes.get(key);
    return scope === undefined ? null : scope.view(this._observedNow, this._policy);
  }

  /**
   * Readiness of a scope. Unknown scopes read Unknown rather than throwing: a
   * reader may legitimately observe a key before it opens.
   */
  readiness(key) {
    const view = this.view(key);
    return view === null ? IngressReadiness.Unknown : view.readiness();
  }

  /** Authority claimed by a scope. */
  authority(key) {
    const view = this.view(key);
    return view === null ? null : view.authority();
  }

  /** Retry decision for a scope. */
  retry(key) {
    const view = this.view(key);
    return view === null ? null : view.retry();
  }

  /** The coalesced window awaiting drain, or null when empty. */
  peek(key) {
    const scope = this._scopes.get(key);
    if (scope === undefined || !scope.hasWindow) return null;
    return scope.windowValue;
  }

  /** Whether a scope's hot window holds anything. */
  hasWindow(key) {
    const scope = this._scopes.get(key);
    return scope !== undefined && scope.hasWindow;
  }

  /** Receipts on one channel, oldest first. */
  receipts(channel) {
    return this._receipts.filter((receipt) => receiptChannel(receipt) === channel);
  }

  /** Logical now, as of the last tick. */
  observedNow() {
    return this._observedNow;
  }

  // -- lifecycle ------------------------------------------------------------

  /**
   * Open (or reopen) a scope at `generation`.
   *
   * Reopening a suspended scope preserves its watermark so a replay can resume
   * from the gap; reopening a *closed* scope resets it, because a closed
   * scope's producer is gone and its sequence space is not resumable.
   */
  open(key, generation) {
    const change = emptyIngressChange();
    let scope = this._scopes.get(key);
    if (scope === undefined) {
      this._scopes.set(key, new Scope(generation));
      markScope(change, key, creationChange());
      return change;
    }
    const before = [scope.lifecycle, scope.generation, scope.deliveredThrough];
    if (scope.lifecycle === IngressLifecycle.Closed) {
      scope = new Scope(generation);
      this._scopes.set(key, scope);
    } else {
      scope.lifecycle = scope.liveOrOpening();
      if (generation > scope.generation) {
        scope.generation = generation;
        scope.deliveredThrough = null;
        scope.pending.clear();
      }
    }
    const after = [scope.lifecycle, scope.generation, scope.deliveredThrough];
    if (before[0] !== after[0] || before[1] !== after[1] || before[2] !== after[2]) {
      markScope(change, key, {
        value: false,
        readiness: before[0] !== after[0],
        authority: true,
        retry: false,
      });
    }
    return change;
  }

  /**
   * Suspend a scope: retain state and cursors, stop delivering. Returns the
   * replay request a reconnect will need, or null when there was nothing to
   * suspend.
   */
  suspend(key) {
    const change = emptyIngressChange();
    const scope = this._scopes.get(key);
    if (scope === undefined) return { change, replay: null };
    if (
      scope.lifecycle === IngressLifecycle.Suspended ||
      scope.lifecycle === IngressLifecycle.Closed
    ) {
      return { change, replay: null };
    }
    scope.lifecycle = IngressLifecycle.Suspended;
    const replay = { generation: scope.generation, fromSequence: scope.nextExpected() };
    markScope(change, key, readinessOnly());
    return { change, replay };
  }

  /**
   * Reconnect a scope at `generation`, clearing the error streak.
   *
   * A higher generation is a producer handoff: the sequence space restarts, so
   * the buffered reorder window and the coalesced value are discarded rather
   * than replayed against a fence they no longer belong to.
   */
  reconnect(key, generation) {
    const change = emptyIngressChange();
    const created = !this._scopes.has(key);
    let scope = this._scopes.get(key);
    if (scope === undefined) {
      scope = new Scope(generation);
      this._scopes.set(key, scope);
    }
    const handoff = generation > scope.generation;
    const hadWindow = scope.hasWindow;
    if (handoff) {
      scope.generation = generation;
      scope.deliveredThrough = null;
      scope.pending.clear();
      scope.hasWindow = false;
      scope.windowValue = null;
      scope.windowDepth = 0;
    }
    const beforeLifecycle = scope.lifecycle;
    scope.lifecycle = scope.liveOrOpening();
    const hadErrors = scope.consecutiveErrors > 0;
    scope.consecutiveErrors = 0;
    const replay = { generation: scope.generation, fromSequence: scope.nextExpected() };
    const base = {
      value: handoff && hadWindow,
      readiness: beforeLifecycle !== scope.lifecycle,
      authority: handoff,
      retry: hadErrors,
    };
    markScope(change, key, created ? unionScopeChange(base, creationChange()) : base);
    return { change, replay };
  }

  /** Close a scope. It admits nothing and claims no authority until reopened. */
  close(key) {
    const change = emptyIngressChange();
    const scope = this._scopes.get(key);
    if (scope === undefined || scope.lifecycle === IngressLifecycle.Closed) return change;
    const hadWindow = scope.hasWindow;
    const hadErrors = scope.consecutiveErrors > 0;
    scope.lifecycle = IngressLifecycle.Closed;
    scope.pending.clear();
    scope.hasWindow = false;
    scope.windowValue = null;
    scope.windowDepth = 0;
    scope.consecutiveErrors = 0;
    markScope(change, key, {
      value: hadWindow,
      readiness: true,
      authority: true,
      retry: hadErrors,
    });
    return change;
  }

  /**
   * Advance logical time. Only scopes that *crossed* the freshness horizon are
   * dirtied — a tick inside the horizon invalidates nothing, which is what
   * keeps a polling shell from re-rendering on every tick.
   */
  tick(now) {
    const change = emptyIngressChange();
    if (now === this._observedNow) return change;
    const before = this._observedNow;
    this._observedNow = now;
    for (const [key, scope] of this._scopes) {
      if (
        scope.view(before, this._policy).readiness() !== scope.view(now, this._policy).readiness()
      ) {
        markScope(change, key, readinessOnly());
      }
    }
    return change;
  }

  /** Record a transport/decode failure against a scope, deepening its backoff. */
  fail(key, error) {
    const change = emptyIngressChange();
    const created = !this._scopes.has(key);
    let scope = this._scopes.get(key);
    if (scope === undefined) {
      scope = new Scope(0);
      this._scopes.set(key, scope);
    }
    scope.consecutiveErrors += 1;
    const base = retryOnly();
    markScope(change, key, created ? unionScopeChange(base, creationChange()) : base);
    markChannel(
      change,
      this._pushReceipt({
        key,
        generation: scope.generation,
        sequence: null,
        outcome: { kind: "error", error },
      }),
    );
    return change;
  }

  /**
   * Drain a scope's coalesced window, resetting its depth. Returns
   * `drained: null` for an empty window and dirties nothing.
   *
   * A drain is an *egress*, not an ack: it never moves the watermark, so a
   * replay after a drain still resumes from the same sequence.
   */
  drain(key) {
    const change = emptyIngressChange();
    const scope = this._scopes.get(key);
    if (scope === undefined || !scope.hasWindow) return { change, drained: null };
    const drained = scope.windowValue;
    scope.hasWindow = false;
    scope.windowValue = null;
    scope.windowDepth = 0;
    markScope(change, key, valueOnly());
    return { change, drained };
  }

  // -- admission ------------------------------------------------------------

  /**
   * Admit one envelope, applying — in this order — scope lifecycle, the
   * generation fence, freshness, generation handoff, dedupe, ordering, and
   * backpressure, then the merge.
   *
   * The order is the contract: a zombie generation is rejected before its stale
   * sequence is consulted, and an expired envelope is rejected before it can
   * occupy a reorder slot.
   */
  admit(envelope) {
    const { key, generation, sequence, stampedAt, payload } = envelope;
    const created = !this._scopes.has(key);
    const existing = this._scopes.get(key);
    const before = existing === undefined ? null : existing.stamp();
    let scope = existing;
    if (scope === undefined) {
      scope = new Scope(generation);
      this._scopes.set(key, scope);
    }
    const decision = this._decide(scope, generation, sequence, stampedAt, payload);

    // A refused envelope must not leave a scope behind: an expired or blocked
    // message for a key we do not track is not an admission plane, and
    // materializing one would report a readiness change that never happened.
    const admitted = decision.kind === "buffered" || decision.kind === "delivered";
    if (created && !admitted) {
      this._scopes.delete(key);
    }

    const change = emptyIngressChange();
    const survivor = this._scopes.get(key);
    const fence = survivor === undefined ? generation : survivor.generation;

    if (decision.kind === "refuse" || decision.kind === "block") {
      const reason = decision.kind === "block" ? IngressDropReason.Backpressure : decision.reason;
      markChannel(
        change,
        this._pushReceipt({
          key,
          generation: fence,
          sequence,
          outcome: { kind: "dropped", reason },
        }),
      );
      return {
        change,
        admission:
          decision.kind === "block"
            ? { kind: IngressAdmissionKind.Blocked }
            : { kind: IngressAdmissionKind.Dropped, reason: decision.reason },
      };
    }

    if (decision.kind === "buffered") {
      // A buffered envelope mints no receipt, and for an already-current scope
      // it dirties no reader, because nothing a reader can observe moved. Two
      // cases are NOT invisible and are derived rather than assumed: the
      // scope's own first appearance (it moves off Unknown), and a generation
      // handoff that buffers — which resets the fence, the watermark, and the
      // window before parking the envelope.
      let scopeChange = created ? creationChange() : noScopeChange();
      const after = survivor === undefined ? null : survivor.stamp();
      if (before !== null && after !== null) {
        scopeChange = unionScopeChange(scopeChange, {
          value: before[3] !== after[3],
          readiness: before[0] !== after[0] || (before[2] === null) !== (after[2] === null),
          authority: before[1] !== after[1] || before[2] !== after[2],
          retry: false,
        });
      }
      markScope(change, key, scopeChange);
      return {
        change,
        admission: { kind: IngressAdmissionKind.Buffered, gapFrom: decision.gapFrom },
      };
    }

    markScope(change, key, allScopeChange());
    markChannel(
      change,
      this._pushReceipt({
        key,
        generation: fence,
        sequence,
        outcome: {
          kind: "accepted",
          deliveredThrough: decision.deliveredThrough,
          conflated: decision.conflated,
        },
      }),
    );
    let admission;
    if (decision.handoff !== null) {
      admission = {
        kind: IngressAdmissionKind.GenerationHandoff,
        from: decision.handoff[0],
        to: decision.handoff[1],
      };
    } else if (decision.conflated) {
      admission = {
        kind: IngressAdmissionKind.Conflated,
        deliveredThrough: decision.deliveredThrough,
      };
    } else {
      admission = {
        kind: IngressAdmissionKind.Accepted,
        deliveredThrough: decision.deliveredThrough,
      };
    }
    return { change, admission };
  }

  /**
   * The admission algebra proper: pure over one scope, mutating only that
   * scope, minting nothing.
   */
  _decide(scope, generation, sequence, stampedAt, payload) {
    const policy = this._policy;

    if (scope.lifecycle === IngressLifecycle.Closed) {
      return { kind: "refuse", reason: IngressDropReason.ScopeClosed };
    }
    // The fence outranks dedupe. A zombie producer replaying old sequences
    // under an old generation must stay distinguishable from a legitimate
    // retry; testing the sequence first would report duplicate_sequence and
    // hide the zombie.
    if (generation < scope.generation) {
      return { kind: "refuse", reason: IngressDropReason.StaleGeneration };
    }
    // Freshness outranks ordering: an expired envelope must never occupy a
    // reorder slot, or a slow zombie exhausts the buffer and starves live data.
    if (Math.max(0, this._observedNow - stampedAt) > policy.freshnessHorizon) {
      return { kind: "refuse", reason: IngressDropReason.Expired };
    }

    let handoff = null;
    if (generation > scope.generation) {
      // A handoff is a baseline reset, not a continuation: the new
      // incarnation's first envelope is authoritative, so the old
      // incarnation's undrained window and buffered successors are discarded
      // rather than folded into it. Merging a superseded delta into a fresh
      // baseline is exactly the build-skew corruption the generation fence
      // exists to prevent, and it is the same rule reconnect applies.
      handoff = [scope.generation, generation];
      scope.generation = generation;
      scope.deliveredThrough = null;
      scope.pending.clear();
      scope.hasWindow = false;
      scope.windowValue = null;
      scope.windowDepth = 0;
    }

    const expected = scope.nextExpected();
    if (sequence < expected) {
      return { kind: "refuse", reason: IngressDropReason.DuplicateSequence };
    }
    if (sequence > expected) {
      if (scope.pending.has(sequence)) {
        return { kind: "refuse", reason: IngressDropReason.DuplicateBuffered };
      }
      if (scope.pending.size >= policy.reorderWindow) {
        return { kind: "refuse", reason: IngressDropReason.ReorderWindowOverflow };
      }
      scope.pending.set(sequence, { payload, stampedAt });
      return { kind: "buffered", gapFrom: expected };
    }

    // In order. Backpressure is checked here and not earlier: refusing an
    // in-order envelope leaves a gap the reorder buffer cannot close, so
    // Block must be observable by the producer as its own outcome.
    if (scope.windowDepth >= policy.highWater) {
      switch (policy.overflow) {
        case Overflow.Block:
          // Refuse WITHOUT advancing the watermark, which is what makes the
          // producer's retry after a drain in-order rather than a duplicate.
          return { kind: "block" };
        case Overflow.DropNewest:
          return { kind: "refuse", reason: IngressDropReason.Backpressure };
        case Overflow.DropOldest:
          scope.hasWindow = false;
          scope.windowValue = null;
          scope.windowDepth = 0;
          break;
        // Conflate *is* the bound; Spill degrades to it until a durable tail
        // is wired, exactly as RelayCell does.
        case Overflow.Conflate:
        case Overflow.Spill:
          break;
        // `policy.overflow` is caller-supplied in-process configuration, not a
        // field decoded from a peer, so an unrecognised value has no
        // forward-compat reading. It used to land in the Conflate/Spill arm
        // above and silently conflate, which is the one outcome that never
        // reports backpressure — a mis-spelled policy read as a working bound.
        default:
          throw new TypeError(`unknown IngressCore overflow policy: ${String(policy.overflow)}`);
      }
    }

    let conflated = this._mergeInto(scope, payload, stampedAt);
    scope.deliveredThrough = sequence;
    scope.lifecycle = IngressLifecycle.Live;
    scope.consecutiveErrors = 0;
    let deliveredThrough = sequence;

    // Flush every buffered successor this delivery unblocked. One invalidation
    // covers the whole flush: readers observe the coalesced window, never a
    // partial replay. The buffer replays in SEQUENCE order, which is why a
    // merely associative merge converges to the in-order fold under reordering.
    for (;;) {
      const next = scope.nextExpected();
      const buffered = scope.pending.get(next);
      if (buffered === undefined) break;
      scope.pending.delete(next);
      conflated = this._mergeInto(scope, buffered.payload, buffered.stampedAt) || conflated;
      scope.deliveredThrough = next;
      deliveredThrough = next;
    }

    return { kind: "delivered", deliveredThrough, conflated, handoff };
  }

  /**
   * Merge one payload into a scope's hot head. Returns whether it coalesced
   * with an existing window.
   */
  _mergeInto(scope, payload, stampedAt) {
    let conflated;
    if (!scope.hasWindow) {
      scope.windowValue = payload;
      scope.hasWindow = true;
      conflated = false;
    } else {
      scope.windowValue = this._merge.merge(scope.windowValue, payload);
      conflated = true;
    }
    scope.windowDepth += 1;
    scope.stampedAt = Math.max(scope.stampedAt, stampedAt);
    return conflated;
  }

  _pushReceipt(partial) {
    const receipt = Object.freeze({ offset: this._nextReceiptOffset, ...partial });
    this._nextReceiptOffset += 1;
    this._receipts.push(receipt);
    while (this._receipts.length > this._policy.receiptCapacity) {
      this._receipts.shift();
    }
    return receiptChannel(receipt);
  }
}

// ---------------------------------------------------------------------------
// The transport seam
// ---------------------------------------------------------------------------

/**
 * An in-process event channel: the reference ingress transport, and the one the
 * conformance corpus replays against.
 *
 * A transport DECODES; it does not decide. `kind` is configurable so one
 * implementation exercises all three delivery modes — including the
 * BoundedPolling case that cannot serve a replay.
 */
export class InProcIngress {
  constructor(kind) {
    this.kind = kind;
    /** @type {Array<object>} */
    this.inbound = [];
    /** @type {Array<[unknown, {generation: number, fromSequence: number}]>} */
    this.replayRequests = [];
  }

  /** Queue one envelope for the next drain. */
  push(envelope) {
    this.inbound.push(envelope);
    return this;
  }

  /** Take everything decoded since the last call. Never blocks. */
  drain() {
    const batch = this.inbound;
    this.inbound = [];
    return batch;
  }

  /**
   * Ask the producer to resend from `request.fromSequence`. Returns whether the
   * transport could carry the request — a bounded poll has no addressable
   * history, so it answers false, which makes "this gap will never close"
   * observable rather than silent.
   */
  requestReplay(key, request) {
    if (this.kind === IngressTransportKind.BoundedPolling) return false;
    this.replayRequests.push([key, request]);
    return true;
  }

  /** Replay requests observed so far, oldest first. */
  replays() {
    return this.replayRequests.map(([key, request]) => [key, { ...request }]);
  }
}
