// Host callbacks. Each declaration becomes a `scriptc.<name>` Wasm import that
// shim/adapter.wat implements on top of the alkanes `env.*` host functions.
//
// scriptc callbacks can pass bytes to the host but can only return scalars, so
// host functions that produce bytes write them into a "scratch" buffer owned by
// the adapter and return its length; the SDK then copies it out four bytes at a
// time with __alk_scratch_read.

declare function __alk_abort(): void;
declare function __alk_log(message: Uint8Array): void;
declare function __alk_scratch_read(offset: number): number;
declare function __alk_load_storage(key: Uint8Array): number;
declare function __alk_balance(who: Uint8Array, what: Uint8Array): number;
declare function __alk_sequence(): number;
declare function __alk_fuel(): number;
declare function __alk_height(): number;
declare function __alk_transaction(): number;
declare function __alk_block(): number;
declare function __alk_extcall(
  kind: number,
  cellpack: Uint8Array,
  alkanes: Uint8Array,
  storage: Uint8Array,
  fuel: number,
): number;

function readScratch(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 4) {
    const word = __alk_scratch_read(i);
    out[i] = word & 0xff;
    if (i + 1 < length) out[i + 1] = (word >>> 8) & 0xff;
    if (i + 2 < length) out[i + 2] = (word >>> 16) & 0xff;
    if (i + 3 < length) out[i + 3] = (word >>> 24) & 0xff;
  }
  return out;
}

export function hostAbort(): void {
  __alk_abort();
}

export function hostLog(message: Uint8Array): void {
  __alk_log(message);
}

export function hostLoadStorage(key: Uint8Array): Uint8Array {
  return readScratch(__alk_load_storage(key));
}

export function hostBalance(who: Uint8Array, what: Uint8Array): Uint8Array {
  return readScratch(__alk_balance(who, what));
}

export function hostSequence(): Uint8Array {
  return readScratch(__alk_sequence());
}

export function hostFuel(): Uint8Array {
  return readScratch(__alk_fuel());
}

export function hostHeight(): Uint8Array {
  return readScratch(__alk_height());
}

export function hostTransaction(): Uint8Array {
  return readScratch(__alk_transaction());
}

export function hostBlock(): Uint8Array {
  return readScratch(__alk_block());
}

export const EXTCALL_CALL = 0;
export const EXTCALL_DELEGATECALL = 1;
export const EXTCALL_STATICCALL = 2;

export class ExtcallResult {
  constructor(
    public readonly status: number,
    public readonly returndata: Uint8Array,
  ) {}
}

// `status` is the raw host result: the returndata length on success, its
// negation on failure.
export function hostExtcall(
  kind: number,
  cellpack: Uint8Array,
  alkanes: Uint8Array,
  storage: Uint8Array,
  fuel: number,
): ExtcallResult {
  const status = __alk_extcall(kind, cellpack, alkanes, storage, fuel);
  return new ExtcallResult(status, readScratch(status < 0 ? -status : status));
}
