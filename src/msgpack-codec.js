// lazily IPC wire codec — `msgpack`, the CROSS-LANGUAGE BINARY DEFAULT
// (`#lzmsgpackseven`).
//
// protocol.md § Frame codecs makes `msgpack` MUST-level for every binding and
// spells out that shipping *a* MessagePack codec is not implementing it: the
// codec token names ONE wire — the externally tagged frame (`{"Snapshot": …}`)
// over named-field maps whose keys are the `json` field names, with the same
// omit-when-absent rule for optional fields. A library that packs the same
// structs positionally, or behind an internally tagged `{"type": 0, …}`
// envelope, round-trips every value correctly and is still unreadable by a peer
// that negotiated `msgpack`.
//
// This module is deliberately a VALUE-TREE codec, not a struct codec, and that
// is the whole design. `IpcMessage.toWire()` already produces the reference
// (`json`) value tree — external tags, `type_tag`/`base_epoch` field names, the
// omitted `NodeSnapshot.key`, the always-written `CrdtOp.key`. Packing THAT
// tree makes the msgpack frame identical to the json frame by construction; a
// second hand-written transcription of the same shape is exactly the drift that
// produced divergent "msgpack" codecs elsewhere in the family.
//
// No dependency. `@msgpack/msgpack` and friends carry their own struct-mapping
// opinions and — decisively — encode a `Uint8Array` as MessagePack `bin`, which
// is NOT this wire: byte payloads are ARRAYS OF INTEGERS, because that is what
// the reference encoder produces (`rmp_serde` serializes `Vec<u8>` through
// serde's default seq impl) and what its decoder accepts. Emitting or accepting
// `bin` in a byte-payload position would put this binding outside the wire it
// claims to speak, so the unpacker rejects it outright.
//
// NOT byte-canonical (§ Frame codecs): a MessagePack map's key order is
// encoder-defined, so conformance is `decode(encode(m)) == m` plus a decode of
// a peer's frame, never a golden byte string. This packer happens to be
// deterministic (it walks own-key insertion order) — allowed, but not a
// property any peer may rely on.

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function fail(what) {
  throw new TypeError(`msgpack codec: ${what}`);
}

// -- packer -------------------------------------------------------------------

class Packer {
  constructor() {
    this.bytes = [];
  }

  byte(value) {
    this.bytes.push(value & 0xff);
  }

  raw(values) {
    for (const value of values) this.bytes.push(value & 0xff);
  }

  be(value, width) {
    for (let shift = (width - 1) * 8; shift >= 0; shift -= 8) {
      // `>>>` tops out at 32 bits, so shift by division for the high half.
      this.byte(Math.floor(value / 2 ** shift));
    }
  }

  nil() {
    this.byte(0xc0);
  }

  boolean(value) {
    this.byte(value ? 0xc3 : 0xc2);
  }

  integer(value) {
    if (!Number.isSafeInteger(value)) {
      fail(`integer ${value} is outside the safe-integer range`);
    }
    if (value >= 0) {
      if (value < 0x80) return this.byte(value); // positive fixint
      if (value <= 0xff) return this.raw([0xcc, value]);
      if (value <= 0xffff) {
        this.byte(0xcd);
        return this.be(value, 2);
      }
      if (value <= 0xffffffff) {
        this.byte(0xce);
        return this.be(value, 4);
      }
      this.byte(0xcf);
      return this.be(value, 8);
    }
    if (value >= -32) return this.byte(0xe0 | (value + 32)); // negative fixint
    if (value >= -0x80) return this.raw([0xd0, value + 0x100]);
    if (value >= -0x8000) {
      this.byte(0xd1);
      return this.be(value + 0x10000, 2);
    }
    if (value >= -0x80000000) {
      this.byte(0xd2);
      return this.be(value + 0x100000000, 4);
    }
    // int64 two's complement, emitted as two 32-bit halves. `value + 2 ** 64`
    // would be the obvious spelling and is wrong: doubles are 2048 apart up
    // there, so the sum silently rounds.
    this.byte(0xd3);
    let low = value % 2 ** 32;
    let high = Math.floor(value / 2 ** 32);
    if (low < 0) low += 2 ** 32;
    if (high < 0) high += 2 ** 32;
    this.be(high, 4);
    return this.be(low, 4);
  }

  str(value) {
    const encoded = textEncoder.encode(value);
    const len = encoded.length;
    if (len < 32) this.byte(0xa0 | len);
    else if (len <= 0xff) this.raw([0xd9, len]);
    else if (len <= 0xffff) {
      this.byte(0xda);
      this.be(len, 2);
    } else {
      this.byte(0xdb);
      this.be(len, 4);
    }
    this.raw(encoded);
  }

  arrayHeader(len) {
    if (len < 16) return this.byte(0x90 | len);
    if (len <= 0xffff) {
      this.byte(0xdc);
      return this.be(len, 2);
    }
    this.byte(0xdd);
    return this.be(len, 4);
  }

  mapHeader(len) {
    if (len < 16) return this.byte(0x80 | len);
    if (len <= 0xffff) {
      this.byte(0xde);
      return this.be(len, 2);
    }
    this.byte(0xdf);
    return this.be(len, 4);
  }

  take() {
    return Uint8Array.from(this.bytes);
  }
}

