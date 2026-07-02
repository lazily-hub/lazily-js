# lazily-js

Native JavaScript port of the **lazily** reactive core — a first-class reactive
binding alongside [`lazily-rs`][rs], [`lazily-py`][py], [`lazily-zig`][zig], and
[`lazily-kt`][kt]. Ships a full reactive graph (Cell / Slot / Signal / Effect),
the [`lazily-spec`][spec] IPC wire types, keyed cell collections + LIS
reconciliation, the memoized semantic tree, the move-aware sequence CRDT, the
Fugue/RGA text CRDT, manufactured text identity, a flat state machine, a
full-Harel state-chart interpreter, capability negotiation, and an FFI
state-projection consumer.

> **Reactive core.** Unlike earlier `@lazily-hub/js` releases (which were a
> state-projection *consumer* with no reactive graph), `lazily-js` is a full
> reactive binding. `@lazily-hub/js` is deprecated; migrate to `lazily-js`.

Pure ES modules, zero runtime dependencies for the reactive, IPC, collections,
CRDT, and state-chart modules (`koffi` is loaded lazily, only when the FFI
projection transport is used).

## Packages

lazily-js ships these entry points:

| Import | What it is |
|--------|-----------|
| `lazily-js` | [`lazily-spec`][spec] IPC wire types — `Snapshot`, `Delta`, `DeltaOp`, `IpcMessage` (incl. `CrdtSync`), `NodeState`, `IpcValue`, `PeerPermissions`, capability negotiation (`SessionHandshake`, `BINDING_CAPABILITIES`) |
| `lazily-js/reactive` | Reactive dependency graph — `Context`, `Cell`/`Slot`/`Signal`/`Effect` |
| `lazily-js/state-machine` | Flat finite-state-machine kernel (Cell-backed) |
| `lazily-js/statechart` | Full Harel/SCXML state-chart interpreter |
| `lazily-js/collections` | `CellMap` + `CellTree` keyed collections and LIS keyed reconciliation |
| `lazily-js/sem-tree` | Memoized semantic tree (incremental ancestor-chain fold) |
| `lazily-js/seq-crdt` | Move-aware sequence CRDT (fractional-index + LWW) |
| `lazily-js/text-crdt` | Fugue/RGA character CRDT |
| `lazily-js/stable-id` | Manufactured text identity (anchors / content hashes / similarity) |
| `lazily-js/state-projection` | koffi FFI consumer of the agent-doc `DocumentStateProjection` |

## Reactive graph

`Context` mirrors lazily-rs `Context` semantics (single-threaded). The reactive
family is **Slot** (lazy memoized derived) → **Cell** (mutable source) →
**Signal** (eager derived), plus **Effect** (side-effecting observer). Pull-based
and glitch-free; a `==` (PartialEq) guard suppresses no-op updates; `batch`
coalesces invalidations; cycles throw.

```js
import { Context } from "lazily-js/reactive";

const ctx = new Context();
const a = ctx.cell(2);
const b = ctx.cell(3);

const sum = ctx.slot(() => ctx.getCell(a) + ctx.getCell(b)); // lazy
ctx.get(sum); // 5

ctx.setCell(a, 10);
ctx.get(sum); // 13

const parity = ctx.signal(() => (ctx.getCell(a) % 2 === 0 ? "even" : "odd")); // eager
ctx.setCell(a, 11);
ctx.getSignal(parity); // "odd" — already materialized
```

## State machine + state charts

`StateMachine` is a Cell-backed reactive FSM — the kernel a single-region chart
compiles down to. `StateChart` is the full Harel/SCXML interpreter (compound
states, orthogonal regions, shallow + deep history, entry/exit/transition
actions, named guards). Both compose with the reactive graph.

```js
import { Context } from "lazily-js/reactive";
import { StateMachine } from "lazily-js/state-machine";

const ctx = new Context();
const m = new StateMachine(ctx, "Red", (s, e) =>
  e === "advance" ? { Red: "Green", Green: "Yellow", Yellow: "Red" }[s] : null,
);
m.send("advance"); // true
m.state;           // "Green"
```

