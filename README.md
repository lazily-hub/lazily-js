# lazily-js

Native JavaScript port of the **lazily** reactive family. `@lazily-hub/lazily-js`
is the JavaScript/TypeScript binding alongside [`lazily-rs`][rs],
[`lazily-py`][py], [`lazily-zig`][zig], [`lazily-kt`][kt], and
[`lazily-dart`][dart]. It ships:

- a full reactive graph (`Context`, `Cell`, `Slot`, `Signal`, `Effect`);
- the [`lazily-spec`][spec] IPC wire types (`Snapshot`, `Delta`, `CrdtSync`,
  capability negotiation, and default-deny peer permissions);
- keyed cell collections, move-minimized reconciliation, and a memoized
  semantic tree;
- move-aware sequence CRDT, Fugue/RGA text CRDT, and manufactured text identity;
- a Cell-backed flat state machine plus a full Harel/SCXML state-chart
  interpreter with the typed `ChartBuilder` API;
- a koffi-backed state-projection consumer for agent-doc host projections.

> **Package note.** Earlier `@lazily-hub/js` releases were only a state-projection
> consumer. `@lazily-hub/lazily-js` is the current full reactive binding.

Pure ES modules. The reactive, IPC, collections, CRDT, state-machine, and
state-chart modules have no runtime dependencies; `koffi` is loaded only when
the FFI projection transport is used.

## Feature Set

The full `lazily` capability set and its cross-language coverage (`lazily-rs`,
`lazily-kt`, `lazily-js`). `✅` shipped, `~` partial, `—` not applicable/absent.

| Feature | Rust | Kotlin | JS |
|---------|:----:|:------:|:--:|
| Reactive graph — `Context`, `Slot`, `Cell`, `memo`, `Signal` (eager), `Effect`, `batch` | ✅ | ✅ | ✅ |
| Thread-safe `Context` (`Send + Sync`, lock-backed) | ✅ | ✅ | — |
| Async reactive `Context` | ✅ | ✅ | — |
| Statechart (Harel) + state machine | ✅ | ✅ | ✅ |
| Keyed cell collections + `reconcile` + `SemTree` (keyed tree) | ✅ | ✅ | ✅ |
| Stable-id alignment (manufactured identity) | ✅ | ✅ | ✅ |
| Free-text character CRDT (`TextCrdt`) | ✅ | ✅ | ✅ |
| **`TextCrdt` delta sync — `version_vector` / `delta_since` / `apply_delta` (`#lztextsync`)** | ✅ | ✅ | ✅ |
| Move-aware sequence CRDT (`SeqCrdt`) | ✅ | ✅ | ✅ |
| Registers (LWW / MV), `PnCounter`, `CellCrdt` | ✅ | ✅ | ✅ |
| IPC wire — `Snapshot` + `Delta` + `CrdtSync` + shared-memory blobs | ✅ | ✅ | ~ |
| State projection / mirror | ✅ | ✅ | ✅ |
| FFI boundary | ✅ | ✅ | n/a |
| Distributed plane (WebRTC transport + signaling) | ✅ | — | — |
| Instrumentation / benchmarks | ✅ | — | — |

CRDT convergence and the wire protocol are pinned by the shared conformance fixtures
and JSON Schemas in `lazily-spec` and the Lean models in `lazily-formal`.
## Packages

| Import | What it is |
|--------|------------|
| `@lazily-hub/lazily-js` | `lazily-spec` IPC wire types: `Snapshot`, `Delta`, `DeltaOp`, `IpcMessage` (`Snapshot` / `Delta` / `CrdtSync`), `NodeState`, `IpcValue`, `PeerPermissions`, `SessionHandshake`, `BINDING_CAPABILITIES` |
| `@lazily-hub/lazily-js/reactive` | Reactive dependency graph: `Context`, `Cell`, `Slot`, `Signal`, `Effect` |
| `@lazily-hub/lazily-js/state-machine` | Flat finite-state-machine kernel backed by a reactive `Cell` |
| `@lazily-hub/lazily-js/statechart` | Harel/SCXML chart interpreter plus `ChartBuilder`, `StateBuilder`, `TransitionBuilder` |
| `@lazily-hub/lazily-js/collections` | `CellMap`, `CellTree`, keyed reconciliation, and LIS move minimization |
| `@lazily-hub/lazily-js/sem-tree` | Memoized semantic tree over `CellTree`-shaped data |
| `@lazily-hub/lazily-js/seq-crdt` | Move-aware sequence CRDT using independent LWW value / position / deletion registers |
| `@lazily-hub/lazily-js/text-crdt` | Fugue/RGA character CRDT |
| `@lazily-hub/lazily-js/stable-id` | Manufactured text identity: anchors, content hashes, similarity alignment |
| `@lazily-hub/lazily-js/state-projection` | koffi FFI consumer for agent-doc `DocumentStateProjection` |

