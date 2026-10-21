import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { compileContract } from "../compiler/index.mjs";
import { buildLibrary } from "../scripts/build.mjs";
import { AlkanesVM, u128 } from "./vm.mjs";

const work = resolve("build/test-semantics");
mkdirSync(work, { recursive: true });
const compiled = compileContract({ filename: resolve("test/fixtures/semantics.ts") });
writeFileSync(resolve(work, "entry.ts"), compiled.lowered);
// Compile precisely the output under test using the production linker.
buildLibrary({ entry: resolve(work, "entry.ts"), work, out: resolve(work, "semantics.wasm") });
const bytes = readFileSync(resolve(work, "semantics.wasm"));
const target = { block: 2n, tx: 1n }, MAX = (1n << 128n) - 1n;
const setup = () => { const vm = new AlkanesVM(); vm.deploy(target, bytes); return vm; };
const call = (vm, ...inputs) => u128.decode(vm.call({ target, inputs }).data);

test("Wasm state defaults never write; stored values survive fresh instances; temporary fields reset", () => {
  const vm = setup();
  assert.equal(call(vm, 0), 17n);
  assert.equal(vm.storageOf(target).size, 0);
  vm.call({ target, inputs: [1, 0] });
  assert.equal(call(vm, 0), 0n);
  assert.equal(call(vm, 2, 5), 5n);
  assert.equal(call(vm, 13), 1n);
  assert.equal(call(vm, 13), 1n);
  assert.throws(() => vm.call({ target, inputs: [12] }), /rollback/);
  assert.equal(call(vm, 0), 5n);
  assert.equal(call(vm, 14), 7n, "compound assignment reads before evaluating its RHS");
  assert.equal(call(vm, 1n << 127n), 9n);
});

test("Wasm checks every intermediate u128 operation; explicit wrapping and wider multiplication work", () => {
  const vm = setup();
  assert.equal(call(vm, 3, 5, 7), 5n);
  assert.throws(() => call(vm, 3, MAX, 1), /u128 overflow/);
  assert.throws(() => call(vm, 15, MAX, 1), /u128 overflow/);
  assert.throws(() => call(vm, 4, 0, 1), /u128 underflow/);
  assert.throws(() => call(vm, 5, MAX, 2), /u128 overflow/);
  assert.equal(call(vm, 6, 7, 2), 3n);
  assert.equal(call(vm, 7, 7, 2), 1n);
  for (const opcode of [6, 7]) assert.throws(() => call(vm, opcode, 1, 0), /division by zero/);
  assert.equal(call(vm, 8, MAX, 1), 0n);
  assert.equal(call(vm, 9, MAX, MAX, MAX), MAX);
  assert.throws(() => call(vm, 9, MAX, MAX, 1), /u128 overflow/);
  assert.equal(call(vm, 10, 1, 127), 1n << 127n);
  assert.throws(() => call(vm, 10, 2, 127), /u128 overflow/);
  assert.throws(() => call(vm, 10, 1, 128), /shift out of range/);
  assert.equal(call(vm, 11, 0), MAX);
});

test("Counter rejects incoming assets before executing or writing", () => {
  const vm = new AlkanesVM();
  vm.deploy(target, readFileSync("dist/counter.wasm"));
  assert.throws(() => vm.call({ target, inputs: [1, 7], incoming: [{ id: target, value: 5n }] }), /rejects incoming assets/);
  assert.equal(call(vm, 2), 0n);
  assert.equal(vm.storageOf(target).size, 0);
});

test("forward policy preserves incoming transfers; views reject them", () => {
  const vm = setup();
  const incoming = [{ id: { block: 2n, tx: 7n }, value: 9n }];
  const response = vm.call({ target, inputs: [2, 3], incoming });
  assert.deepEqual(response.alkanes, incoming);
  assert.equal(u128.decode(response.data), 20n);
  assert.throws(() => vm.call({ target, inputs: [0], incoming }), /view rejects incoming assets/);
  assert.equal(call(vm, 0), 20n);
});

test("typed state rejects malformed persisted values", () => {
  const vm = setup();
  vm.storageOf(target).set(Buffer.from("/stable").toString("hex"), new Uint8Array([1]));
  assert.throws(() => call(vm, 0), /invalid u128 storage: \/stable/);
});
