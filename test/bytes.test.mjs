import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function loadBytes(path) {
  const { outputText } = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  });
  return import("data:text/javascript;base64," + Buffer.from(outputText).toString("base64"));
}
const baseline = await loadBytes(join(root, "bench/optimization/legacy-codecs.ts"));
const codecs = await loadBytes(join(root, "sdk/bytes.ts"));
let seed = 0x12345678;
function randomU32() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; }

test("ASCII hex codec matches Bitcoin byte encoding, all byte values and varied lengths", () => {
  for (const length of [0, 1, 2, 3, 16, 31, 32, 255, 256, 4096]) {
    const bytes = Uint8Array.from({ length }, (_, i) => length === 256 ? i : randomU32() & 255);
    assert.equal(codecs.toHex(bytes), Buffer.from(bytes).toString("hex"));
    assert.equal(codecs.toHex(bytes), baseline.toHex(bytes));
  }
});

test("u128 codecs preserve every bit at limb boundaries and in 500 deterministic random values", () => {
  const values = [0n, 1n, 255n, 256n, (1n << 32n) - 1n, 1n << 32n,
    (1n << 64n) - 1n, 1n << 64n, (1n << 96n) + 42n, (1n << 128n) - 1n];
  for (let i = 0; i < 500; i++) {
    values.push((BigInt(randomU32()) << 96n) | (BigInt(randomU32()) << 64n)
      | (BigInt(randomU32()) << 32n) | BigInt(randomU32()));
  }
  for (const value of values) {
    const expected = Uint8Array.from(Buffer.from(value.toString(16).padStart(32, "0"), "hex")).reverse();
    assert.deepEqual(codecs.u128ToBytes(value), expected);
    assert.equal(codecs.bytesToU128(expected), value);
    const padded = new Uint8Array(24);
    padded.set(expected, 5);
    assert.equal(codecs.bytesToU128(padded, 5), value);
    assert.equal(codecs.bytesToU128(padded.subarray(3, 23), 2), value);
  }
});

test("short storage values and unusual offsets retain existing decoder behavior", () => {
  for (let length = 0; length <= 32; length++) {
    const bytes = Uint8Array.from({ length }, () => randomU32() & 255);
    for (const offset of [0, 1, 3, 15, 16, 17, 32, -1, 0.5, NaN, Infinity, -Infinity]) {
      let expected;
      try { expected = baseline.bytesToU128(bytes, offset); }
      catch (error) { assert.throws(() => codecs.bytesToU128(bytes, offset), { name: error.name }); continue; }
      assert.equal(codecs.bytesToU128(bytes, offset), expected);
    }
  }
  for (const value of [-1n, 1n << 128n]) {
    assert.throws(() => codecs.u128ToBytes(value), /u128 out of range/);
  }
});

test("u32 writer preserves little-endian modulo conversion for numeric inputs", () => {
  const values = [0, 1, 255, 256, 65535, 65536, 0x7fffffff, 0x80000000, 0xffffffff,
    0x100000000, -1, -255.75, 257.75, Number.MAX_SAFE_INTEGER, NaN, Infinity, -Infinity];
  for (let i = 0; i < 500; i++) values.push(randomU32());
  const actual = new codecs.ByteWriter();
  const legacy = new baseline.ByteWriter();
  const expected = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => {
    actual.u32(value);
    legacy.u32(value);
    expected.writeUInt32LE(value >>> 0, i * 4);
  });
  assert.deepEqual(actual.finish(), new Uint8Array(expected));
  assert.deepEqual(actual.finish(), legacy.finish());
});

test("writer keeps byte references until finish and permits repeated finishes", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const writer = new codecs.ByteWriter().u32(3).bytes(bytes).u128(1n << 96n);
  const legacy = new baseline.ByteWriter().u32(3).bytes(bytes).u128(1n << 96n);
  bytes[0] = 9;
  assert.deepEqual(writer.finish(), legacy.finish());
  const first = writer.finish();
  writer.u32(0xffffffff);
  legacy.u32(0xffffffff);
  assert.deepEqual(writer.finish(), legacy.finish());
  assert.deepEqual(first, writer.finish().subarray(0, first.length));
});
