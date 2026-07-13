// Fugue/RGA-style character CRDT (cell-model.md § Free-text CRDT + re-parse,
// #lztextcrdt). Each character is an element with a unique `OpId` (counter,
// peer) and a left-origin (`origin`); deletes are sticky tombstones carrying
// the delete op's own id. The visible sequence order is a pure, deterministic
// function of the element set: a pre-order DFS of the origin tree where
// siblings of the same origin are visited in DESCENDING `OpId` order
// (most-recent first). Merge is commutative, associative, idempotent;
// concurrent same-point inserts keep both, ordered by the peer tiebreak.

// Element identity = (counter, peer). Total order is (counter, peer) ascending.
export class OpId {
  constructor(counter, peer) {
    this.counter = counter;
    this.peer = peer;
    Object.freeze(this);
  }
  compareTo(other) {
    if (this.counter !== other.counter) {
      return this.counter < other.counter ? -1 : 1;
    }
    if (this.peer !== other.peer) {
      return this.peer < other.peer ? -1 : 1;
    }
    return 0;
  }
  static desc(a, b) {
    return b.compareTo(a); // descending
  }
}

class Elem {
  constructor(ch, origin, deleted = null) {
    this.ch = ch;
    this.origin = origin; // OpId | null (null = document start)
    this.deleted = deleted; // OpId | null (the delete op id, or null = live)
  }
}

export class TextCrdt {
  #elems = new Map(); // OpId-keyed (serialized as "counter:peer")
  #peer;
  #counter = 0;

  constructor(peer) {
    this.#peer = peer;
  }

  static fromStr(peer, str) {
    const crdt = new TextCrdt(peer);
    crdt.insertStr(0, str);
    return crdt;
  }

  // Deep-copy elems, adopt a new peer, COPY the counter (so ids stay unique).
  fork(peer) {
    const copy = new TextCrdt(peer);
    copy.#counter = this.#counter;
    for (const [key, elem] of this.#elems) {
      copy.#elems.set(key, new Elem(elem.ch, elem.origin, elem.deleted));
    }
    return copy;
  }

  clone() {
    return this.fork(this.#peer);
  }

  #nextId() {
    this.#counter += 1; // pre-increment: first id has counter == 1
    return new OpId(this.#counter, this.#peer);
  }

  #key(id) {
    return `${id.counter}:${id.peer}`;
  }

  #orderedIds(includeDeleted) {
    // Group by origin.
    const children = new Map(); // originKey -> OpId[]
    for (const [key, elem] of this.#elems) {
      const originKey = elem.origin ? this.#key(elem.origin) : "<root>";
      let list = children.get(originKey);
      if (!list) {
        list = [];
        children.set(originKey, list);
      }
      // Recover the OpId from the map iteration key is not stored, so store it.
      list.push(this.#idFromKey(key));
    }
    // Sort each sibling list DESCENDING by OpId.
    for (const list of children.values()) {
      list.sort(OpId.desc);
    }
    // Iterative pre-order DFS.
    const out = [];
    const roots = children.get("<root>") ?? [];
    const stack = [...roots].sort(OpId.desc); // highest pops first
    while (stack.length > 0) {
      const id = stack.pop();
      const elem = this.#elems.get(this.#key(id));
      if (!elem) {
        continue;
      }
      if (includeDeleted || elem.deleted === null) {
        out.push(id);
      }
      const kids = children.get(this.#key(id));
      if (kids) {
        // Push reversed so the highest-OpId child pops first.
        for (let i = kids.length - 1; i >= 0; i--) {
          stack.push(kids[i]);
        }
      }
    }
    return out;
  }

  #idFromKey(key) {
    const [counter, peer] = key.split(":");
    return new OpId(Number(counter), Number(peer));
  }

  insert(index, ch) {
    const visible = this.#orderedIds(false);
    const origin = index === 0 ? null : visible[index - 1] ?? null;
    const id = this.#nextId();
    this.#elems.set(this.#key(id), new Elem(ch, origin, null));
  }

  insertStr(index, str) {
    let i = 0;
    for (const ch of String(str)) {
      this.insert(index + i, ch);
      i++;
    }
  }

  delete(index) {
    const visible = this.#orderedIds(false);
    const id = visible[index];
    if (id === undefined) {
      return; // no-op if out of range
    }
    const del = this.#nextId(); // always advance the clock (matches lazily-rs)
    const elem = this.#elems.get(this.#key(id));
    if (elem && elem.deleted === null) {
      elem.deleted = del;
    }
  }

  text() {
    let out = "";
    for (const id of this.#orderedIds(false)) {
      out += this.#elems.get(this.#key(id)).ch;
    }
    return out;
  }

  // Count of live (non-tombstoned) elems over the whole map.
  len() {
    let count = 0;
    for (const elem of this.#elems.values()) {
      if (elem.deleted === null) {
        count++;
      }
    }
    return count;
  }

  is_empty() {
    return this.len() === 0;
  }

