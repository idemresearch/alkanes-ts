# Fixed-width lowering

CappedToken keeps the same authored TypeScript and scriptc 0.4.0. The compiler now selects a fixed-width path for an eligible contract instead of representing every on-chain integer as a JavaScript bigint at runtime. The [isolation report](../bench/CAPPED_TOKEN_ISOLATION_RESULTS.md) and [canonical-runtime comparison](../bench/CAPPED_TOKEN_OPTIMIZATION_RESULTS.md) record the measured results and artifact hashes.

This changes representation and SDK implementation. It does not remove initialization, checked arithmetic, views, auth verification or asset accounting.

## Measured bottleneck and result

The SDK-free scriptc/bridge control consumes 3,758 initialization fuel and 4,099 warm empty-call fuel. Adding the existing empty SDK pipeline raises these to 8,600 and 23,518 respectively. This isolates a substantial SDK-linked cost, but does not assign every compiled instruction to an additive compiler/SDK bucket.

Replacing map bookkeeping and codecs reduces CappedToken's isolated mint fuel from 230,732 to 164,965, while compilation remains around 2.44 ms versus 2.56 ms initially. Changing Binaryen to O3 barely helps fuel and increases module size. The larger bottleneck is the representation and linked SDK/runtime feature graph. Fixed-width lowering reduces compilation to 0.83 ms, startup to 3,762 fuel and isolated mint execution to 104,618 fuel. The isolated mint export takes 181 µs versus 494 µs before and 250 µs for optimized Rust.

The final canonical-runtime run uses 30 measured repetitions after three warmups per variant:

| Call | TS fuel | Optimized Rust fuel | TS median | Optimized Rust median |
|---|---:|---:|---:|---:|
| Authenticated mint | 108,865 | 197,787 | 5.71 ms | 6.90 ms |
| Mint `(1 << 96) + 5` | 108,883 | 199,112 | 5.70 ms | 6.89 ms |
| Supply view | 19,978 | 51,454 | 2.31 ms | 3.39 ms |
| Authority view | 20,626 | 51,240 | 2.22 ms | 3.33 ms |
| Cap view | 19,306 | 51,209 | 2.15 ms | 3.33 ms |

Authenticated mint consumes 45% less fuel and takes 17% less time than Rust O3/fat-LTO plus wasm-opt O3 on this machine. Relative to the original TS build, it consumes 57% less fuel and takes 43% less time. The production module is 107,660 bytes versus 242,080 before and 133,105 for optimized Rust. This demonstrates the CappedToken workload and accepted lowering subset, rather than a general TypeScript-versus-Rust language result.

## Execution path

1. The existing frontend type-checks the original source and validates opcodes, keys, required state initialization and view effects.
2. `compiler/word.mjs` accepts a deliberately narrow AST subset. It emits TypeScript methods whose u128 values are immutable handles into invocation memory. scriptc compiles those methods and their dispatch. Parameter decoding and storage/asset operations use compiler-private SDK calls.
3. `shim/word.c` implements those SDK leaves with fixed-width unsigned 128-bit values. Zig compiles it to Wasm; the build merges it with the scriptc module and ABI adapter. It contains no CappedToken selectors, cap rule or supply-update method.
4. Alkanes executes the resulting single Wasm module. All helper instructions remain inside its normal wasmi fuel metering. The only external imports are the canonical `env` functions.

The private handles cross scriptc's scalar callback ABI as exact 32-bit addresses. They are not floating-point representations of token values. On-chain values retain all 128 bits; public contract types and generated clients still use bigint and `{ block, tx }` IDs.

The manifest reports `lowering: "word-v1"` or `"bigint"`. `compileContract({ ..., wordLowering: true })` requests this optimization; an unsupported construct selects the general backend for the whole contract. `wordLowering: false` builds the bigint reference. Internal compiler faults are errors rather than silent fallback.

## Current eligibility

