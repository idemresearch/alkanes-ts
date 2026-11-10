# Architecture

How a TypeScript contract becomes an Alkanes Wasm module, and where each piece
of the build lives.

## The build

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

The compiler, `@scriptc/runtime-wasm32-wasi` and `@scriptc/types` are pinned together, currently at 0.4.10.

- **`sdk/`** is the contract-side library. It implements the alkanes wire types (`AlkaneId`, `Cellpack`, `Context`, `CallResponse`, transfer parcels), a storage write cache that is returned with the response the way `alkanes-runtime` does it, `StoragePointer`, chain queries, extcalls, and opcode dispatch with `__meta` ABI generation. Public u128 values are `bigint`s. Eligible contracts use compiler-private word handles and `shim/word.c`, compiled into the same metered Wasm module; their generated adapter comes from `compiler/word-abi.mjs`.
- **`shim/adapter.wat`** implements `__execute` and `__meta`. It initializes the reactor, loads the context, calls the scriptc export, and copies the result into arraybuffer layout. It also implements each `__alk_*` callback on top of the matching `env.*` host function. Host results that are bytes go into a scratch buffer that the SDK reads back 4 bytes per callback. Since scriptc rejects reentry, buffers created inside callbacks come from an arena that the adapter grows with `memory.grow`.
- **Callback arguments** declared `u32` are converted by scriptc with an out-of-line `ToUint32` before every call, even for constants. The build profile therefore declares them `f64`, which scriptc passes unchanged, and the adapter converts them inline: a truncation and a comparison for an exact u32, the same `ToUint32` otherwise (`U32_CONVERSION` in `compiler/word-abi.mjs`; `test/word-abi.test.mjs` compares it with JavaScript's `>>> 0`). This removed 7–29% of the fuel of ordinary calls ([report](../bench/SCRIPTC_0410_RESULTS.md)).
- **`shim/wasi.wat`** satisfies the runtime's WASI imports deterministically: no environment, a clock fixed at 0, `stdout` routed to `__log`, and `random_get` traps.
- **`shim/printf.c`** replaces wasi-libc's `vsnprintf`/`snprintf`, which the scriptc runtime uses only for a few trap and RangeError messages. libc's version brings musl's whole printf engine (about 12 KB of code after optimization, including 128-bit soft-float for `%f`/`%g`). The replacement is musl's integer/string subset (`d i o u x X c s p %`, all flags, widths, precisions and integer length modifiers) and traps on the rest. `scripts/link.mjs`, set as `SCRIPTC_LINKER`, links it ahead of libc and runs `scripts/printf-formats.mjs` on the named link output: every format reaching it must be a constant string in the supported subset, following pass-through wrappers such as `scr_trap_fmt`. Otherwise it relinks with libc's printf, as for bigint-path contracts, which reach `%.17g`. `test/printf.test.mjs` compares it with libc in Wasm over about 57,000 formats; `--libc-printf` builds the previous linkage. Benchmark and baseline builds use the same link step, so reproducing a binary from an earlier report needs `buildLibrary({ printf: "libc" })`.
- The build fails if the final module imports anything outside `env` or exports anything besides `memory`, `__execute` and `__meta`.

## Rebuilds, parallel builds and named modules

- **Unchanged builds are skipped.** `buildLibrary` hashes everything that decides its output: the entry module and every file it imports, the pipeline's scripts and shims, the options, the toolchain versions (Node.js, Zig, scriptc, the runtime pack, Binaryen) and the `SCRIPTC_*` environment variables. The hash is stored beside the intermediates as `build/<name>/<name>.wasm.stamp.json`. When it matches and the output still has the recorded SHA-256, the build prints its usual line ending in `unchanged` and returns the recorded result. `--force`, `ALKANES_NO_CACHE=1` or `buildLibrary({ cache: false })` rebuilds. Tests and benchmark builders go through `buildLibrary`, so their fixtures are skipped the same way; `test/build-cache.test.mjs` covers what invalidates a stamp.
- **Shims are assembled once.** The assembled adapter, WASI stand-ins and compiled `shim/word.c` depend only on their source and the toolchain, so they are kept in `build/cache/` under a hash of both and copied into each work directory.
- **Contracts build in parallel.** `npm run build` starts one process per contract, one per CPU by default (`--jobs <n>`), and prints each contract's output as a block in the order named. On a 4-vCPU machine a clean build of the seven examples takes about 21 s instead of 55 s, and a rebuild with nothing changed about 4 s, which is the frontend's type check.
- **`build/<name>/named.wasm`** is the shipped module with its function names. Every step carries the names (`-g`) and the last one removes them, so the two files have identical code. `npm run size -- <name>` lists the largest functions; with two arguments, either contract names or `.wasm` paths, it lists the functions that differ. That is how the 0.4.10 size increase was attributed to the runtime's reference-counting functions.
- **Toolchain problems are reported by name**: a Node.js older than 24, a missing Zig (`ALKANES_ZIG` names another executable), or a runtime pack at a different version than the compiler.

Reverts follow `alkanes-runtime`: a thrown `Error` calls `env.abort` and returns data prefixed with the `0x08c379a0` selector, which the indexer reports as `ALKANES: revert: Error: <message>` and rolls back.

## Repository layout

```
sdk/                TypeScript contract SDK (compiled into every contract)
compiler/           restricted class frontend, effect checks and client generator
client/             off-chain client encoding and simulation transport interface
contracts/          example contracts
shim/               adapter + WASI stand-ins in WebAssembly text, C SDK leaves, minimal printf
scripts/build.mjs   build pipeline (link.mjs: SCRIPTC_LINKER wrapper; printf-formats.mjs: format check)
scripts/size.mjs    code size by function, from build/<name>/named.wasm
test/               JS alkanes host model (vm.mjs; source.mjs runs contracts from source) and contract tests
integration/        actual upstream indexer tests, pinned dependencies and results
harness/            Rust wasmi 0.37.2 host model: wasmi-check runner and bench
bench/              Rust twins of the examples and the alkanes-rs comparison
```