function packValue(packer, value) {
  if (value === null || value === undefined) return packer.nil();
  if (typeof value === "boolean") return packer.boolean(value);
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      // No `IpcMessage` field is floating point (§ IpcMessage: every field is an
      // integer, string, or byte sequence). Refusing here keeps a future
      // double-valued field from silently acquiring a wire form nothing agreed
      // on, rather than encoding one this packer cannot read back.
      fail("frames carry no floating-point fields");
    }
    return packer.integer(value);
  }
  if (typeof value === "string") return packer.str(value);
  if (value instanceof Uint8Array) {
    // A byte payload is an ARRAY OF INTEGERS on this wire, never `bin`. The
    // reference decoder rejects `bin` in the same position, so the one thing a
    // `Uint8Array` must not become here is the shape a msgpack library would
    // pick for it by default.
    packer.arrayHeader(value.length);
    for (const byte of value) packer.integer(byte);
    return undefined;
  }
  if (Array.isArray(value)) {
    packer.arrayHeader(value.length);
    for (const element of value) packValue(packer, element);
    return undefined;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    packer.mapHeader(entries.length);
    for (const [key, element] of entries) {
      packer.str(key);
      packValue(packer, element);
    }
    return undefined;
  }
  return fail(`unsupported value in frame: ${typeof value}`);
}

// -- unpacker -----------------------------------------------------------------

class Unpacker {
  constructor(bytes) {
    this.view = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    this.offset = 0;
  }

  need(count) {
    if (this.offset + count > this.view.length) fail("truncated frame");
    const start = this.offset;
    this.offset += count;
    return start;
  }

  byte() {
    return this.view[this.need(1)];
  }

  be(width) {
    const start = this.need(width);
    let value = 0;
    for (let i = 0; i < width; i += 1) value = value * 256 + this.view[start + i];
    if (!Number.isSafeInteger(value)) {
      fail(`integer at offset ${start} exceeds the safe-integer range`);
    }
    return value;
  }

  signed(width) {
    const start = this.need(width);
    // Sign-extend the leading byte and accumulate in exact integer arithmetic,
    // so a 64-bit negative never routes through a `2 ** 64` subtraction that
    // doubles cannot represent.
    let value = this.view[start] & 0x80 ? this.view[start] - 256 : this.view[start];
    for (let i = 1; i < width; i += 1) value = value * 256 + this.view[start + i];
    if (!Number.isSafeInteger(value)) {
      fail(`integer at offset ${start} exceeds the safe-integer range`);
    }
    return value;
  }

  str(len) {
    const start = this.need(len);
    return textDecoder.decode(this.view.subarray(start, start + len));
  }

  array(len) {
    const out = [];
    for (let i = 0; i < len; i += 1) out.push(unpackValue(this));
    return out;
  }

  map(len) {
    const out = {};
    for (let i = 0; i < len; i += 1) {
      const key = unpackValue(this);
      if (typeof key !== "string") fail("named-field maps require string keys");
      out[key] = unpackValue(this);
    }
    return out;
  }

  get eof() {
    return this.offset === this.view.length;
  }
}

function unpackValue(unpacker) {
  const tag = unpacker.byte();
  if (tag <= 0x7f) return tag; // positive fixint
  if (tag >= 0xe0) return tag - 0x100; // negative fixint
  if (tag >= 0x80 && tag <= 0x8f) return unpacker.map(tag & 0x0f);
  if (tag >= 0x90 && tag <= 0x9f) return unpacker.array(tag & 0x0f);
  if (tag >= 0xa0 && tag <= 0xbf) return unpacker.str(tag & 0x1f);
  switch (tag) {
    case 0xc0:
      return null;
    case 0xc2:
      return false;
    case 0xc3:
      return true;
    case 0xc4:
    case 0xc5:
    case 0xc6:
      // A byte payload arrives as an array of integers on this wire. The
      // reference decoder rejects `bin` in the same position, so accepting it
      // here would make this binding read frames no conforming peer can
      // produce and no conforming peer can read — a private extension wearing
      // the `msgpack` token.
      return fail("byte payloads are arrays of integers on this wire, not msgpack `bin`");
    case 0xca:
    case 0xcb:
      return fail("frames carry no floating-point fields");
    case 0xcc:
      return unpacker.be(1);
    case 0xcd:
      return unpacker.be(2);
    case 0xce:
      return unpacker.be(4);
    case 0xcf:
      return unpacker.be(8);
    case 0xd0:
      return unpacker.signed(1);
    case 0xd1:
      return unpacker.signed(2);
    case 0xd2:
      return unpacker.signed(4);
    case 0xd3:
      return unpacker.signed(8);
    case 0xd9:
      return unpacker.str(unpacker.be(1));
    case 0xda:
      return unpacker.str(unpacker.be(2));
    case 0xdb:
      return unpacker.str(unpacker.be(4));
    case 0xdc:
      return unpacker.array(unpacker.be(2));
    case 0xdd:
      return unpacker.array(unpacker.be(4));
    case 0xde:
      return unpacker.map(unpacker.be(2));
    case 0xdf:
      return unpacker.map(unpacker.be(4));
    default:
      return fail(`unsupported MessagePack value in frame (tag 0x${tag.toString(16)})`);
  }
}

// -- public API ---------------------------------------------------------------

/**
 * Pack a reference (`json`) value tree as a MessagePack frame.
 *
 * Objects become named-field maps, arrays become arrays, and a `Uint8Array`
 * becomes an array of integers — never `bin`.
 */
export function encodeMsgpackValue(value) {
  const packer = new Packer();
  packValue(packer, value);
  return packer.take();
}

/**
 * Schema-less view of a frame's bytes.
 *
 * The named-field rule is a property of the ENCODING, so it is invisible to any
 * assertion over a decoded `IpcMessage`: a positional encoder round-trips every
 * value correctly and is still non-conforming. Conformance runners introspect
 * through this.
 */
export function decodeMsgpackValue(bytes) {
  const unpacker = new Unpacker(bytes);
  const value = unpackValue(unpacker);
  if (!unpacker.eof) fail("trailing bytes after frame");
  return value;
}
