// The adapter converts u32 callback arguments itself (compiler/word-abi.mjs).
// Its conversion must be ECMAScript ToUint32, the conversion scriptc applied
// before the arguments were declared f64.
import assert from "node:assert/strict";
import { test } from "node:test";
import binaryen from "binaryen";
import { U32_CONVERSION, sdkCallbacks, wordAdapter, wordCallbacks, wordProfile } from "../compiler/word-abi.mjs";

// The feature set the build passes to every Binaryen tool.
const FEATURES = binaryen.Features.MVP | binaryen.Features.BulkMemory | binaryen.Features.BulkMemoryOpt |
  binaryen.Features.SignExt | binaryen.Features.NontrappingFPToInt | binaryen.Features.MutableGlobals;

function conversion() {
  const module = binaryen.parseText(`(module ${U32_CONVERSION})`);
  module.setFeatures(FEATURES);
  assert.ok(module.validate());
  const bytes = module.emitBinary();
  module.dispose();
  return new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.__adapter_u32;
}

test("the adapter's u32 conversion is ToUint32", () => {
  const u32 = conversion();
  const check = (x) => assert.equal(u32(x) >>> 0, x >>> 0, `ToUint32(${x})`);
  const edges = [0, -0, 1, -1, 0.5, -0.5, 0.9999999999999999, 1.5, -1.5, 2 ** 31 - 1, 2 ** 31, 2 ** 31 + 0.5,
    2 ** 32 - 1, 2 ** 32 - 0.5, 2 ** 32, 2 ** 32 + 1, 2 ** 32 + 0.5, -(2 ** 31), -(2 ** 32), -(2 ** 32) - 1,
    2 ** 52, 2 ** 52 + 1, 2 ** 53 - 1, 2 ** 53, 2 ** 53 + 2, 2 ** 63, 2 ** 64, 2 ** 83, 2 ** 84, 2 ** 84 * 1.5,
    2 ** 83 * 1.9999999999999998, 2 ** 100, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, Number.MAX_VALUE,
    Number.MIN_VALUE, -Number.MIN_VALUE, Number.EPSILON, Infinity, -Infinity, NaN, 4294967295.5, 1e10, -1e10, 1e21, -1e21];
  for (const x of edges) check(x);
  for (let exponent = -4; exponent <= 90; exponent++) {
    for (const mantissa of [1, 1.25, 1.9999999999999998, 1.0000000000000002]) {
      check(mantissa * 2 ** exponent);
      check(-mantissa * 2 ** exponent);
    }
  }
  // Every bit pattern is a double; a fixed generator keeps failures reproducible.
  const view = new DataView(new ArrayBuffer(8));
  let state = 0x9e3779b9;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  for (let i = 0; i < 200_000; i++) {
    view.setUint32(0, next());
    view.setUint32(4, next());
    check(view.getFloat64(0));
  }
  // The values contracts actually pass: handles, kinds, sizes and indexes.
  for (let i = 0; i < 100_000; i++) check(next());
});

test("the build profile declares u32 callback arguments as f64, and nothing else changes", () => {
  for (const sdk of [false, true]) {
    const callbacks = sdk ? sdkCallbacks : wordCallbacks;
    const profile = wordProfile(sdk);
    assert.equal(profile.length, callbacks.length);
    profile.forEach((callback, i) => {
      assert.equal(callback.name, callbacks[i].name);
      assert.equal(callback.returns, callbacks[i].returns);
      assert.deepEqual(callback.params, callbacks[i].params.map((type) => (type === "u32" ? "f64" : type)));
    });
    // The adapter exports every callback with that signature and assembles.
    const module = binaryen.parseText(wordAdapter(sdk));
    module.setFeatures(FEATURES);
    try {
      assert.ok(module.validate());
      for (const callback of profile) {
        const exported = [...Array(module.getNumExports()).keys()]
          .map((i) => binaryen.getExportInfo(module.getExportByIndex(i))).find((e) => e.name === callback.name);
        assert.ok(exported, callback.name);
        const info = binaryen.getFunctionInfo(module.getFunction(exported.value));
        const expected = callback.params.flatMap((type) => (type === "bytes" ? [binaryen.i32, binaryen.i32] : [binaryen.f64]));
        assert.deepEqual(binaryen.expandType(info.params), expected, callback.name);
      }
    } finally {
      module.dispose();
    }
  }
});
