// Pre-optimization codecs retained ONLY as the benchmark/test reference.
// Contracts use sdk/bytes.ts. Keep this fixture stable for before/after runs.
export const U128_MAX = (1n << 128n) - 1n;
const HEX = "0123456789abcdef";

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  return s;
}

export function u128ToBytes(value: bigint): Uint8Array {
  if (value < 0n || value > U128_MAX) throw new Error("u128 out of range");
  const out = new Uint8Array(16);
  let v = value;
  for (let i = 0; i < 16; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function bytesToU128(bytes: Uint8Array, offset: number = 0): bigint {
  let v = 0n;
  const end = Math.min(offset + 16, bytes.length);
  for (let i = end - 1; i >= offset; i--) v = (v << 8n) | BigInt(bytes[i]);
  return v;
}

// Preserve the original writer as well, including its u32 DataView allocation.
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

function concat(parts: Uint8Array[]): Uint8Array {
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