## Keyed collections + semantic tree

`CellMap` / `CellTree` implement the keyed cell collections layer (value /
membership / order reactivity independence, stable handles, atomic move).
`reconcileCollections` emits the LIS move-minimized `{insert, remove, move,
update}` op set. `SemTree` layers memoized derived values over a tree: one memo
slot per node folding `(node value, child derived values)`; editing one node
recomputes only its ancestor chain, and a node edit that doesn't change the
folded result is suppressed by the memo guard.

```js
import { CellMap, CellTree, reconcileCollections } from "lazily-js/collections";
import { Context } from "lazily-js/reactive";
import { SemTree } from "lazily-js/sem-tree";

const ctx = new Context();
const tree = new SemTree(ctx, rootSpec, (v, kids) => v + kids.reduce((a, b) => a + b, 0));
tree.value();          // folded root
tree.setValue("leaf", 99); // recomputes only the ancestor chain
```

## CRDTs

`SeqCrdt` is the move-aware sequence CRDT: each element is three independent LWW
registers (value, position, deleted); a move is a single LWW reassignment (not
delete + reinsert), so concurrent moves converge without duplication.
`TextCrdt` is the Fugue/RGA character CRDT: concurrent same-point inserts keep
both, deletes are sticky tombstones, and merge is commutative / associative /
idempotent. Both GC tombstones under a caller-supplied causal-stability
watermark.

```js
import { SeqCrdt } from "lazily-js/seq-crdt";
import { TextCrdt } from "lazily-js/text-crdt";

const seq = new SeqCrdt(1);
seq.insertBack("a", 0, 1);
seq.moveAfter("a", "b", 10); // single LWW reassignment

const text = TextCrdt.fromStr(1, "hi");
const peer = text.fork(2);
peer.insert(2, "!");
text.merge(peer); // converges
```

## IPC wire types + capability negotiation

Every wire value round-trips the canonical externally-tagged JSON shape via
`toWire()` / `fromWire()`; `IpcMessage` adds `encodeJson()` / `decodeJson()`.
`CrdtSync` carries the multi-writer CRDT anti-entropy plane. `PeerPermissions`
is the per-peer capability ACL. `SessionHandshake` is the fail-closed
compatibility handshake; `BINDING_CAPABILITIES` advertises this binding's
conformance (shipped surfaces + the `ffi = none` carve-out for browser/Worker JS).

## Conformance

lazily-js conforms to the [`lazily-spec`][spec] Binding Conformance Matrix.
Every `MUST` layer is shipped; the only advertised omission is the C-ABI FFI
carve-out (`ffi = none` — browser/Worker JS has no shared in-process address
space; the full state plane, incl. `CrdtSync`, is still exposed over
IPC/WebSocket/WebRTC). Async is optional (async.md: a binding MAY omit it).

lazily-js replays every shared conformance fixture — IPC, agent-doc state,
keyed collections (`CellMap` / `CellTree` / LIS reconciliation), the semantic
tree, the sequence + text CRDTs, manufactured text identity, and the Harel
state charts — and validates its generated wire against the canonical JSON
Schemas.

## Development

```bash
make check   # == npm run build && npm test
```

- `npm run build` — `node --check` syntax validation of all modules.
- `npm test` — `node --test test/*.test.js`.

## See also

- [`lazily-spec`][spec] — language-agnostic wire protocol + conformance fixtures.
- [`lazily-formal`][formal] — Lean 4 formal model (shared primitives, flat FSM,
  full Harel `StateChart`).
- [`lazily-rs`][rs] / [`lazily-py`][py] / [`lazily-zig`][zig] / [`lazily-kt`][kt]
  — sibling reactive cores.

[rs]: https://github.com/lazily-hub/lazily-rs
[py]: https://github.com/lazily-hub/lazily-py
[zig]: https://github.com/lazily-hub/lazily-zig
[kt]: https://github.com/lazily-hub/lazily-kt
[spec]: https://github.com/lazily-hub/lazily-spec
[formal]: https://github.com/lazily-hub/lazily-formal
