export type LogicalClock = number | bigint;
export type CancellationState = "pending" | "cancelled" | "unavailable";

export const MAX_U64: bigint;

export class TimerError extends RangeError {
  constructor(reason: "deadline_overflow" | "clock_regression");
  readonly reason: "deadline_overflow" | "clock_regression";
}

export function checkedDeadline(now: LogicalClock, duration: LogicalClock): LogicalClock;

export type TimerObservation =
  | { outcome: "pending"; deadline: LogicalClock }
  | { outcome: "fired"; fired_at: LogicalClock }
  | { outcome: "unavailable"; reason: "clock_regression"; deadline: LogicalClock };

export class Timer {
  constructor(now: LogicalClock, duration: LogicalClock);
  readonly deadline: LogicalClock;
  observe(now: LogicalClock): TimerObservation;
}

export type TimeoutOperationValue<T> =
  | { readonly state: "pending" }
  | { readonly state: "completed"; readonly value: T }
  | { readonly state: "unavailable" };

export const TimeoutOperation: {
  pending<T = never>(): TimeoutOperationValue<T>;
  completed<T>(value: T): TimeoutOperationValue<T>;
  unavailable<T = never>(): TimeoutOperationValue<T>;
};

export type TimeoutObservation<T> =
  | { outcome: "pending"; deadline: LogicalClock }
  | { outcome: "completed"; value: T }
  | { outcome: "timed_out" | "cancelled" }
  | { outcome: "unavailable"; reason: string };

export class Timeout<T> {
  constructor(now: LogicalClock, duration: LogicalClock);
  readonly deadline: LogicalClock;
  poll(
    now: LogicalClock,
    operation: () => TimeoutOperationValue<T>,
    cancellation: () => CancellationState,
  ): TimeoutObservation<T>;
  pollAsync(
    now: LogicalClock,
    operation: () => PromiseLike<TimeoutOperationValue<T>>,
    cancellation: () => PromiseLike<CancellationState>,
  ): Promise<TimeoutObservation<T>>;
}

export type RevisionBarrierObservation = {
  outcome: "pending" | "satisfied" | "timed_out" | "cancelled" | "unavailable" | "disposed";
  revision: LogicalClock;
  generation: LogicalClock;
  reason?: string;
};

export class RevisionBarrier {
  constructor(revision: LogicalClock, requiredRevision: LogicalClock, deadline?: LogicalClock | null);
  observe(
    now: LogicalClock,
    predicate: boolean,
    cancellation: () => CancellationState,
  ): RevisionBarrierObservation;
  observeAsync(
    now: LogicalClock,
    predicate: boolean,
    cancellation: () => PromiseLike<CancellationState>,
  ): Promise<RevisionBarrierObservation>;
  registerRecheck(
    now: LogicalClock,
    observedRevision: LogicalClock,
    predicate: boolean,
  ): RevisionBarrierObservation;
  advance(revision: LogicalClock, predicate: boolean): RevisionBarrierObservation;
  dispose(): RevisionBarrierObservation;
  receipt(key: string): RevisionBarrierObservation;
}
