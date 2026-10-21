// Little-endian byte encoding used throughout the alkanes ABI. Every integer on
// the wire is a u128, represented here as a bigint.

export const U128_MAX = (1n << 128n) - 1n;
const HEX_ASCII = new Uint8Array([48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 97, 98, 99, 100, 101, 102]);

export function toHex(bytes: Uint8Array): string {
  // Decode once instead of allocating and concatenating per-nibble strings.
  const out = new Uint8Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    out[i * 2] = HEX_ASCII[bytes[i] >>> 4];
    out[i * 2 + 1] = HEX_ASCII[bytes[i] & 15];
  }
  return new TextDecoder().decode(out);
}

export function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function concat(parts: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function u128ToBytes(value: bigint): Uint8Array {
  if (value < 0n || value > U128_MAX) throw new Error("u128 out of range");
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, value & 0xffff_ffff_ffff_ffffn, true);
  view.setBigUint64(8, value >> 64n, true);
  return out;
}

// Reads up to 16 bytes little-endian; shorter inputs (e.g. an empty storage
// slot) are zero-extended.
export function bytesToU128(bytes: Uint8Array, offset: number = 0): bigint {
  if (Number.isInteger(offset) && offset >= 0 && offset + 16 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 16);
    return view.getBigUint64(0, true) | (view.getBigUint64(8, true) << 64n);
  }
  // Preserve zero-extension for short storage values and existing offset behavior.
  let v = 0n;
  const end = Math.min(offset + 16, bytes.length);
  for (let i = end - 1; i >= offset; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

export function checkedAdd(a: bigint, b: bigint): bigint {
  const r = a + b;
  if (r > U128_MAX) throw new Error("u128 overflow");
  return r;
}

export function checkedSub(a: bigint, b: bigint): bigint {
  if (b > a) throw new Error("u128 underflow");
  return a - b;
}

export class ByteWriter {
  private parts: Uint8Array[] = [];

  u128(value: bigint): ByteWriter {
    this.parts.push(u128ToBytes(value));
    return this;
  }

  u32(value: number): ByteWriter {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, value, true);
    this.parts.push(b);
    return this;
  }

  bytes(value: Uint8Array): ByteWriter {
    this.parts.push(value);
    return this;
  }

  finish(): Uint8Array {
    return concat(this.parts);
  }
}

export class ByteReader {
  private offset = 0;

  constructor(private readonly data: Uint8Array) {}

  remaining(): number {
    return this.data.length - this.offset;
  }

  u128(): bigint {
    if (this.remaining() < 16) throw new Error("unexpected end of input reading u128");
    const v = bytesToU128(this.data, this.offset);
    this.offset += 16;
    return v;
  }

  u32(): number {
    if (this.remaining() < 4) throw new Error("unexpected end of input reading u32");
    const b = this.data;
    const o = this.offset;
    this.offset += 4;
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }

  bytes(length: number): Uint8Array {
    if (this.remaining() < length) throw new Error("unexpected end of input reading bytes");
    const out = this.data.slice(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  rest(): Uint8Array {
    return this.bytes(this.remaining());
  }
}
