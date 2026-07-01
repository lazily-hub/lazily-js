# @lazily-hub/js

JavaScript helpers for the **lazily** reactive-signals family: the
[`lazily-spec`][spec] IPC wire types, a full-Harel state-chart interpreter, and
an FFI state-projection consumer for the agent-doc binary.

> **Not a reactive-core port.** lazily-js is a state-projection **consumer** with
> no reactive graph of its own — the same role [`lazily-kt`][kt] plays on the
> JVM. The reactive cores live in [`lazily-rs`][rs], [`lazily-py`][py], and
> [`lazily-zig`][zig]; when a chart's state must be authoritative or shared, it
> runs in lazily-rs and lazily-js observes it via the snapshot/delta projection.
> A state chart or any other compute runs natively here as pure logic — never
> over FFI (routing it to a Rust `Context` would be circular).

Pure ES modules, zero runtime dependencies for the IPC and state-chart modules
(`koffi` is loaded lazily, only when the FFI projection transport is used).

## Packages

lazily-js ships three entry points:

| Import | What it is |
|--------|-----------|
| `@lazily-hub/js` | [`lazily-spec`][spec] IPC wire types — `Snapshot`, `Delta`, `DeltaOp`, `IpcMessage`, `NodeState`, `IpcValue`, `PeerPermissions` |
| `@lazily-hub/js/statechart` | Full Harel/SCXML state-chart interpreter (compute, not protocol) |
| `@lazily-hub/js/state-projection` | koffi FFI consumer of the agent-doc `DocumentStateProjection` |

## IPC wire types

Every wire value is a frozen, immutable object that round-trips the canonical
externally-tagged JSON shape via `toWire()` / `fromWire()`. `IpcMessage` adds
`encodeJson()` / `decodeJson()` for direct transport.

```js
import {
  Snapshot,
  NodeSnapshot,
  Delta,
  DeltaOp,
  IpcMessage,
} from "@lazily-hub/js";

const snapshot = new Snapshot({
  epoch: 1,
  nodes: [NodeSnapshot.payload(0, "cell", new Uint8Array([1, 2, 3]))],
});

const msg = IpcMessage.snapshot(snapshot);
const bytes = msg.encodeJson();        // Uint8Array of externally-tagged JSON
const back = IpcMessage.decodeJson(bytes); // round-trips losslessly
```

Deltas are sequential by epoch; a non-contiguous `base_epoch` is the resync
signal:

```js
const delta = Delta.next(1, [DeltaOp.cellSet(0, new Uint8Array([9]))]);
delta.isNextAfter(1);   // true
delta.applyStatus(1);   // { kind: "apply" }
delta.applyStatus(0);   // { kind: "resync_required", lastEpoch: 0, baseEpoch: 1, epoch: 2 }
```

`PeerPermissions` is the per-peer capability ACL (`read` / `write` /
`trigger_effect` over node ids); `Snapshot` and `Delta` expose
`filterReadable(permissions, peer)` so a producer never leaks a node a peer may
not read:

```js
import { PeerPermissions, RemoteOp } from "@lazily-hub/js";

const perms = new PeerPermissions();
perms.allow(7, RemoteOp.read(0));
perms.canRead(7, 0); // true
perms.canRead(7, 1); // false
```

`DeltaOp` covers all seven variants — `CellSet`, `SlotValue`, `Invalidate`,
`NodeAdd`, `NodeRemove`, `EdgeAdd`, `EdgeRemove`. `NodeState` is
`Payload` / `SharedBlob` / `Opaque`; `IpcValue` is `Inline` / `SharedBlob`, with
`ShmBlobRef` carrying the shared-memory blob descriptor (`offset`, `len`,
`generation`, `epoch`, `checksum`).

## State chart

`statechart.js` is the native JavaScript counterpart of
[`lazily-formal`][formal]'s `LazilyFormal.StateChart` and `lazily-rs`'s
`src/statechart.rs`. Because lazily-js has no reactive graph, the active
configuration is a plain `Set` (not a `Cell`) — the transition is pure logic
with zero system dependencies, exactly as the spec requires for lazily-js /
lazily-kt.