## Reactive graph

`Context` mirrors the single-threaded lazily-rs `Context` semantics in native
JavaScript. The family is:

- **Slot** - lazy, memoized derived value;
- **Cell** - mutable source value;
- **Signal** - eager derived value that re-materializes as soon as a dependency
  invalidates;
- **Effect** - side-effecting observer with cleanup.

Dependencies are discovered dynamically while a slot/effect/signal computes.
Invalidation is pull-based and glitch-free; `memo`/`Signal` use equality guards
to suppress downstream work when a recompute produces the same value. `batch`
coalesces invalidations and effect reruns.

```js
import { Context } from "@lazily-hub/lazily-js/reactive";

const ctx = new Context();
const a = ctx.cell(2);
const b = ctx.cell(3);

const sum = ctx.memo(() => ctx.getCell(a) + ctx.getCell(b));
ctx.get(sum); // 5

ctx.setCell(a, 10);
ctx.get(sum); // 13, recomputed lazily on read

const parity = ctx.signal(() => (ctx.getCell(a) % 2 === 0 ? "even" : "odd"));
ctx.setCell(a, 11);
ctx.getSignal(parity); // "odd", already materialized
```

## State machine and state charts

`StateMachine` is the flat finite-state-machine kernel: a pure
`(state, event) -> nextState | null` transition backed by a reactive `Cell`.
Accepted self-transitions to an equal state are suppressed by the Cell equality
guard.

```js
import { Context } from "@lazily-hub/lazily-js/reactive";
import { StateMachine } from "@lazily-hub/lazily-js/state-machine";

const ctx = new Context();
const light = new StateMachine(ctx, "Red", (state, event) =>
  event === "advance" ? { Red: "Green", Green: "Yellow", Yellow: "Red" }[state] : null,
);

light.send("advance"); // true
light.state; // "Green"
```

`StateChart` implements the full Harel/SCXML subset from
[`lazily-spec/docs/state-charts.md`][statecharts]: compound states, parallel
regions, shallow/deep history, entry/exit/transition actions, named guards
(fail-closed), internal/external transitions, and final leaves. Charts are
**compute, not protocol**: the chart itself is not serialized as a special wire
kind; only an application-level active configuration would cross IPC as ordinary
payload state.

The normative definition path is the declarative JSON chart consumed by the
shared conformance fixtures:

```js
import { ChartDef, StateChart } from "@lazily-hub/lazily-js/statechart";

const def = ChartDef.fromChart({
  initial: "root",
  states: {
    root: { parallel: true },
    flow: { parent: "root", initial: "idle" },
    idle: { parent: "flow", on: { go: { target: "done", guard: "ready" } } },
    done: { parent: "flow", kind: "final" },
    net: { parent: "root", initial: "up" },
    up: { parent: "net", on: { drop: "down" } },
    down: { parent: "net", on: { restore: "up" } },
  },
});

const chart = new StateChart(def);
chart.activeLeaves(); // ["idle", "up"]
chart.send("drop"); // true
chart.send("go", { ready: true }); // true
chart.matches("done"); // true
```

For typed JavaScript/TypeScript authoring, `ChartBuilder` builds the same
`ChartDef` through the same validation/assembly path. It is an ergonomic API,
not a second semantics:

```js
import {
  ChartBuilder,
  StateBuilder,
  StateChart,
} from "@lazily-hub/lazily-js/statechart";

const def = new ChartBuilder()
  .state(StateBuilder.parallel("root"))
  .state(StateBuilder.compound("flow", "idle").parent("root"))
  .state(StateBuilder.atomic("idle").parent("flow").onGuarded("go", "done", "ready"))
  .state(StateBuilder.final("done").parent("flow"))
  .state(StateBuilder.compound("net", "up").parent("root"))
  .state(StateBuilder.atomic("up").parent("net").on("drop", "down"))
  .state(StateBuilder.atomic("down").parent("net").on("restore", "up"))
  .build();

const chart = new StateChart(def);
chart.send("go", { ready: false }); // false, guards fail closed
```

