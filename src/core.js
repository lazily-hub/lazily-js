// Focused Lazily Core entry point. Keep this module as re-exports so consumers
// using `./reactive` and `./core` receive the same constructors and handles,
// never parallel type identities.
export * from "./reactive.js";
