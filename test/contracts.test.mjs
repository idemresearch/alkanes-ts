import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";
import { AlkanesVM, u128 } from "./vm.mjs";

// ALKANES_SOURCE=1 deploys the contracts' TypeScript source (test/source.mjs)
// instead of the built modules, so this file runs without a Wasm build.
const wasm = (name) => process.env.ALKANES_SOURCE
  ? resolve("contracts", name, "index.ts")
  : readFileSync(process.env.ALKANES_DIST
    ? resolve(process.env.ALKANES_DIST, `${name}.wasm`)
    : new URL(`../dist/${name}.wasm`, import.meta.url));
const text = (bytes) => Buffer.from(bytes).toString("utf8");

const COUNTER = { block: 2n, tx: 1n };
const TOKEN = { block: 2n, tx: 2n };
const DEPLOYER = { block: 2n, tx: 100n };

function setup() {
  const vm = new AlkanesVM({ height: 900123n });
  vm.deploy(COUNTER, wasm("counter"));
  vm.deploy(TOKEN, wasm("token"));
  return vm;
}

test("counter: __meta returns the ABI", () => {
  const abi = setup().meta(COUNTER);
  assert.equal(abi.contract, "Counter");
  assert.deepEqual(
    abi.methods.map((m) => [m.opcode, m.name]),
    [
      [0, "initialize"],
      [1, "increment"],
      [2, "get_count"],
      [3, "increment_then_fail"],
      [4, "height"],
      [5, "sum"],
      [6, "fill"],
    ],
  );
  assert.deepEqual(abi.methods[1].params, [{ type: "u128", name: "by" }]);
});

test("counter: storage persists across calls", () => {
  const vm = setup();
  vm.call({ target: COUNTER, inputs: [0] });
  assert.equal(u128.decode(vm.call({ target: COUNTER, inputs: [1, 5] }).data), 5n);
  assert.equal(u128.decode(vm.call({ target: COUNTER, inputs: [1, 7] }).data), 12n);
  assert.equal(u128.decode(vm.call({ target: COUNTER, inputs: [2] }).data), 12n);
});

test("counter: a thrown error reverts with its message and rolls back storage", () => {
  const vm = setup();
  vm.call({ target: COUNTER, inputs: [0] });
  vm.call({ target: COUNTER, inputs: [1, 3] });
  assert.throws(() => vm.call({ target: COUNTER, inputs: [3] }), {
    message: "ALKANES: revert: Error: intentional failure",
  });
  assert.equal(u128.decode(vm.call({ target: COUNTER, inputs: [2] }).data), 3n);
  assert.throws(() => vm.call({ target: COUNTER, inputs: [0] }), /already initialized/);
});

test("counter: bad opcodes and missing inputs revert", () => {
  const vm = setup();
  assert.throws(() => vm.call({ target: COUNTER, inputs: [] }), /No opcode provided/);
  assert.throws(() => vm.call({ target: COUNTER, inputs: [42] }), /Unrecognized opcode 42/);
  assert.throws(() => vm.call({ target: COUNTER, inputs: [1] }), /increment expects 1 inputs/);
});

test("counter: u128 arithmetic is exact and checked", () => {
  const vm = setup();
  vm.call({ target: COUNTER, inputs: [0] });
  const big = (1n << 127n) + 12345n;
  assert.equal(u128.decode(vm.call({ target: COUNTER, inputs: [1, big] }).data), big);
  assert.throws(() => vm.call({ target: COUNTER, inputs: [1, 1n << 127n] }), /u128 overflow/);
});

test("counter: numeric sum fast path and bigint fallback return exact u128 sums", () => {
  const vm = setup();
  for (const n of [0n, 1n, 2n, 99n, 100n, 10_000n, 299_999n, 300_000n, 300_001n]) {
    const expected = n * (n - 1n) * (2n * n - 1n) / 6n;
    const result = vm.call({ target: COUNTER, inputs: [5, n] });
    assert.equal(u128.decode(result.data), expected, `sum(${n})`);
  }
});

test("counter: reads block height and logs through the host", () => {
  const vm = setup();
  assert.equal(u128.decode(vm.call({ target: COUNTER, inputs: [4] }).data), 900123n);
  assert.deepEqual(vm.logs, ["counter: block height is 900123"]);
});

test("token: initialize mints the supply to the caller", () => {
  const vm = setup();
  const { alkanes } = vm.call({ target: TOKEN, inputs: [0, 1_000_000], caller: DEPLOYER });
  assert.deepEqual(alkanes, [{ id: TOKEN, value: 1_000_000n }]);
  assert.equal(u128.decode(vm.call({ target: TOKEN, inputs: [101] }).data), 1_000_000n);
  assert.equal(text(vm.call({ target: TOKEN, inputs: [99] }).data), "TypeScript Token");
  assert.equal(text(vm.call({ target: TOKEN, inputs: [100] }).data), "TST");
});

test("token: only the owner can mint; incoming alkanes are forwarded", () => {
  const vm = setup();
  vm.call({ target: TOKEN, inputs: [0, 100], caller: DEPLOYER });
  assert.throws(
    () => vm.call({ target: TOKEN, inputs: [77, 5], caller: { block: 2n, tx: 999n } }),
    /caller is not the owner/,
  );
  const incoming = [{ id: { block: 2n, tx: 7n }, value: 3n }];
  const { alkanes } = vm.call({ target: TOKEN, inputs: [77, 50], caller: DEPLOYER, incoming });
  assert.deepEqual(alkanes, [...incoming, { id: TOKEN, value: 50n }]);
  assert.equal(u128.decode(vm.call({ target: TOKEN, inputs: [101] }).data), 150n);
});

test("token: metadata, wide owner IDs and duplicate/zero forwarding stay exact", () => {
  const vm=setup(),caller={block:1n<<127n,tx:(1n<<96n)+5n};
  const incoming=[{id:{block:4n,tx:7n},value:2n},{id:{block:4n,tx:7n},value:3n},{id:TOKEN,value:0n}];
  const issued={id:TOKEN,value:0n};
  assert.deepEqual(vm.call({target:TOKEN,inputs:[0,0],caller,incoming}).alkanes,[...incoming,issued]);
  assert.deepEqual(vm.call({target:TOKEN,inputs:[77,0],caller,incoming}).alkanes,[...incoming,issued]);
  const metadata=vm.meta(TOKEN);assert.equal(metadata.contract,"TypeScriptToken");
  assert.deepEqual(metadata.methods.map(m=>[m.opcode,m.name,m.returns]),[[0,"initialize","void"],[77,"mint","void"],[99,"get_name","String"],[100,"get_symbol","String"],[101,"get_total_supply","u128"],[200,"forward_call","Vec<u8>"]]);
});

test("token: extcall into another alkane returns its data", () => {
  const vm = setup();
  vm.call({ target: COUNTER, inputs: [0] });
  vm.call({ target: COUNTER, inputs: [1, 41] });
  const { data } = vm.call({ target: TOKEN, inputs: [200, COUNTER.block, COUNTER.tx, 2] });
  assert.equal(u128.decode(data), 41n);
});

test("token: a failing extcall surfaces the callee's revert message", () => {
  const vm = setup();
  assert.throws(
    () => vm.call({ target: TOKEN, inputs: [200, COUNTER.block, COUNTER.tx, 3] }),
    /Extcall failed: ALKANES: revert: Error: intentional failure/,
  );
});
