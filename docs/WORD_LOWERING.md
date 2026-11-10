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

The private handles cross scriptc's scalar callback ABI as exact 32-bit addresses. They are not floating-point representations of token values. The build profile declares them `f64` and the adapter converts each one to the u32 the word SDK takes, because scriptc's own conversion of a `u32` argument is an out-of-line `ToUint32` on every call ([report](../bench/SCRIPTC_0410_RESULTS.md)); the adapter's conversion gives the same result for every double. On-chain values retain all 128 bits; public contract types and generated clients still use bigint and `{ block, tx }` IDs.

The manifest reports `lowering: "word-v1"` or `"bigint"`. `compileContract({ ..., wordLowering: true })` requests this optimization; an unsupported construct selects the general backend for the whole contract. `wordLowering: false` builds the bigint reference. Internal compiler faults are errors rather than silent fallback.

## Current eligibility

The `word-v1` path supports typed u128/AlkaneId state, explicit initialization and entrypoints, bigint literals, checked `+`/`-`, comparisons and boolean conditions, simple local constants/variables, field assignments, if/else, literal assertions/errors, `this.auth.require`, and `this.assets.mintSelf`. It supports primitive/ID/void ABI results and full-width selectors.

That narrow path requires imports from the authoring entry point and has no ordinary instance fields. A second [word SDK path](EXAMPLES_OPTIMIZATION.md), `word-sdk-v1`, adds Counter and static fluent Token support: loops, helpers, checked multiplication, raw storage, context IDs, byte responses, logging and calls with literal fuel limits. Unsupported operations, including wrapping helpers, shifts and exception recovery, retain the general checked bigint backend. Eligibility is conservative and applies to the whole contract.

### Custody and wide arithmetic

