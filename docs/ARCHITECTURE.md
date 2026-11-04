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

- **`sdk/`** is the contract-side library. It implements the alkanes wire types (`AlkaneId`, `Cellpack`, `Context`, `CallResponse`, transfer parcels), a storage write cache that is returned with the response the way `alkanes-runtime` does it, `StoragePointer`, chain queries, extcalls, and opcode dispatch with `__meta` ABI generation. Public u128 values are `bigint`s. Eligible contracts use compiler-private word handles and `shim/word.c`, compiled into the same metered Wasm module; their generated adapter comes from `compiler/word-abi.mjs`.
- **`shim/adapter.wat`** implements `__execute` and `__meta`. It initializes the reactor, loads the context, calls the scriptc export, and copies the result into arraybuffer layout. It also implements each `__alk_*` callback on top of the matching `env.*` host function. Host results that are bytes go into a scratch buffer that the SDK reads back 4 bytes per callback. Since scriptc rejects reentry, buffers created inside callbacks come from an arena that the adapter grows with `memory.grow`.
- **`shim/wasi.wat`** satisfies the runtime's WASI imports deterministically: no environment, a clock fixed at 0, `stdout` routed to `__log`, and `random_get` traps.
- **`shim/printf.c`** replaces wasi-libc's `vsnprintf`/`snprintf`, which the scriptc runtime uses only for a few trap and RangeError messages. libc's version brings musl's whole printf engine (about 12 KB of code after optimization, including 128-bit soft-float for `%f`/`%g`). The replacement is musl's integer/string subset (`d i o u x X c s p %`, all flags, widths, precisions and integer length modifiers) and traps on the rest. `scripts/link.mjs`, set as `SCRIPTC_LINKER`, links it ahead of libc and runs `scripts/printf-formats.mjs` on the named link output: every format reaching it must be a constant string in the supported subset, following pass-through wrappers such as `scr_trap_fmt`. Otherwise it relinks with libc's printf, as for bigint-path contracts, which reach `%.17g`. `test/printf.test.mjs` compares it with libc in Wasm over about 57,000 formats; `--libc-printf` builds the previous linkage. Benchmark and baseline builds use the same link step, so reproducing a binary from an earlier report needs `buildLibrary({ printf: "libc" })`.
- The build fails if the final module imports anything outside `env` or exports anything besides `memory`, `__execute` and `__meta`.

Reverts follow `alkanes-runtime`: a thrown `Error` calls `env.abort` and returns data prefixed with the `0x08c379a0` selector, which the indexer reports as `ALKANES: revert: Error: <message>` and rolls back.

## Repository layout

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
