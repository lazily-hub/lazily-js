// Focused Lazily Core entry point. Keep these as re-exports so consumers using
// `./reactive` and `./core` receive the same constructors and handles, never
// parallel type identities. The explicit allow-list is the Core profile boundary:
// Preview-only reactive exports do not silently enter the compatibility promise.
export { Computed, Context, Effect, Source, TeardownScope } from "./reactive.js";