Implemented subset (per the spec's implementation-status note): compound states,
orthogonal (parallel) regions, shallow + deep history (record-on-exit /
restore-on-enter), entry/exit/transition actions (exit innermost-first →
transition → entry outermost-first), named guards (fail-closed), and external +
internal transitions. `run` actions, `{"expr": …}` context guards, and
`final`/completion (`done`) are rejected explicitly.

```js
import { ChartDef, StateChart } from "@lazily-hub/js/statechart";

const def = ChartDef.fromChart(chartJson);
const chart = new StateChart(def);

chart.activeLeaves();          // initial leaves, sorted
chart.send("TICK", {});        // true if any transition was taken
chart.matches("playing");      // hierarchical "state-in" predicate
chart.configuration();         // full active configuration (leaves + ancestors)
chart.lastActions();           // exit → transition → entry actions from the last send
```

`send` is deterministic by construction — a total function of
`(chart, configuration, history, event, guards)`, mirroring the Lean
`StateChart.send`. Named guards resolve via the `guards` map passed to `send`
(absent / unknown name → fail-closed `false`).

## State-projection consumer (FFI)

`state-projection.js` wraps the agent-doc binary's C-ABI state-projection
surface via [`koffi`][koffi]. `koffi` is resolved lazily — importing the module
does not load the native library; only `loadAgentDocFFI()` does.

```js
import {
  loadAgentDocFFI,
  StateProjectionClient,
  documentHash,
  buildStateEvent,
  projectionSummary,
} from "@lazily-hub/js/state-projection";

const ffi = loadAgentDocFFI("/path/to/libagent_doc.so");
const doc = documentHash("plan.md");
const client = new StateProjectionClient(doc, ffi);

client.on("projection", (json) => {
  console.log(projectionSummary(json));
});

client.refresh();              // pull the latest DocumentStateProjection
client.recordStateEvent(JSON.stringify(buildStateEvent(doc, "editor.save", {}, "1")));
```

`StateProjectionClient` is an `EventEmitter` that emits `"projection"` on each
`refresh()`; `projectionSummary` / `compactProjectionSummary` reduce the raw
projection JSON into editor-visible status fields. This is an **optional
transport** — the IPC and state-chart modules work without any native binary.

## Conformance

lazily-js replays the shared [`lazily-spec`][spec] conformance fixtures:

- IPC fixtures in `test/conformance/` round-trip through `IpcMessage.fromWire` /
  `toWire` (`test/ipc.test.js`).
- The state-chart interpreter is validated against the same Harel fixtures every
  binding uses (`test/statechart.test.js`).

## Development

```bash
make check   # == npm run build && npm test
```

- `npm run build` — `node --check` syntax validation of the three modules.
- `npm test` — `node --test test/*.test.js`.

## See also

- [`lazily-spec`][spec] — language-agnostic wire protocol + the conformance
  fixtures (IPC and state-chart) every binding replays.
- [`lazily-formal`][formal] — Lean 4 formal model (shared primitives, flat FSM
  kernel, full Harel `StateChart`); the executable reference behind the
  state-chart fixtures and the deterministic `send` lazily-js inherits.
- [`lazily-kt`][kt] — the JVM analogue of this consumer role.
- [`lazily-rs`][rs] / [`lazily-py`][py] / [`lazily-zig`][zig] — the reactive
  cores.

[koffi]: https://github.com/Koromix/koffi
[rs]: https://github.com/lazily-hub/lazily-rs
[py]: https://github.com/lazily-hub/lazily-py
[zig]: https://github.com/lazily-hub/lazily-zig
[kt]: https://github.com/lazily-hub/lazily-kt
[spec]: https://github.com/lazily-hub/lazily-spec
[formal]: https://github.com/lazily-hub/lazily-formal
