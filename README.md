# alkanes-ts

An experiment in writing [alkanes](https://github.com/kungfuflex/alkanes-rs) smart contracts for Bitcoin in TypeScript. Contracts are compiled to WebAssembly ahead of time with [scriptc](https://github.com/vercel-labs/scriptc), with no JavaScript engine in the output.

```ts
import { CallResponse, Contract, StoragePointer, checkedAdd, param } from "../../sdk/index.ts";

const count = new StoragePointer("/count");

export default new Contract("Counter")
  .method(1, "increment", [param("by")], "u128", (_ctx, args) => {
    const next = checkedAdd(count.getU128(), args.u128(0));
    count.setU128(next);
    return new CallResponse().withU128(next);
  })
  .method(2, "get_count", [], "u128", () => new CallResponse().withU128(count.getU128()));
```

Status: the example contracts build, pass a behavioral test suite, and run under wasmi 0.37.2, the engine and version the alkanes indexer uses. They have not been deployed to a regtest or mainnet indexer yet.

## How it works

An alkane is a Wasm module that exports `memory`, `__execute` and `__meta` and imports host functions from `env` (`__load_context`, `__load_storage`, `__call`, …). Byte buffers cross the boundary in "arraybuffer layout": a pointer to the data, with a u32 length in the 4 bytes before it.

scriptc can't produce that module directly. Its library mode emits a WASI reactor whose host callbacks are imported from a `scriptc` namespace, can take bytes but only return scalars, and can't reenter the module. `scripts/build.mjs` closes the gap:

```
contracts/<name>/index.ts ─┐
sdk/*.ts ──────────────────┴─ scriptc --lib (wasm32-wasi) ─► contract.wasm
                                                                │
shim/adapter.wat  (alkanes env.* ⇄ scriptc callbacks) ─────────┤ wasm-merge
shim/wasi.wat     (deterministic WASI stand-ins) ──────────────┘
                                                                │
                       wasm-metadce + wasm-opt -Oz (wasmi-compatible features only)
                                                                │
                                      dist/<name>.wasm, dist/<name>.wasm.gz
```

- **`sdk/`** is the contract-side library. It implements the alkanes wire types (`AlkaneId`, `Cellpack`, `Context`, `CallResponse`, transfer parcels), a storage write cache that is returned with the response the way `alkanes-runtime` does it, `StoragePointer`, chain queries, extcalls, and opcode dispatch with `__meta` ABI generation. u128 values are `bigint`s.
- **`shim/adapter.wat`** implements `__execute` and `__meta`. It initializes the reactor, loads the context, calls the scriptc export, and copies the result into arraybuffer layout. It also implements each `__alk_*` callback on top of the matching `env.*` host function. Host results that are bytes go into a scratch buffer that the SDK reads back 4 bytes per callback. Since scriptc rejects reentry, buffers created inside callbacks come from an arena that the adapter grows with `memory.grow`.
- **`shim/wasi.wat`** satisfies the runtime's WASI imports deterministically: no environment, a clock fixed at 0, `stdout` routed to `__log`, and `random_get` traps.
- The build fails if the final module imports anything outside `env` or exports anything besides `memory`, `__execute` and `__meta`.

Reverts follow `alkanes-runtime`: a thrown `Error` calls `env.abort` and returns data prefixed with the `0x08c379a0` selector, which the indexer reports as `ALKANES: revert: Error: <message>` and rolls back.

## Usage

Requirements: Node.js 24+, [Zig](https://ziglang.org) 0.16 on `PATH` (scriptc uses it to link Wasm), and Rust only for the wasmi check.

```console
$ npm install
$ npm run build              # every contract in contracts/, or: npm run build -- counter
dist/counter.wasm  258811 bytes (111221 gzipped)
dist/token.wasm  264506 bytes (112856 gzipped)
$ npm test                   # contracts against test/vm.mjs, a JS model of the alkanes host
$ npm run check:wasmi -- dist/counter.wasm --meta 0 1,5 2 3
loaded dist/counter.wasm (258811 bytes) under wasmi 0.37.2
__meta  fuel=45136     { "contract": "Counter", ... }
[0]  fuel=233696    ok alkanes=0 data=
[1,5]  fuel=197575    ok alkanes=0 data=05000000000000000000000000000000 u128=5
[2]  fuel=185526    ok alkanes=0 data=05000000000000000000000000000000 u128=5
[3]  fuel=206765    REVERT "Error: intentional failure"
```

Each argument to `check:wasmi` is one call, given as comma-separated u128 inputs with the opcode first. Storage persists between calls.

To add a contract, create `contracts/<name>/index.ts` with a default-exported `Contract`, then run `npm run build -- <name>`.

## Example contracts

- **`contracts/counter`**: initialize, increment, read, a method that writes and then throws to show rollback, and a method that reads the block height and logs it.
- **`contracts/token`**: a minimal owned fungible alkane. `initialize(supply)` mints the supply to the caller, `mint` is owner-only, and opcodes 99/100/101 return name, symbol and total supply. `forward_call` demonstrates an extcall into another alkane.

## Findings and open questions

- **What compiles:** scriptc handled everything the SDK needed, including classes, closures, `bigint` arithmetic for u128, `Map`, `Uint8Array`, `DataView`, `TextEncoder`/`TextDecoder`, `JSON.stringify` and try/catch. Two rough edges: `number.toString(radix)` is refused, and indexing a `bigint[]` is typed `bigint | undefined`, which is why handlers get an `Inputs` wrapper.
- **Engine compatibility:** the output uses only bulk-memory, sign-ext, saturating float-to-int and mutable globals, all supported by wasmi 0.37 (no SIMD). The build pins wasm-opt to those features.
- **Size:** about 260 KB raw and 112 KB gzipped, most of it the scriptc runtime. Typical Rust alkanes are in the same range.
- **Fuel:** about 150K–270K per call, 3–5× an equivalent Rust contract, against a per-message minimum of 3.5M on mainnet. See [bench/](bench/README.md) for the full comparison with alkanes-rs.
- **Host reads cost one callback per 4 bytes.** That is cheap for storage values but would add up for `transaction()`/`block()` on large blocks.
- **Determinism** needs a proper audit before anything holds value. Known so far: floats in wasmi are software-deterministic, `Map` iteration is insertion-ordered, the clock reads 0, and randomness traps. Not yet audited: the rest of the scriptc runtime, such as hashing and GC timing.
- **Not covered by tests yet:** deployment through an envelope on a real indexer, alkane balance enforcement (the JS VM doesn't model it), and `delegatecall`/`staticcall` beyond the JS model.

## Layout

```
sdk/                TypeScript contract SDK (compiled into every contract)
contracts/          example contracts
shim/               adapter + WASI stand-ins in WebAssembly text
scripts/build.mjs   build pipeline
test/               JS alkanes host model and contract tests
harness/            Rust wasmi 0.37.2 host model: wasmi-check runner and bench
bench/              Rust twins of the examples and the alkanes-rs comparison
```
