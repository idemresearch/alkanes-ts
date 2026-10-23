# scriptc 0.4.2: native Alkanes Counter prototype

The patch is based on upstream v0.4.2, commit `4d049fbb8cc719e20cb52cd444b0d54db89f638a`, released October 22, 2026. It is a proposal for upstream review, not an upstream release or a submitted PR. No permanent fork is required to reproduce it.

## What belongs upstream

`0.4.2-alkanes.patch` adds opt-in, strictly validated Wasm library callback bindings. A binding can name a host import module/name or a compiler intrinsic. Intrinsics provide raw memory operations, arena allocation, checked unsigned 128-bit add/subtract/multiply, comparison, and number conversion. Arithmetic consumes addresses of immutable, little-endian words and writes to an explicit result address. Add/subtract use LLVM overflow intrinsics; multiplication uses unsigned scalar limbs. These operations do not change JavaScript bigint semantics. Scalar address/value arguments retain ToUint32 semantics, including the generic fallback for negative, nonfinite and out-of-range numbers.

`wasm_abi: "alkanes-v1"` requires `execute(bytes): f64` and `meta(): bytes`, emits the zero-argument `__execute`/`__meta` entries, initializes the reactor once, handles context buffers, and binds panic delivery to Alkanes logging/abort. The f64 internal return transports an exact u32 address; the public `__execute` result is i32. Profile export aliases are resolved before ABI emission. Other targets reject these Wasm-only options. Ordinary profiles remain on the existing path.

The patch contains no Counter selectors, storage keys, loops, or business rules. It includes focused profile/emitter tests. The full upstream native/sanitized/Sandbox and zero-cost gates are still required before upstream acceptance; local Counter integration tests do not replace those gates.

## What stays in alkanes-ts

The existing checked class frontend still compiles the unchanged `contracts/counter/index.ts`, including its static dispatch, persistent fields, checked operators, and views. `sdk/native-counter.ts` supplies the experimental TypeScript storage cache, context parsing and response serialization. The new build explicitly rejects tracked assets, init-runtime contracts, and contracts that do not reject incoming assets; unsupported SDK imports fail compilation. It is a Counter-first subset, not a replacement for the complete Token/CappedToken SDK.

This path does not compile or link `shim/word.c`, `shim/word-sdk.c`, or the ABI adapter WAT. scriptc's own runtime, its compiler support routines, and the deterministic WASI stand-ins remain. The final module has only `env.*` function imports and `memory`, `__execute`, `__meta` exports. Wasmi/actual-runtime tests establish compatibility without SIMD.

This is a historical experiment from revision aa4baa1. At that revision the normal build used stock scriptc 0.4.0, and an isolated 0.4.2 toolchain supplied the patched prototype and release-only control. The current normal build uses stock 0.4.2 with the C SDK; its [qualification](../../bench/STOCK_0_4_2_RESULTS.md) applies no compiler patches. Reproduce this experiment and its original version labels from aa4baa1.

## Reproduce

Requirements are the repository's Node 24, Zig/Binaryen/Rust toolchains and the recorded Alkanes checkout. Start with the normal builds: `npm ci`, `npm run build`, `npm run build:bench:rust`, and `npm run build:bench:capped`.

```sh
npm run setup:native
npm run check:upstream-patch
node scripts/native/build-ablation.mjs
npm run test:native
ALKANES_RS=/path/to/alkanes-rs node integration/run.mjs --native-counter
ALKANES_RS=/path/to/alkanes-rs npm run bench:native -- --iterations 30
```

`setup.mjs` checks the exact upstream revision, installs the isolated lockfile, and applies the patch idempotently. The compiler runner recompiles the changed TypeScript compiler modules over the exact matching published compiler package. It uses the public `compileLibrary` API and the published 0.4.2 runtime pack, so it does not require rebuilding scriptc's packaged native CLI. Compilation output preserves the LLVM translation unit and IR in `build/scriptc-native/` for inspection.

The coercion ablation recompiles that same compiler with only its native-binding ToUint32 fast-path selection disabled. It retains exactly the same SDK, checked arithmetic, ABI, and optimization settings. This separates compiler marshalling cost from the remaining SDK/ABI implementation differences. The broader C-SDK-versus-native difference remains a combined measurement, not a pure additive compiler tax.

Results and artifact hashes are recorded in `bench/NATIVE_COUNTER_RESULTS.md` and `integration/NATIVE_COUNTER_RESULTS.md`.

## Measured result and validation

Across the seven ordinary Counter call scenarios, the native path uses 6–19% less fuel than the current 0.4.0 C SDK and 16–56% less than Rust O3/LTO plus wasm-opt. Median indexer time is 6–12% lower than that Rust build, but 2–14% higher than the current C SDK. The native binary is 118,814 bytes versus 110,779 for the current C SDK and 114,541 for the 0.4.2 C SDK. This fuel improvement does not establish an elapsed-time improvement over the C SDK; compilation/instantiation cost remains a target for further work.

The release-only upgrade changes increment fuel from 26,680 to 26,826. Replacing the SDK/ABI with the generic-coercion native path reduces it to 25,885; the compiler coercion optimization reduces it again to 22,861. On fill(10), generic coercion costs 88,125 fuel; the optimized compiler consumes 66,833, a reduction of 21,292 fuel (24.2%). The same-release C SDK consumes 74,340. These controls expose the compiler marshalling bottleneck without attributing every SDK/ABI difference to scriptc itself.

Local validation: the complete compiler source type-check; 12 focused upstream tests, including the IR string-field classification gate; upstream formatting/lint for changed files; 44 existing alkanes-ts regression tests; three native tests covering Counter parity, wide checked arithmetic/rounding, and ToUint32 slow-path behavior; ten actual-runtime integration tests; and 30 measured benchmark repetitions after three warmups. Compiling the ordinary C-SDK 0.4.2 profile through the patched compiler produces byte-identical LLVM to the unpatched release. This is a focused compatibility check, not the full upstream zero-cost gate.
