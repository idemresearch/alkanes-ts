// Each pair runs in this SAME module, with the same initialized globals.
// Fixture preparation is outside the measured interval.
import { ByteWriter, bytesToU128, checkedAdd, toHex, u128ToBytes } from "../../sdk/bytes.ts";
import { Contract, executeContract } from "../../sdk/contract.ts";
import { hostLoadStorage } from "../../sdk/host.ts";
import { resetStorage, serializeStorage, store } from "../../sdk/runtime.ts";
import { CallResponse } from "../../sdk/types.ts";

declare function __alk_load_storage(key: Uint8Array): number;

const contract = new Contract("Isolation").method(0, "noop", [], "void", () => new CallResponse());
const hostKey = new Uint8Array([47, 112, 114, 111, 98, 101]);
const context = new Uint8Array(112);
new DataView(context.buffer).setUint32(0, 2, true);
new DataView(context.buffer).setUint32(16, 1, true);
new DataView(context.buffer).setUint32(32, 2, true);
new DataView(context.buffer).setUint32(48, 100, true);
let keys: Uint8Array[] = [];
let values: Uint8Array[] = [];

export function execute(context: Uint8Array): Uint8Array {
  return executeContract(contract, context);
}

// Same output as minimal.ts: avoids conflating ABI JSON generation with init.
export function meta(): Uint8Array {
  return new Uint8Array(0);
}

export function noop(n: number): number {
  return n;
}

export function prepare(n: number): number {
  keys = [];
  values = [];
  for (let i = 0; i < n; i++) {
    const key = new Uint8Array(16);
    new DataView(key.buffer).setUint32(0, i, true);
    keys.push(key);
    const value = new Uint8Array(16);
    new DataView(value.buffer).setUint32(0, i + 1, true);
    values.push(value);
  }
  return keys.length;
}

export function numberMath(n: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) total += i * i;
  return total >>> 0;
}

export function bigintMath(n: number): number {
  let total = 0n;
  const bound = BigInt(n);
  for (let i = 0n; i < bound; i++) total += i * i;
  return Number(total & 0xffff_ffffn);
}

export function checkedMath(n: number): number {
  let total = 0n;
  const bound = BigInt(n);
  for (let i = 0n; i < bound; i++) total = checkedAdd(total, i * i);
  return Number(total & 0xffff_ffffn);
}

export function encodingControl(n: number): number {
  let total = 0n;
  for (let i = 0; i < n; i++) total += (1n << 96n) + BigInt(i);
  return Number(total & 0xffff_ffffn);
}

export function encodingRoundtrip(n: number): number {
  let total = 0n;
  for (let i = 0; i < n; i++) {
    total += bytesToU128(u128ToBytes((1n << 96n) + BigInt(i)));
  }
  return Number(total & 0xffff_ffffn);
}

export function verifyEncoding(_n: number): number {
  const cases = [0n, 1n, (1n << 64n) - 1n, 1n << 64n, (1n << 96n) + 42n, (1n << 128n) - 1n];
  for (const value of cases) {
    if (bytesToU128(u128ToBytes(value)) !== value) throw new Error("u128 roundtrip mismatch");
  }
  return cases.length;
}

// Measures the existing bridge without the SDK's scratch-reading loop.
export function hostRequest(_n: number): number {
  return __alk_load_storage(hostKey);
}

export function hostCopy(_n: number): number {
  return hostLoadStorage(hostKey).length;
}

// Separate correctness call so validating every byte does not inflate copy fuel.
export function verifyHostCopy(_n: number): number {
  const bytes = hostLoadStorage(hostKey);
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== ((i * 17 + 3) & 255)) throw new Error("host copy mismatch");
  }
  return bytes.length;
}

export function keyBytes(n: number): number {
  let length = 0;
  for (let i = 0; i < n; i++) length += keys[i].length;
  return length;
}

export function keyHex(n: number): number {
  let length = 0;
  for (let i = 0; i < n; i++) length += toHex(keys[i]).length / 2;
  return length;
}

function checksum(bytes: Uint8Array): number {
  let hash = 0;
  for (let i = 0; i < bytes.length; i++) hash = (hash * 33 + bytes[i]) >>> 0;
  return hash;
}

// Same module, context, byte result and checksum. Only the SDK execution
// pipeline (reset, parse, dispatch, response serialization) is added.
export function pipelineBare(_n: number): number {
  const result = new Uint8Array(20);
  return (checksum(result) + result.length) >>> 0;
}

export function pipelineSdk(_n: number): number {
  const result = executeContract(contract, context);
  return (checksum(result) + result.length) >>> 0;
}

export function serializeOnly(n: number): number {
  resetStorage();
  const w = new ByteWriter().u32(n);
  for (let i = 0; i < n; i++) {
    w.u32(keys[i].length).bytes(keys[i]);
    w.u32(values[i].length).bytes(values[i]);
  }
  return checksum(w.finish());
}

export function cacheAndSerialize(n: number): number {
  resetStorage();
  for (let i = 0; i < n; i++) store(keys[i], values[i]);
  return checksum(serializeStorage());
}