`word-v1` also accepts the constructs used by custody contracts such as [AmmPool](../contracts/amm-pool/index.ts): checked `*`, `/` and `%`, with the [exact product](AUTHORING.md#defined-semantics) for `a * b / d`, `a * b % d` and `sqrt(a * b)`; unaliased imports of `mulDiv`, `mulDivUp`, `mulMod`, `mulSqrt`, `sqrt`, `min` and `max` from `sdk/u128.ts`; `this.assets.received/held/retain/send`; `this.context.myself`; ternaries of matching type; boolean `===`/`!==`; reassignment of `let` locals (including `+= -= *= /= %=`); and calls to undecorated helper methods whose declared parameters are u128/AlkaneId/boolean and whose result is u128/AlkaneId/boolean/void. Recursive helper graphs, aliased or other `u128.ts` imports, parameter reassignment and calls between exposed methods stay on the general backend.

`shim/word.c` implements these leaves without compiler-rt: 128-bit values are split into 32-bit limbs, products are exact 256-bit schoolbook results, quotients use Knuth's algorithm D with native i64 division, and `mulSqrt`/`sqrt` run Newton's method from an upper bound on the exact product. Custody follows `sdk/assets.ts` exactly: `received` sums the original incoming parcel, `held` is host `balance(myself, id)` (zero-extended like `bytesToU128`) minus the ledger, ledger lookups never insert entries, and `retain`/`send` insert at the end so the response order matches the bigint ledger's first-insertion order. The new errors (`u128 division by zero`, `INSUFFICIENT_LEDGER`, `INSUFFICIENT_CUSTODY`, `SELF_CUSTODY_UNSUPPORTED`, `SELF_SEND_USE_MINT_SELF`) are emitted only for contracts that can raise them.

These operations use a separate `w_op3` leaf rather than extending `op()`. wasmi charges each call for its callee's register frame, and Binaryen inlines single-caller helpers, so wide code reachable from `op()` would tax every comparison and addition; keeping it apart leaves CappedToken, Counter and Token byte-identical. `test/word-custody.test.mjs` and `test/word-math.test.mjs` compare both backends call for call (responses, revert messages, storage and balances), and check the C leaves directly against BigInt.

### Chain queries and external calls

`word-v1` also lowers [ShareVault](../contracts/share-vault/index.ts), [TimelockTreasury](../contracts/timelock-treasury/index.ts) and [AmmRouter](../contracts/amm-router/index.ts). It accepts `height()` imported from `sdk/runtime.ts` or `sdk/index.ts`. It accepts the `AlkaneId`, `Cellpack` and `AlkaneTransferParcel` constructors imported from `sdk/types.ts` or `sdk/index.ts`. It also lowers `a.equals(b)` on IDs, `new AlkaneId(block, tx)`, `this.assets.available(id)`, and `this.assets.call(new Cellpack(target, [u128, ...]), new AlkaneTransferParcel().pay(id, amount)..., fuel)`. The call must be a statement whose response is unused, and the fuel limit must be an integer literal. Imports must be unaliased named value imports, and no parameter or local may shadow an imported name.

Two new leaves implement these, so the existing leaves are unchanged:

- `w_query` reads the height (the host's u64, zero-extended like `bytesToU128`) and, for `available`, the ledger amount. That lookup never inserts an entry.
- `w_extcall` fills a call builder after every argument has been evaluated in JavaScript order, then follows `sdk/assets.ts` `Assets.call`:
  1. the view check;
  2. `PRECOMPILE_TAKES_NO_ASSETS` for a precompile target with transfers;
  3. an in-order checked debit of each transfer from the ledger;
  4. one host call with the dirty-entry checkpoint;
  5. response handling as in `sdk/runtime.ts`. A revert carrying the revert selector and a message reports `Extcall failed: <message>`; any other revert reports `Extcall failed (no details available)`. A successful call clears the storage cache unless the target is a precompile, and the returned assets are credited to the ledger.

Auth uses the same host-call path. That also fixed two auth revert messages that differed from the bigint backend: revert data that is only the selector, and revert data without one. The canonical host never produces either, because it always reverts with `ALKANES: revert: ...`. One difference remains: both word paths copy a callee's revert message as raw bytes. The bigint backend decodes it as UTF-8 and encodes it again, so only invalid UTF-8 in a callee's message would come out differently. `test/word-advanced.test.mjs` runs the three contracts on both backends call for call, including the auth modes, a reentrant authority, uninitialized, empty, missing and hostile pools, and the vesting and timelock boundaries.

An uncaught failure latches the first error and produces the same Alkanes revert protocol. This is valid for the accepted subset because it cannot catch or inspect intermediate exceptions. Source that does so remains on the general backend. Scope and statement boundaries are preserved; source names cannot collide with compiler-private identifiers.

## SDK behavior

The native-width SDK parses the canonical context, stores immutable words, and caches storage reads and writes by byte key. Only dirty entries enter checkpoints/responses. Successful auth calls clear that cache because the host commits the checkpoint and may execute callbacks.

Incoming assets and successful call returns feed a checked ledger. Auth requires a positive unit in the original incoming parcel and an available unit in the ledger. External authorities receive opcode 1 with exactly one unit; their returned data must be `[1]`, and their actual returned transfers are credited. The standard auth binary used here returns two units. Self issuance cannot manufacture incoming auth proof. The self-auth branch does not call another contract.

Initialization and mutation locks retain the reserved keys and wire values of the general backend. Failed initialization, reentry, auth, cap checks and arithmetic abort through the canonical host, which rolls back caller/callee state and assets. Views reject incoming assets and persistent writes. Untracked forwarding preserves the original parcel, including duplicate/zero entries; tracked forwarding normalizes balances.

The adapter owns invocation buffers, SDK structures and a separate 4 KiB C stack. The helper call graph is bounded and nonrecursive; source recursion is outside this path. Native SDK imports share the contract memory, and the build rejects helper data segments to prevent overlap with scriptc's static data. This follows Alkanes' fresh-instance-per-invocation execution model.

### Constant literals and dispatch

Both word paths hoist pure literals into module constants, one per distinct value: u128 literals, compiler-generated byte strings (storage keys, revert messages, `__meta`), and the backing arrays of source `Uint8Array` literals. Module initialization runs once, and in production at build time through the initialization snapshot, so a use is a global read instead of rebuilding the value on every call. Generated byte constants are filled in place to avoid temporary array garbage in the snapshot. Sharing is unobservable. Word handles and arena buffers are immutable because every SDK leaf allocates its result. Lazy byte objects only cache their arena copy, and the adapter arena is never reset or reused within an instance. Source strings cannot be compared by identity in this subset, and a source `Uint8Array` literal still gets a fresh wrapper on each evaluation. Module initialization gets its own word stack, so C leaves reached from it never run on the linker's default stack pointer.

The word-SDK dispatch omits the frontend's `try`/`finally` read-only reset. The flag lives in the per-invocation context and only storage writes and calls consult it. After dispatch, only response or error serialization runs, and neither consults the flag. Incoming-asset guards read the context's transfer count instead of copying the parcel. Selectors below 2^53 are matched numerically after one `toNumber` conversion. That conversion is exact below 2^53 and maps every larger u128 to at least 2^53, and the invocation cannot have failed at that point because every error-latching SDK call throws immediately. Larger selectors keep the full-width comparison. `test/literals.test.mjs` checks the boundary selectors against the bigint backend on both word paths.

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