  tombstoneCount() {
    let count = 0;
    for (const elem of this.#elems.values()) {
      if (elem.deleted !== null) {
        count++;
      }
    }
    return count;
  }

  clock() {
    return new OpId(this.#counter, this.#peer);
  }

  // State-based merge (whole-replica input). Commutative, associative,
  // idempotent. Tombstones are sticky: any Some wins; concurrent deletes take
  // the smaller delete id. Returns whether visible text changed.
  merge(other) {
    const before = this.text();
    for (const [key, oe] of other.#elems) {
      const id = other.#idFromKey(key);
      this.#counter = Math.max(this.#counter, id.counter);
      if (oe.deleted) {
        this.#counter = Math.max(this.#counter, oe.deleted.counter);
      }
      const existing = this.#elems.get(key);
      if (existing) {
        if (existing.deleted && oe.deleted) {
          existing.deleted =
            existing.deleted.compareTo(oe.deleted) <= 0
              ? existing.deleted
              : oe.deleted;
        } else if (oe.deleted) {
          existing.deleted = oe.deleted;
        }
      } else {
        this.#elems.set(key, new Elem(oe.ch, oe.origin, oe.deleted));
      }
    }
    return this.text() !== before;
  }

  // CrdtTree materialized-value surface.
  value() {
    return this.text();
  }

  // CrdtTree state-join surface.
  mergeFrom(other) {
    return this.merge(other);
  }

  // Tombstone GC: collect a stable deleted element only when nothing references
  // it as a left origin. Bottom-up: pass 1 collects unreferenced leaf
  // tombstones, removing a leaf un-references its origin, so further passes
  // collect interior tombstones until fixpoint. `isStable` is invoked on the
  // DELETE op id (caller-supplied causal-stability policy).
  gcWith(isStable) {
    let removed = 0;
    while (true) {
      const referenced = new Set();
      for (const elem of this.#elems.values()) {
        if (elem.origin) {
          referenced.add(this.#key(elem.origin));
        }
      }
      const collectable = [];
      for (const [key, elem] of this.#elems) {
        if (elem.deleted !== null && isStable(elem.deleted) && !referenced.has(key)) {
          collectable.push(key);
        }
      }
      if (collectable.length === 0) {
        break;
      }
      for (const key of collectable) {
        this.#elems.delete(key);
        removed++;
      }
    }
    return removed;
  }

  // --- Delta sync (#lztextsync) ---

  // Version vector: {peer -> greatest counter seen} over inserts + deletes. The
  // compact frontier a replica sends so a partner can compute the ops it lacks.
  versionVector() {
    const vv = {};
    const bump = (id) => {
      vv[id.peer] = Math.max(vv[id.peer] ?? 0, id.counter);
    };
    for (const [key, elem] of this.#elems) {
      bump(this.#idFromKey(key));
      if (elem.deleted) {
        bump(elem.deleted);
      }
    }
    return vv;
  }

  // The ops `theirVv` has not observed — new inserts + newly-observed tombstones.
  // Each TextOp is a plain {id, ch, origin, deleted} of {counter, peer} ids. A
  // whole-state snapshot is `deltaSince({})`.
  deltaSince(theirVv) {
    const seen = (id) => id.counter <= (theirVv[id.peer] ?? 0);
    const wire = (id) => (id ? { counter: id.counter, peer: id.peer } : null);
    const out = [];
    for (const [key, elem] of this.#elems) {
      const id = this.#idFromKey(key);
      const insertNew = !seen(id);
      const deleteNew = elem.deleted !== null && !seen(elem.deleted);
      if (insertNew || deleteNew) {
        out.push({
          id: wire(id),
          ch: elem.ch,
          origin: wire(elem.origin),
          deleted: wire(elem.deleted),
        });
      }
    }
    return out;
  }

  // Apply a delta op list (from `deltaSince`). Commutative, associative,
  // idempotent — the same convergence contract as `merge`, from the transport
  // form. Rebuilding a replica via `applyDelta` preserves OpId identity so later
  // concurrent edits merge without duplication. Returns whether text changed.
  applyDelta(ops) {
    const before = this.text();
    for (const op of ops) {
      const id = new OpId(op.id.counter, op.id.peer);
      const origin = op.origin ? new OpId(op.origin.counter, op.origin.peer) : null;
      const deleted = op.deleted ? new OpId(op.deleted.counter, op.deleted.peer) : null;
      this.#counter = Math.max(this.#counter, id.counter);
      if (deleted) {
        this.#counter = Math.max(this.#counter, deleted.counter);
      }
      const key = this.#key(id);
      const existing = this.#elems.get(key);
      if (existing) {
        if (existing.deleted && deleted) {
          existing.deleted =
            existing.deleted.compareTo(deleted) <= 0 ? existing.deleted : deleted;
        } else if (deleted) {
          existing.deleted = deleted;
        }
      } else {
        this.#elems.set(key, new Elem(op.ch, origin, deleted));
      }
    }
    return this.text() !== before;
  }
}
