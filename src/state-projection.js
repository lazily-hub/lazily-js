import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

/**
 * JS-friendly interface to the lazily / agent-doc state-projection FFI channel.
 *
 * The native loader (`loadAgentDocFFI`) returns an object implementing this
 * interface; tests inject a plain-object mock instead (no native dependency).
 *
 * Mirrors the Kotlin `LazilyFFI` + `StateProjectionClient` pair from lazily-kt
 * (#mes4), but adapts the pointer/free lifecycle into the loader boundary so
 * the consumer never handles raw C pointers.
 *
 * @typedef {object} LazilyFFI
 * @property {(documentHash: string) => (string | null)} stateProjection
 *   Read the binary's `DocumentStateProjection` JSON for a document, or `null`
 *   when no events have been recorded. The loader reads the NUL-terminated C
 *   string and frees the backing pointer before returning.
 * @property {(documentHash: string, factJson: string) => boolean} recordStateEvent
 *   Feed a `StateEvent` JSON object into the binary's state backbone. Returns
 *   `true` if accepted, `false` on parse/ledger failure.
 */

const nativeRequire = createRequire(import.meta.url);

/**
 * Lazily load the `agent_doc` native library and wrap its state-projection C
 * ABI into the {@link LazilyFFI} interface.
 *
 * Uses `createRequire` so `koffi` is resolved **only when this function is
 * called**, not when the module is imported — keeping `make check` (pure-JS
 * tests with injected mocks) free of any native build dependency. koffi ships
 * prebuilt binaries (no native compile step), so — unlike the previous
 * ffi-napi/ref-napi loader — it installs cleanly on Node >= 23 (ffi-napi's
 * `napi_add_finalizer` ABI break made it uninstallable there).
 *
 * @param {string} [libPath] Library name or path (defaults to `agent_doc`,
 *   resolved from the process load path / `LD_LIBRARY_PATH`).
 * @returns {LazilyFFI}
 */
export function loadAgentDocFFI(libPath) {
  const koffi = nativeRequire("koffi");
  const lib = koffi.load(libPath ?? "agent_doc");
  // The projection string is returned as a raw `void *` (NOT `char *`) so koffi
  // hands us the pointer instead of auto-converting to a JS string — we need
  // the pointer both to read the C string and to free its backing allocation.
  const state_projection = lib.func(
    "void *agent_doc_state_projection(const char *document_hash)",
  );
  const record_state_event = lib.func(
    "int agent_doc_record_state_event(const char *document_hash, const char *fact_json)",
  );
  const free_string = lib.func("void agent_doc_free_string(void *ptr)");
  return {
    stateProjection(documentHash) {
      const ptr = state_projection(documentHash);
      if (ptr === null || koffi.address(ptr) === 0n) {
        return null;
      }
      try {
        const json = koffi.decode.string(ptr);
        return json === "null" || json == null ? null : json;
      } finally {
        free_string(ptr);
      }
    },
    recordStateEvent(documentHash, factJson) {
      return record_state_event(documentHash, factJson) === 1;
    },
  };
}

/**
 * Holds the raw JSON projection returned by the binary's
 * `agent_doc_state_projection` FFI, exposed as an `EventEmitter` for reactive
 * UI binding (VSCode status items, webviews), plus {@link recordStateEvent}
 * for feeding facts into the binary's state backbone.
 *
 * `null` means no state events have been recorded for the document. The JSON
 * contains document/queue/closeout/transport/supervisor/route/proof slices —
 * consumers parse it with their preferred JSON library.
 *
 * This is the JS analogue of lazily-kt's `StateProjectionClient` (Kotlin
 * `StateFlow` → JS `EventEmitter`): plugins become thin projection-renderer +
 * event-reporter, NOT a reactive-core port (FFI-first rule).
 *
 * @example
 * import { StateProjectionClient, loadAgentDocFFI } from "@lazily/js/state-projection";
 * const ffi = loadAgentDocFFI();
 * const client = new StateProjectionClient(documentHash, ffi);
 * client.on("projection", (json) => renderStatus(json));
 * client.refresh();                 // pull latest projection, emits "projection"
 * client.recordStateEvent(JSON.stringify({ type: "BaselineSaved" }));
 */
export class StateProjectionClient extends EventEmitter {
  #documentHash;
  #ffi;
  #projection = null;

  /**
   * @param {string} documentHash
   * @param {LazilyFFI} [ffi] Native FFI handle. When omitted the `agent_doc`
   *   library is loaded eagerly via {@link loadAgentDocFFI}. Tests pass a
   *   plain-object mock implementing {@link LazilyFFI}.
   */
  constructor(documentHash, ffi = loadAgentDocFFI()) {
    super();
    this.#documentHash = documentHash;
    this.#ffi = ffi;
  }

  /** The document hash this client is bound to. */
  get documentHash() {
    return this.#documentHash;
  }

  /** Current projection JSON, or `null` when no events have been recorded. */
  get projection() {
    return this.#projection;
  }

  /** `true` once a non-null projection has been observed. */
  get isAvailable() {
    return this.#projection !== null;
  }

  /**
   * Pull the latest state projection from the binary. Updates {@link projection}
   * and emits a `"projection"` event with the new JSON (or `null`). Safe to call
   * on any thread — the FFI is thread-safe.
   *
   * @returns {string | null} The freshly-read projection JSON, or `null`.
   */
  refresh() {
    const json = this.#ffi.stateProjection(this.#documentHash);
    this.#projection = json;
    this.emit("projection", json);
    return json;
  }

  /**
   * Record a state event in the binary's backbone.
   *
   * @param {string} factJson JSON object deserializable as a `StateEvent`
   *   (internally tagged `{ "event_id": "...", "fact": { "type": "..." } }`).
   * @returns {boolean} `true` if accepted, `false` on parse/ledger failure.
   */
  recordStateEvent(factJson) {
    return this.#ffi.recordStateEvent(this.#documentHash, factJson);
  }
}
