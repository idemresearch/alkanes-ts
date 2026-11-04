# alkanes-ts

An experiment in writing [alkanes](https://github.com/kungfuflex/alkanes-rs) smart contracts for Bitcoin in TypeScript. Contracts are compiled to WebAssembly ahead of time with [scriptc](https://github.com/vercel-labs/scriptc), with no JavaScript engine in the output.

```ts
import { Contract, state, method, view, type u128 } from "../../sdk/authoring.ts";

export default class Counter extends Contract {
  static readonly incomingAssets = "reject";
  @state({ key: "/count" }) private count: u128 = 0n;

  @method({ opcode: 1 })
  increment(by: u128): u128 {
    this.count += by;
    return this.count;
  }

  @view({ opcode: 2, abiName: "get_count" })
  getCount(): u128 { return this.count; }
}
```

Status: the example contracts build and pass behavioral tests. CappedToken additionally runs through the actual Alkanes indexer in-process, including deployment envelopes, auth calls, real asset balances and rollback. No live Bitcoin regtest/mainnet transaction has been broadcast.

Counter uses the restricted Alkanes frontend for persistent fields, checked operators, enforced views, static dispatch and generated clients. [CappedToken](docs/CAPPED_TOKEN.md) adds `@init`, typed `AlkaneId` state, Alkanes auth-token verification, tracked assets and generated deployment/call plans. Token retains the explicit SDK API. All three examples now use fixed-width lowering while scriptc compiles their contract logic; [Counter/Token details](docs/EXAMPLES_OPTIMIZATION.md) cover loops, legacy responses and cross-contract calls. See the [authoring semantics, client usage and current limits](docs/AUTHORING.md). The package is private; `@alkanes/contract` remains the proposed public entry point.

## How it works

An alkane is a Wasm module that exports `memory`, `__execute` and `__meta` and imports host functions from `env` (`__load_context`, `__load_storage`, `__call`, …). Byte buffers cross the boundary in "arraybuffer layout": a pointer to the data, with a u32 length in the 4 bytes before it.

scriptc can't produce that module directly. Its library mode emits a WASI reactor whose host callbacks are imported from a `scriptc` namespace, can take bytes but only return scalars, and can't reenter the module. `scripts/build.mjs` closes the gap:

```
contracts/<name>/index.ts ── Alkanes frontend (class contracts) ─┐
sdk/*.ts ──────────────────┴─ scriptc --lib (wasm32-wasi) ─► contract.wasm
                                                                │
shim/adapter.wat  (alkanes env.* ⇄ scriptc callbacks) ─────────┤ wasm-merge
shim/wasi.wat     (deterministic WASI stand-ins) ──────────────┘
                                                                │
                       wasm-metadce + wasm-opt -Oz (wasmi-compatible features only)
                                                                │
                                      dist/<name>.wasm, dist/<name>.wasm.gz
```

- **`sdk/`** is the contract-side library. It implements the alkanes wire types (`AlkaneId`, `Cellpack`, `Context`, `CallResponse`, transfer parcels), a storage write cache that is returned with the response the way `alkanes-runtime` does it, `StoragePointer`, chain queries, extcalls, and opcode dispatch with `__meta` ABI generation. Public u128 values are `bigint`s. Eligible contracts use compiler-private word handles and `shim/word.c`, compiled into the same metered Wasm module; their generated adapter comes from `compiler/word-abi.mjs`.
- **`shim/adapter.wat`** implements `__execute` and `__meta`. It initializes the reactor, loads the context, calls the scriptc export, and copies the result into arraybuffer layout. It also implements each `__alk_*` callback on top of the matching `env.*` host function. Host results that are bytes go into a scratch buffer that the SDK reads back 4 bytes per callback. Since scriptc rejects reentry, buffers created inside callbacks come from an arena that the adapter grows with `memory.grow`.
- **`shim/wasi.wat`** satisfies the runtime's WASI imports deterministically: no environment, a clock fixed at 0, `stdout` routed to `__log`, and `random_get` traps.
- **`shim/printf.c`** replaces wasi-libc's `vsnprintf`/`snprintf`, which the scriptc runtime uses only for a few trap and RangeError messages. libc's version brings musl's whole printf engine (about 12 KB of code after optimization, including 128-bit soft-float for `%f`/`%g`). The replacement is musl's integer/string subset (`d i o u x X c s p %`, all flags, widths, precisions and integer length modifiers) and traps on the rest. `scripts/link.mjs`, set as `SCRIPTC_LINKER`, links it ahead of libc and runs `scripts/printf-formats.mjs` on the named link output: every format reaching it must be a constant string in the supported subset, following pass-through wrappers such as `scr_trap_fmt`. Otherwise it relinks with libc's printf, as for bigint-path contracts, which reach `%.17g`. `test/printf.test.mjs` compares it with libc in Wasm over about 57,000 formats; `--libc-printf` builds the previous linkage. Benchmark and baseline builds use the same link step, so reproducing a binary from an earlier report needs `buildLibrary({ printf: "libc" })`.
- The build fails if the final module imports anything outside `env` or exports anything besides `memory`, `__execute` and `__meta`.

Reverts follow `alkanes-runtime`: a thrown `Error` calls `env.abort` and returns data prefixed with the `0x08c379a0` selector, which the indexer reports as `ALKANES: revert: Error: <message>` and rolls back.

## Usage

Requirements: Node.js 24+, [Zig](https://ziglang.org) on `PATH` (the current reports use 0.17.0). Zig links scriptc output and builds the fixed-width Wasm SDK. Rust is needed for the standalone wasmi check and canonical-runtime integration/benchmarks; see [CappedToken setup](docs/CAPPED_TOKEN.md#verification-and-benchmarking).

The compiler, `@scriptc/runtime-wasm32-wasi`, and `@scriptc/types` are pinned together at **0.4.0**. Saved benchmark reports record the toolchain used for each measurement.

The SDK uses arithmetic ASCII hex encoding, two-limb u128 codecs and direct u32 byte writes. See the [production before/after fuel report](bench/SDK_OPTIMIZATION_RESULTS.md) for the measured savings against the previous codecs.

Counter removes string-keyed opcode dispatch and has an exact numeric fast path for its sum loop. The [speed comparison](bench/SPEED.md) measures both fuel and execution time against Rust, including a Rust build given the same numeric optimization.

The [frontend fuel comparison](bench/FRONTEND_FUEL_RESULTS.md) records the new class implementation against `3762cad`; the [frontend Rust comparison](bench/FRONTEND_SPEED_RESULTS.md) measures it against both original and matched numeric Rust implementations.

The [CappedToken optimization comparison](bench/CAPPED_TOKEN_OPTIMIZATION_RESULTS.md) runs the original bigint representation, the new fixed-width lowering, and unchanged optimized Rust through the actual Alkanes indexer. [Compiler/SDK isolation](bench/CAPPED_TOKEN_ISOLATION_RESULTS.md) separates compilation, startup and execution and tests SDK algorithm alternatives. [Fixed-width lowering](docs/WORD_LOWERING.md) explains the supported subset and the C helpers compiled into the same metered Wasm module. scriptc still compiles the contract methods. [Integration results](integration/RESULTS.md) record the upstream revision and hashes; the [first CappedToken benchmark](bench/CAPPED_TOKEN_RESULTS.md) remains a historical baseline.

In the paired 30-run comparison, authenticated mint uses 108,865 fuel versus 197,787 for Rust O3/LTO plus wasm-opt O3, and takes 5.71 ms versus 6.90 ms. Wide mint and all three views also beat optimized Rust in fuel and local indexing time. Fresh deployment timing includes chain bootstrap and does not establish isolated initializer speed.

The [Counter/Token runtime comparison](bench/EXAMPLES_RUNTIME_RESULTS.md) uses the same canonical indexer, complete response/storage checks and actual UTXO balances. Counter's Rust baseline has the same numeric sum fast path as TS; both Rust O3/LTO and Rust plus wasm-opt O3 are measured. [Verification results](integration/EXAMPLES_RESULTS.md) include ownership rejection, wide values and nested rollback.

```console
$ npm install
$ npm run build              # every contract in contracts/, or: npm run build -- counter
dist/capped-token.wasm  ~108 KB (~47 KB gzipped)
dist/counter.wasm  ~111 KB (~49 KB gzipped)
dist/token.wasm  ~106 KB (~48 KB gzipped)
$ npm test                   # rebuild, compiler/client tests, and Wasm host-model tests
$ ALKANES_RS=/path/to/alkanes-rs npm run test:runtime
$ ALKANES_RS=/path/to/alkanes-rs npm run bench:capped -- --iterations 30
$ ALKANES_RS=/path/to/alkanes-rs npm run test:examples
$ npm run build:bench:examples
$ ALKANES_RS=/path/to/alkanes-rs npm run bench:examples -- --iterations 30 --baseline dist/examples-before
$ npm run check:wasmi -- dist/counter.wasm --meta 0 1,5 2 3
loaded dist/counter.wasm (224679 bytes) under wasmi 0.37.2
__meta  fuel=12311     { "contract": "Counter", ... }
[0]  fuel=44472     ok alkanes=0 data=
[1,5]  fuel=48904     ok alkanes=0 data=05000000000000000000000000000000 u128=5
[2]  fuel=38721     ok alkanes=0 data=05000000000000000000000000000000 u128=5
[3]  fuel=48932     REVERT "Error: intentional failure"
```

Each argument to `check:wasmi` is one call, given as comma-separated u128 inputs with the opcode first. Storage persists between calls.

To add a contract, create `contracts/<name>/index.ts` with a default-exported `Contract`, then run `npm run build -- <name>`.

## Example contracts

- **`contracts/counter`**: initialize, increment, read, a method that writes and then throws to show rollback, and a method that reads the block height and logs it.
- **`contracts/capped-token`**: one-time initialization, typed authority ID, fixed supply cap, authenticated minting, tracked incoming/call-return/self-issued assets, and views. Generates `CappedTokenClient` with atomic deployment requests and immutable asset-aware call plans.
- **`contracts/token`**: a minimal owned fungible alkane using the legacy explicit SDK. `initialize(supply)` mints the supply to the caller, `mint` is owner-only, and opcodes 99/100/101 return name, symbol and total supply. `forward_call` demonstrates an extcall into another alkane.

## Findings and open questions

- **What compiles:** scriptc handled everything the SDK needed, including classes, closures, `bigint` arithmetic for u128, `Map`, `Uint8Array`, `DataView`, `TextEncoder`/`TextDecoder`, `JSON.stringify` and try/catch. Two rough edges: `number.toString(radix)` is refused, and indexing a `bigint[]` is typed `bigint | undefined`, which is why handlers get an `Inputs` wrapper.
- **Engine compatibility:** the output uses only bulk-memory, sign-ext, saturating float-to-int and mutable globals, all supported by wasmi 0.37 (no SIMD). The build pins wasm-opt to those features.
- **Size:** about 111 KB raw / 49 KB gzipped for class Counter, 108 KB / 47 KB for CappedToken, and 106 KB / 48 KB for legacy Token, including the scriptc runtime.
- **Fuel:** Counter reads, initialization and increments use about 39K–49K instruction fuel. The [frontend comparison](bench/FRONTEND_FUEL_RESULTS.md) measures the class frontend against the previous implementation, including the cost of fully checked bigint loops. The [codec report](bench/SDK_OPTIMIZATION_RESULTS.md) and [execution report](bench/EXECUTION_RESULTS.md) record earlier optimization passes. Bigint-heavy loops remain expensive; Counter uses numbers only within a proven exact range.
- **Execution speed:** the [current canonical-runtime comparison](bench/EXAMPLES_RUNTIME_RESULTS.md) measures Counter and Token after fixed-width lowering, including the matched numeric Rust loop and wasm-opt O3. The [frontend comparison](bench/FRONTEND_SPEED_RESULTS.md), [previous Rust comparison](bench/SPEED_RESULTS.md), [older Rust tables](bench/README.md) and [initial isolation report](bench/ISOLATION.md) remain historical records. Fuel and CPU time are separate metrics.
- **Host reads cost one callback per 4 bytes.** That is cheap for storage values but would add up for `transaction()`/`block()` on large blocks.
- **Determinism** needs a proper audit before anything holds value. Known so far: floats in wasmi are software-deterministic, `Map` iteration is insertion-ordered, the clock reads 0, and randomness traps. Not yet audited: the rest of the scriptc runtime, such as hashing and GC timing.
- **Actual runtime coverage:** CappedToken tests deployment envelopes, initialization rollback, standard-auth opcode 1, real UTXO balances, cap/u128 boundaries, reentry, caller/callee rollback and callback cache invalidation through the unmodified indexer. Counter and Token add wide increments/mints, checked loops, storage fill, height, caller ownership and cross-contract data/rollback. `delegatecall`/`staticcall` still need canonical-runtime integration coverage. The JS VM and wasmi harness now follow canonical balance movement (credit, debit, self-mint, per-entry transfers) and the 8e8 precompiles, but the custody contracts have not yet run on the canonical indexer. Production RPC/wallet/PSBT adapters and a live Bitcoin-node deployment remain follow-up work.

## Layout

```
sdk/                TypeScript contract SDK (compiled into every contract)
compiler/           restricted class frontend, effect checks and client generator
client/             off-chain client encoding and simulation transport interface
contracts/          example contracts
shim/               adapter + WASI stand-ins in WebAssembly text, C SDK leaves, minimal printf
scripts/build.mjs   build pipeline (link.mjs: SCRIPTC_LINKER wrapper; printf-formats.mjs: format check)
test/               JS alkanes host model and contract tests
integration/        actual upstream indexer tests, pinned dependencies and results
harness/            Rust wasmi 0.37.2 host model: wasmi-check runner and bench
bench/              Rust twins of the examples and the alkanes-rs comparison
```

The [native scriptc Counter prototype](patches/scriptc/README.md) applies an upstream-oriented patch to scriptc 0.4.2 to emit the Alkanes ABI and checked u128 without our C SDK. Its [actual-runtime comparison](bench/NATIVE_COUNTER_RESULTS.md) includes both C-SDK releases, a compiler-coercion ablation, and optimized Rust. This remains an opt-in Counter backend.