## Keyed collections and semantic tree

`CellMap` and `CellTree` implement the lazily-spec keyed collections layer:
value, membership, and order readers invalidate independently; stable handles
survive moves; and an atomic move bumps order without touching values.
`reconcileCollections` emits the LIS-minimized `{ insert, remove, move, update }`
operation set. `SemTree` adds a memoized ancestor-chain fold: editing one leaf
recomputes only that leaf's ancestor path, and equal folded results are
suppressed by the memo guard.

```js
import { CellMap, reconcileCollections } from "@lazily-hub/lazily-js/collections";
import { Context } from "@lazily-hub/lazily-js/reactive";
import { SemTree } from "@lazily-hub/lazily-js/sem-tree";

const map = CellMap.from({ order: ["a", "b"], values: { a: 1, b: 2 } });
map.moveBefore("b", "a"); // order reader invalidates; value readers do not

reconcileCollections(
  { order: ["a", "b"], values: { a: 1, b: 2 } },
  { order: ["b", "a", "c"], values: { a: 1, b: 2, c: 3 } },
).ops; // move-minimized patch

const ctx = new Context();
const rootSpec = {
  id: "root",
  value: 0,
  children: {
    order: ["leaf"],
    values: { leaf: { id: "leaf", value: 1 } },
  },
};
const tree = new SemTree(ctx, rootSpec, (value, children) =>
  value + children.reduce((sum, child) => sum + child, 0),
);

tree.value(); // 1
tree.setValue("leaf", 99); // only the ancestor chain recomputes
```

## CRDTs

`SeqCrdt` is the move-aware sequence CRDT: each element has independent LWW
registers for value, position, and deletion, so a move is one position
assignment rather than delete plus reinsert. `TextCrdt` is a Fugue/RGA
character CRDT: concurrent same-point inserts are preserved, deletes are sticky
tombstones, and merge is commutative / associative / idempotent. Both expose
tombstone GC behind caller-supplied causal-stability watermarks.

```js
import { SeqCrdt } from "@lazily-hub/lazily-js/seq-crdt";
import { TextCrdt } from "@lazily-hub/lazily-js/text-crdt";

const seq = new SeqCrdt(1);
seq.insertBack("a", 0, 1);
seq.moveAfter("a", "b", 10);

const text = TextCrdt.fromStr(1, "hi");
const peer = text.fork(2);
peer.insert(2, "!");
text.merge(peer); // converges
```

## IPC wire types and capability negotiation

Every IPC value round-trips the canonical externally-tagged
[`lazily-spec`][spec] JSON shape through `toWire()` / `fromWire()`.
`IpcMessage` adds `encodeJson()` / `decodeJson()`. `Snapshot` and `Delta`
represent the single-writer graph-state plane; `CrdtSync` carries the
multi-writer CRDT anti-entropy plane. `PeerPermissions` is default-deny and
filters unreadable nodes/ops out of snapshots and deltas. `SessionHandshake`
performs the fail-closed protocol/version/codec/feature check before graph
frames flow.

```js
import {
  Delta,
  DeltaOp,
  IpcMessage,
  NodeSnapshot,
  PeerPermissions,
  RemoteOp,
  Snapshot,
} from "@lazily-hub/lazily-js";

const snapshot = new Snapshot({
  epoch: 7,
  nodes: [NodeSnapshot.payload(1, "counter", new Uint8Array([42]))],
  roots: [1],
});

const wire = IpcMessage.snapshot(snapshot).encodeJson();
IpcMessage.decodeJson(wire).snapshot.epoch; // 7

const delta = Delta.next(7, [DeltaOp.cellSet(1, [43])]);
IpcMessage.delta(delta).toWire();

const permissions = new PeerPermissions();
permissions.allow(10, RemoteOp.read(1));
snapshot.filterReadable(permissions, 10).nodes.length; // 1
snapshot.filterReadable(permissions, 11).nodes.length; // 0
```

`BINDING_CAPABILITIES` advertises the JS binding truthfully: reactive core,
IPC, CRDT, keyed collections, semantic tree, sequence/text CRDT, stable-id,
state machine, state charts, permissions, and capability negotiation are
shipped; C-ABI FFI is `none` because browser/Worker JS cannot host a native
in-process ABI; async context, signaling, and WebRTC transports are not shipped
by this package. The same payload types can still be carried by any transport a
host application owns.

## Conformance

