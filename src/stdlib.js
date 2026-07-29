// Portable, caller-driven stdlib primitives. This module is isomorphic: it has
// no Node imports, starts no scheduler, and accepts logical time from callers.

export const MAX_U64 = (1n << 64n) - 1n;

function asU64(value, name) {
  if (typeof value === "bigint") {
    if (value < 0n || value > MAX_U64) {
      throw new TimerError("deadline_overflow");
    }
    return value;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer or bigint`);
  }
  const converted = BigInt(value);
  if (converted > MAX_U64) throw new TimerError("deadline_overflow");
  return converted;
}

function publicClock(value) {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

export class TimerError extends RangeError {
  constructor(reason) {
    super(reason);
    this.name = "TimerError";
    this.reason = reason;
  }
}

export function checkedDeadline(now, duration) {
  const start = asU64(now, "now");
  const span = asU64(duration, "duration");
  if (span > MAX_U64 - start) throw new TimerError("deadline_overflow");
  return publicClock(start + span);
}

export class Timer {
  #deadline;
  #lastNow;
  #firedAt = null;

  constructor(now, duration) {
    this.#lastNow = asU64(now, "now");
    this.#deadline = asU64(checkedDeadline(now, duration), "deadline");
  }

  get deadline() {
    return publicClock(this.#deadline);
  }

  observe(now) {
    const current = asU64(now, "now");
    if (this.#firedAt !== null) {
      return { outcome: "fired", fired_at: publicClock(this.#firedAt) };
    }
    if (current < this.#lastNow) {
      return {
        outcome: "unavailable",
        reason: "clock_regression",
        deadline: this.deadline,
      };
    }
    this.#lastNow = current;
    if (current >= this.#deadline) {
      this.#firedAt = current;
      return { outcome: "fired", fired_at: publicClock(current) };
    }
    return { outcome: "pending", deadline: this.deadline };
  }
}

export const TimeoutOperation = Object.freeze({
  pending: () => Object.freeze({ state: "pending" }),
  completed: (value) => Object.freeze({ state: "completed", value }),
  unavailable: () => Object.freeze({ state: "unavailable" }),
});

export class Timeout {
  #deadline;
  #lastNow;
  #terminal = null;

  constructor(now, duration) {
    this.#lastNow = asU64(now, "now");
    this.#deadline = asU64(checkedDeadline(now, duration), "deadline");
  }

  get deadline() {
    return publicClock(this.#deadline);
  }

  poll(now, operation, cancellation) {
    const ready = this.#prePoll(now);
    if (ready !== null) return ready;
    const op = operation();
    const cancel = cancellation();
    return this.#resolve(op, cancel);
  }

  async pollAsync(now, operation, cancellation) {
    const ready = this.#prePoll(now);
    if (ready !== null) return ready;
    // Invoke both adapters now, exactly once. Their completion order is not
    // allowed to change the contract's operation-before-cancellation precedence.
    const operationResult = operation();
    const cancellationResult = cancellation();
    const [op, cancel] = await Promise.all([operationResult, cancellationResult]);
    if (this.#terminal !== null) return this.#terminal;
    return this.#resolve(op, cancel);
  }

  #prePoll(now) {
    const current = asU64(now, "now");
    if (this.#terminal !== null) return this.#terminal;
    if (current < this.#lastNow) {
      return this.#latch({ outcome: "unavailable", reason: "clock_regression" });
    }
    this.#lastNow = current;
    if (current >= this.#deadline) return this.#latch({ outcome: "timed_out" });
    return null;
  }

  #resolve(operation, cancellation) {
    if (this.#terminal !== null) return this.#terminal;
    if (operation?.state === "completed") {
      return this.#latch({ outcome: "completed", value: operation.value });
    }
    if (operation?.state === "unavailable") {
      return this.#latch({ outcome: "unavailable", reason: "operation_unavailable" });
    }
    if (operation?.state !== "pending") throw new TypeError("unknown operation state");
    if (cancellation === "cancelled") return this.#latch({ outcome: "cancelled" });
    if (cancellation === "unavailable") {
      return this.#latch({ outcome: "unavailable", reason: "cancellation_unavailable" });
    }
    if (cancellation !== "pending") throw new TypeError("unknown cancellation state");
    return { outcome: "pending", deadline: this.deadline };
  }

  #latch(value) {
    this.#terminal = Object.freeze(value);
    return this.#terminal;
  }
}

export class RevisionBarrier {
  #revision;
  #requiredRevision;
  #deadline;
  #generation = 0n;
  #lastNow = null;
  #terminal = null;

  constructor(revision, requiredRevision, deadline = null) {
    this.#revision = asU64(revision, "revision");
    this.#requiredRevision = asU64(requiredRevision, "requiredRevision");
    this.#deadline = deadline === null ? null : asU64(deadline, "deadline");
  }

  observe(now, predicate, cancellation) {
    const ready = this.#preObserve(now, predicate);
    if (ready !== null) return ready;
    return this.#resolveCancellation(cancellation());
  }

  async observeAsync(now, predicate, cancellation) {
    const ready = this.#preObserve(now, predicate);
    if (ready !== null) return ready;
    const state = await cancellation();
    if (this.#terminal !== null) return this.#snapshot();
    return this.#resolveCancellation(state);
  }

  registerRecheck(now, observedRevision, predicate) {
    const observed = asU64(observedRevision, "observedRevision");
    const ready = this.#beginObserve(now);
    if (ready !== null) return ready;
    this.#acceptRevision(observed);
    if (predicate && this.#revision >= this.#requiredRevision) {
      return this.#latch("satisfied");
    }
    return this.#snapshot();
  }

  advance(revision, predicate) {
    const next = asU64(revision, "revision");
    if (this.#terminal !== null) return this.#snapshot();
    this.#acceptRevision(next);
    if (predicate && this.#revision >= this.#requiredRevision) {
      return this.#latch("satisfied");
    }
    return this.#snapshot();
  }

  dispose() {
    return this.#terminal === null ? this.#latch("disposed") : this.#snapshot();
  }

  receipt(_key) {
    return this.#snapshot();
  }

  #preObserve(now, predicate) {
    const ready = this.#beginObserve(now);
    if (ready !== null) return ready;
    if (predicate && this.#revision >= this.#requiredRevision) {
      return this.#latch("satisfied");
    }
    return null;
  }

  #resolveCancellation(state) {
    if (this.#terminal !== null) return this.#snapshot();
    if (state === "cancelled") return this.#latch("cancelled");
    if (state === "unavailable") return this.#latch("unavailable", "cancellation_unavailable");
    if (state !== "pending") throw new TypeError("unknown cancellation state");
    return this.#snapshot();
  }

  #acceptRevision(revision) {
    if (revision > this.#revision) {
      this.#revision = revision;
      this.#generation += 1n;
    }
  }

  #beginObserve(now) {
    const current = asU64(now, "now");
    if (this.#terminal !== null) return this.#snapshot();
    if (this.#lastNow !== null && current < this.#lastNow) {
      return this.#latch("unavailable", "clock_regression");
    }
    this.#lastNow = current;
    if (this.#deadline !== null && current >= this.#deadline) {
      return this.#latch("timed_out");
    }
    return null;
  }

  #latch(outcome, reason = null) {
    this.#terminal = { outcome, reason };
    return this.#snapshot();
  }

  #snapshot() {
    const result = {
      outcome: this.#terminal?.outcome ?? "pending",
      revision: publicClock(this.#revision),
      generation: publicClock(this.#generation),
    };
    if (this.#terminal?.reason) result.reason = this.#terminal.reason;
    return result;
  }
}
