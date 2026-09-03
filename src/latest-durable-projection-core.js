// LatestDurableProjectionCore — graph-independent latest-state delivery
// authority (`#lzlatestdurableprojection`).

export const LatestDurableUpsert = Object.freeze({
  Accepted: "accepted",
  Unchanged: "unchanged",
  AlreadyDurable: "already_durable",
  StaleEpoch: "stale_epoch",
  EpochConflict: "epoch_conflict",
});

export const LatestDurableClaim = Object.freeze({
  Claimed: "claimed",
  Empty: "empty",
  Busy: "busy",
  StaleGeneration: "stale_generation",
});

export const LatestDurableAck = Object.freeze({
  Advanced: "advanced",
  Unchanged: "unchanged",
  UnknownEpoch: "unknown_epoch",
  StaleGeneration: "stale_generation",
});

export const LatestDurableFailure = Object.freeze({
  Pending: "pending",
  Superseded: "superseded",
  UnknownEpoch: "unknown_epoch",
  StaleGeneration: "stale_generation",
});

export const LatestDurableReconnect = Object.freeze({
  Advanced: "advanced",
  Unchanged: "unchanged",
  StaleGeneration: "stale_generation",
});

function requireEpoch(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function desired(epoch, value) {
  return Object.freeze({ epoch, value });
}

function envelope(generation, key, revision) {
  return Object.freeze({ generation, key, epoch: revision.epoch, value: revision.value });
}

function entrySnapshot(entry) {
  if (entry === undefined) return null;
  return Object.freeze({
    desired: entry.desired,
    inflight: entry.inflight,
    durableThrough: entry.durableThrough,
  });
}

/**
 * Pure keyed state machine for latest-value durable sinks.
 *
 * Values are treated as immutable. Equality for an idempotent reused epoch is
 * `Object.is`; callers needing structural identity should intern or hash values
 * before submitting them.
 */
export class LatestDurableProjectionCore {
  constructor(generation = 0) {
    this._generation = requireEpoch(generation, "generation");
    this._entries = new Map();
    this._version = 0;
  }

  get generation() {
    return this._generation;
  }

  get version() {
    return this._version;
  }

  _entry(key, create = false) {
    let entry = this._entries.get(key);
    if (entry === undefined && create) {
      entry = { desired: null, inflight: null, durableThrough: null };
      this._entries.set(key, entry);
    }
    return entry;
  }

  _changed() {
    this._version += 1;
  }

  entry(key) {
    return entrySnapshot(this._entry(key));
  }

  snapshot() {
    return Object.freeze({
      generation: this._generation,
      entries: Object.freeze(
        [...this._entries].map(([key, entry]) => Object.freeze({ key, ...entrySnapshot(entry) })),
      ),
    });
  }

  upsertDesired(key, epoch, value) {
    requireEpoch(epoch, "epoch");
    const entry = this._entry(key, true);
    if (entry.durableThrough !== null && epoch <= entry.durableThrough) {
      return Object.freeze({ kind: LatestDurableUpsert.AlreadyDurable });
    }

    const retained = [entry.desired, entry.inflight].filter((revision) => revision !== null);
    const newestEpoch = retained.reduce(
      (maximum, revision) => Math.max(maximum, revision.epoch),
      -1,
    );
    if (epoch < newestEpoch) {
      return Object.freeze({ kind: LatestDurableUpsert.StaleEpoch });
    }
    if (epoch === newestEpoch) {
      const current = retained.find((revision) => revision.epoch === epoch);
      return Object.freeze({
        kind: Object.is(current.value, value)
          ? LatestDurableUpsert.Unchanged
          : LatestDurableUpsert.EpochConflict,
      });
    }

    entry.desired = desired(epoch, value);
    this._changed();
    return Object.freeze({ kind: LatestDurableUpsert.Accepted });
  }

  claim(key, generation) {
    requireEpoch(generation, "generation");
    if (generation !== this._generation) {
      return Object.freeze({
        kind: LatestDurableClaim.StaleGeneration,
        current: this._generation,
      });
    }
    const entry = this._entry(key);
    if (entry === undefined || entry.desired === null) {
      if (entry?.inflight !== null && entry?.inflight !== undefined) {
        return Object.freeze({ kind: LatestDurableClaim.Busy });
      }
      return Object.freeze({ kind: LatestDurableClaim.Empty });
    }
    if (entry.inflight !== null) {
      return Object.freeze({ kind: LatestDurableClaim.Busy });
    }

    entry.inflight = envelope(this._generation, key, entry.desired);
    entry.desired = null;
    this._changed();
    return Object.freeze({ kind: LatestDurableClaim.Claimed, envelope: entry.inflight });
  }

  ackApplied(key, generation, epoch) {
    requireEpoch(generation, "generation");
    requireEpoch(epoch, "epoch");
    if (generation !== this._generation) {
      return Object.freeze({
        kind: LatestDurableAck.StaleGeneration,
        current: this._generation,
      });
    }
    const entry = this._entry(key);
    if (entry === undefined || entry.inflight === null || entry.inflight.epoch !== epoch) {
      if (
        entry?.durableThrough !== null &&
        entry?.durableThrough !== undefined &&
        epoch <= entry.durableThrough
      ) {
        return Object.freeze({
          kind: LatestDurableAck.Unchanged,
          durableThrough: entry.durableThrough,
        });
      }
      return Object.freeze({ kind: LatestDurableAck.UnknownEpoch });
    }

    entry.inflight = null;
    if (entry.durableThrough === null || epoch > entry.durableThrough) {
      entry.durableThrough = epoch;
      this._changed();
      return Object.freeze({ kind: LatestDurableAck.Advanced, durableThrough: epoch });
    }
    this._changed();
    return Object.freeze({
      kind: LatestDurableAck.Unchanged,
      durableThrough: entry.durableThrough,
    });
  }

  failRetryable(key, generation, epoch) {
    requireEpoch(generation, "generation");
    requireEpoch(epoch, "epoch");
    if (generation !== this._generation) {
      return Object.freeze({
        kind: LatestDurableFailure.StaleGeneration,
        current: this._generation,
      });
    }
    const entry = this._entry(key);
    if (entry === undefined || entry.inflight === null || entry.inflight.epoch !== epoch) {
      return Object.freeze({ kind: LatestDurableFailure.UnknownEpoch });
    }

    const failed = entry.inflight;
    entry.inflight = null;
    if (entry.desired !== null && entry.desired.epoch > failed.epoch) {
      this._changed();
      return Object.freeze({ kind: LatestDurableFailure.Superseded });
    }
    entry.desired = desired(failed.epoch, failed.value);
    this._changed();
    return Object.freeze({ kind: LatestDurableFailure.Pending });
  }

  reconnect(newGeneration) {
    requireEpoch(newGeneration, "generation");
    if (newGeneration < this._generation) {
      return Object.freeze({
        kind: LatestDurableReconnect.StaleGeneration,
        current: this._generation,
      });
    }
    if (newGeneration === this._generation) {
      return Object.freeze({
        kind: LatestDurableReconnect.Unchanged,
        generation: this._generation,
      });
    }

    let requeued = 0;
    let superseded = 0;
    for (const entry of this._entries.values()) {
      const inflight = entry.inflight;
      if (inflight === null) continue;
      if (entry.desired !== null && entry.desired.epoch > inflight.epoch) {
        superseded += 1;
      } else {
        entry.desired = desired(inflight.epoch, inflight.value);
        requeued += 1;
      }
      entry.inflight = null;
    }
    this._generation = newGeneration;
    this._changed();
    return Object.freeze({
      kind: LatestDurableReconnect.Advanced,
      generation: newGeneration,
      requeued,
      superseded,
    });
  }
}