lazily-js replays the shared `lazily-spec` fixtures for IPC, agent-doc state,
keyed collections (`CellMap`, `CellTree`, LIS reconciliation), semantic tree,
sequence and text CRDTs, manufactured text identity, and Harel state charts.
It also validates generated wire values against the canonical JSON Schemas.

`npm test` builds the [`lazily-formal`][formal] Lean 4 model when that sibling
checkout and the `lake` toolchain are present. The script exits successfully
when they are absent, so npm tarball consumers and shallow clones are not forced
to install Lean; full CI verifies the proofs.

Each formal module with a JS counterpart has a matching property test that
names the Lean theorems it mirrors:

| lazily-formal module | JS test file | Mirrored theorems |
|----------------------|--------------|-------------------|
| `StateMachine` | `state-machine.test.js` | `guard_rejection_preserves_state`, `accepted_transition_advances_state`, `send_preserves_transition` |
| `StateChart` | `statechart-properties.test.js` | `enabled_empty_rejects`, `parallel_region_confluence`, `single_region_refines_flat_machine`, `single_region_enabled_at_most_one`, `recordHistory_idempotent`, `send_actions_empty_when_rejected`, `send_preserves_chart`, determinism-by-construction |
| `Reactive` | `reactive-properties.test.js` | `setCell_equal_preserves_graph`, `setCell_different_invalidates_dependents`, `recomputeSlot_equal_preserves_dependents`, `recomputeSlot_different_invalidates_dependents`, `signal_materialized_after_recompute` |
| `Collection` | `collection-properties.test.js` | `setEntryValue_preserves_{membership,order,siblings}`, `moveKey_preserves_{membership,values}`, `moveKey_advances_order`, `addKey_advances_membership_and_order`, `Family.get_idempotent_after_first` |
| `Tree` | `tree-properties.test.js` | `setNodeValue_preserves_{other_nodes,node_signals}`, `moveChild_preserves_{non_parent,parent_value}`, `moveChild_advances_order_signal_only` |
| `Reconciliation` | `reconciliation-properties.test.js` | `lisBy_longest`, `reconcile_move_minimized`, `reconcile_stable_not_invalidated` |

`AsyncSlotState`, `AsyncEffect`, and thread-safe context theorems are not mirrored
because lazily-js does not ship async or thread-safe context surfaces.

## The lazily family

| Binding | Language | Package / role |
|---------|----------|----------------|
| [`lazily-rs`][rs] | Rust | `lazily` on crates.io; single-threaded, thread-safe, and async context layers |
| [`lazily-py`][py] | Python | `lazily` on PyPI; dict-backed context plus IPC/shared-blob host types |
| **`lazily-js`** | JavaScript / TypeScript | `@lazily-hub/lazily-js`; reactive core, spec wire types, state charts, CRDTs |
| [`lazily-zig`][zig] | Zig | Zig library / FFI-oriented embedding surface |
| [`lazily-kt`][kt] | Kotlin/JVM | Kotlin reactive core plus typed state charts |
| [`lazily-dart`][dart] | Dart | Dart binding with statechart conformance |
| [`lazily-spec`][spec] | Specification | wire protocol, JSON Schemas, conformance fixtures |
| [`lazily-formal`][formal] | Lean 4 | executable formal model for the shared primitives, FSM, and state charts |

## Development

```bash
make check   # npm run build && npm test
```

- `npm run build` runs `node --check` over every shipped module.
- `npm run test:formal` builds `lazily-formal` when the sibling checkout and
  `lake` are present.
- `npm test` runs the formal check and the Node test suite.

## See also

- [`lazily-spec`][spec] - language-agnostic wire protocol, schemas, and
  conformance fixtures.
- [`lazily-formal`][formal] - Lean 4 formal model behind the shared behavioral
  guarantees.
- [`lazily-rs`][rs] / [`lazily-py`][py] / [`lazily-zig`][zig] /
  [`lazily-kt`][kt] / [`lazily-dart`][dart] - sibling bindings.

[rs]: https://github.com/lazily-hub/lazily-rs
[py]: https://github.com/lazily-hub/lazily-py
[zig]: https://github.com/lazily-hub/lazily-zig
[kt]: https://github.com/lazily-hub/lazily-kt
[dart]: https://github.com/lazily-hub/lazily-dart
[spec]: https://github.com/lazily-hub/lazily-spec
[formal]: https://github.com/lazily-hub/lazily-formal
[statecharts]: https://github.com/lazily-hub/lazily-spec/blob/main/docs/state-charts.md
