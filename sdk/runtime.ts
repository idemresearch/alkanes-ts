// Contract-side runtime: storage cache, chain queries, and extcalls. Mirrors
// the AlkaneResponder trait in alkanes-runtime.

import {
  ByteReader,
  ByteWriter,
  bytesToU128,
  concat,
  fromUtf8,
  toHex,
  u128ToBytes,
  utf8,
} from "./bytes.ts";
import {
  EXTCALL_CALL,
  EXTCALL_DELEGATECALL,
  EXTCALL_STATICCALL,
  hostBalance,
  hostBlock,
  hostExtcall,
  hostFuel,
  hostHeight,
  hostLoadStorage,
  hostLog,
  hostSequence,
  hostTransaction,
} from "./host.ts";
import {
  AlkaneId,
  AlkaneTransferParcel,
  CallResponse,
  Cellpack,
  isRevertData,
  revertMessage,
} from "./types.ts";
import { assertWritable, setReadOnly } from "./effects.ts";

class StorageEntry {
  constructor(
    public readonly key: Uint8Array,
    public value: Uint8Array,
  ) {}
}

// Writes are buffered here and returned to the host in the response; the host
// commits them only if the call succeeds. Reads see buffered writes first.
let cache = new Map<string, StorageEntry>();

export function resetStorage(): void {
  setReadOnly(false);
  cache = new Map<string, StorageEntry>();
}

export function serializeStorage(): Uint8Array {
  const w = new ByteWriter().u32(cache.size);
  for (const entry of cache.values()) {
    w.u32(entry.key.length).bytes(entry.key);
    w.u32(entry.value.length).bytes(entry.value);
  }
  return w.finish();
}

export function load(key: Uint8Array): Uint8Array {
  const entry = cache.get(toHex(key));
  if (entry !== undefined) return entry.value;
  return hostLoadStorage(key);
}

export function store(key: Uint8Array, value: Uint8Array): void {
  assertWritable();
  cache.set(toHex(key), new StorageEntry(key, value));
}

// Path-style storage keys, like alkanes-runtime's StoragePointer:
// new StoragePointer("/balances/").select(id.serialize()).getU128()
export class StoragePointer {
  readonly key: Uint8Array;

  constructor(key: string | Uint8Array) {
    this.key = typeof key === "string" ? utf8(key) : key;
  }

  keyword(word: string): StoragePointer {
    return new StoragePointer(concat([this.key, utf8(word)]));
  }

  select(suffix: Uint8Array): StoragePointer {
    return new StoragePointer(concat([this.key, suffix]));
  }

  get(): Uint8Array {
    return load(this.key);
  }

  set(value: Uint8Array): void {
    store(this.key, value);
  }

  getU128(): bigint {
    return bytesToU128(this.get());
  }

  setU128(value: bigint): void {
    this.set(u128ToBytes(value));
  }

  getString(): string {
    return fromUtf8(this.get());
  }

  setString(value: string): void {
    this.set(utf8(value));
  }

  isEmpty(): boolean {
    return this.get().length === 0;
  }
}

export function log(message: string): void {
  hostLog(utf8(message));
}

export function balance(who: AlkaneId, what: AlkaneId): bigint {
  return bytesToU128(hostBalance(who.serialize(), what.serialize()));
}

export function height(): bigint {
  return bytesToU128(hostHeight());
}

export function sequence(): bigint {
  return bytesToU128(hostSequence());
}

export function fuel(): bigint {
  return bytesToU128(hostFuel());
}

// Consensus-encoded bitcoin transaction / block.
export function transaction(): Uint8Array {
  return hostTransaction();
}

export function block(): Uint8Array {
  return hostBlock();
}

// Block 800000000 holds the host's precompiled contracts. The host answers
// them directly, without a checkpoint, storage piping or asset movement
// (alkanes-rs vm/host_functions.rs _handle_special_extcall).
export const PRECOMPILE_BLOCK = 800000000n;

function extcall(kind: number, cellpack: Cellpack, alkanes: AlkaneTransferParcel, fuelLimit: number): CallResponse {
  const result = hostExtcall(kind, cellpack.serialize(), alkanes.serialize(), serializeStorage(), fuelLimit);
  if (result.returndata.length < 16) {
    throw new Error("Extcall returned " + result.returndata.length.toString() + " bytes, expected a CallResponse");
  }
  const response = CallResponse.parse(result.returndata);
  if (result.status < 0) {
    if (isRevertData(response.data) && response.data.length > 4) {
      throw new Error("Extcall failed: " + revertMessage(response.data));
    }
    throw new Error("Extcall failed (no details available)");
  }
  // A successful mutating call committed our checkpoint and may have changed
  // caller storage through a callback. Reads and the final response must not
  // replay a stale checkpoint over those changes. Static calls roll back the
  // checkpoint and therefore retain the caller's buffered writes.
  // A precompile commits nothing, so the buffered writes must stay buffered.
  if (kind !== EXTCALL_STATICCALL && cellpack.target.block !== PRECOMPILE_BLOCK) cache = new Map<string, StorageEntry>();
  return response;
}

// `fuelLimit` caps the callee's fuel. It crosses the boundary as a double, so
// it is exact up to 2^53, far above any real fuel budget.
export function call(cellpack: Cellpack, alkanes: AlkaneTransferParcel, fuelLimit: number): CallResponse {
  return extcall(EXTCALL_CALL, cellpack, alkanes, fuelLimit);
}

export function delegatecall(cellpack: Cellpack, alkanes: AlkaneTransferParcel, fuelLimit: number): CallResponse {
  return extcall(EXTCALL_DELEGATECALL, cellpack, alkanes, fuelLimit);
}

export function staticcall(cellpack: Cellpack, alkanes: AlkaneTransferParcel, fuelLimit: number): CallResponse {
  return extcall(EXTCALL_STATICCALL, cellpack, alkanes, fuelLimit);
}

export function readU128s(data: Uint8Array): bigint[] {
  const r = new ByteReader(data);
  const out: bigint[] = [];
  while (r.remaining() >= 16) out.push(r.u128());
  return out;
}