The `word-v1` path supports typed u128/AlkaneId state, explicit initialization and entrypoints, bigint literals, checked `+`/`-`, comparisons and boolean conditions, simple local constants/variables, field assignments, if/else, literal assertions/errors, `this.auth.require`, and `this.assets.mintSelf`. It supports primitive/ID/void ABI results and full-width selectors.

That narrow path requires imports from the authoring entry point and has no ordinary instance fields or helper methods. A second [word SDK path](EXAMPLES_OPTIMIZATION.md), `word-sdk-v1`, adds Counter and static fluent Token support: loops, helpers, checked multiplication, raw storage, context IDs, byte responses, logging and calls with literal fuel limits. Unsupported operations, including division, wrapping/wide helpers and exception recovery, retain the general checked bigint backend. Eligibility is conservative and applies to the whole contract.

An uncaught failure latches the first error and produces the same Alkanes revert protocol. This is valid for the accepted subset because it cannot catch or inspect intermediate exceptions. Source that does so remains on the general backend. Scope and statement boundaries are preserved; source names cannot collide with compiler-private identifiers.

## SDK behavior

The native-width SDK parses the canonical context, stores immutable words, and caches storage reads and writes by byte key. Only dirty entries enter checkpoints/responses. Successful auth calls clear that cache because the host commits the checkpoint and may execute callbacks.

Incoming assets and successful call returns feed a checked ledger. Auth requires a positive unit in the original incoming parcel and an available unit in the ledger. External authorities receive opcode 1 with exactly one unit; their returned data must be `[1]`, and their actual returned transfers are credited. The standard auth binary used here returns two units. Self issuance cannot manufacture incoming auth proof. The self-auth branch does not call another contract.

Initialization and mutation locks retain the reserved keys and wire values of the general backend. Failed initialization, reentry, auth, cap checks and arithmetic abort through the canonical host, which rolls back caller/callee state and assets. Views reject incoming assets and persistent writes. Untracked forwarding preserves the original parcel, including duplicate/zero entries; tracked forwarding normalizes balances.

The adapter owns invocation buffers, SDK structures and a separate 4 KiB C stack. The helper call graph is bounded and nonrecursive; source recursion is outside this path. Native SDK imports share the contract memory, and the build rejects helper data segments to prevent overlap with scriptc's static data. This follows Alkanes' fresh-instance-per-invocation execution model.

## Verification and reproduction

`npm test` builds both representations of a separate contract probe and compares their Wasm responses/storage across defaults, wide IDs, carries/borrows, overflow/underflow, intermediate failures, immutable captured values, selectors, malformed state, forwarding and rollback. The canonical suite additionally exercises standard auth, self auth, forged proof, reentry, Bitcoin output balances and deployment rollback.

```sh
npm run typecheck
npm test
ALKANES_RS=/path/to/alkanes-rs npm run test:runtime
ALKANES_RS=/path/to/alkanes-rs npm run build:bench:capped-opt
npm run bench:capped-opt
ALKANES_RS=/path/to/alkanes-rs npm run bench:capped -- \
  --iterations 30 --baseline dist/capped-opt/bigint-production.wasm \
  --output bench/CAPPED_TOKEN_OPTIMIZATION_RESULTS.md
```

Use the upstream/toolchain versions recorded in the reports. The isolation suite separates module compilation, instance setup, scriptc initialization and export execution, and includes SDK-free/empty-SDK controls plus SDK algorithm variants. Its host model omits canonical surcharges and balance enforcement; its deltas are not additive percentages of production fuel.

The final comparison runs both TS representations and unchanged Rust O3/LTO plus wasm-opt O3 through `index_block`, with rotating order, three warmups and 30 measured runs. A separate MAX-cap deployment mints `(1 << 96) + 5` so the result does not depend on small-value shortcuts. Fresh deployment timings include chain bootstrap; they do not establish isolated deployment latency.
