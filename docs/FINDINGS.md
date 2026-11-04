# Findings and open questions

What the experiment has shown so far, and what it has not. Benchmark methodology
and every saved report are indexed in [Benchmarks](BENCHMARKS.md).

- **What compiles:** scriptc handled everything the SDK needed, including classes, closures, `bigint` arithmetic for u128, `Map`, `Uint8Array`, `DataView`, `TextEncoder`/`TextDecoder`, `JSON.stringify` and try/catch. Two rough edges: `number.toString(radix)` is refused, and indexing a `bigint[]` is typed `bigint | undefined`, which is why handlers get an `Inputs` wrapper.
- **Engine compatibility:** the output uses only bulk-memory, sign-ext, saturating float-to-int and mutable globals, all supported by wasmi 0.37 (no SIMD). The build pins wasm-opt to those features.
- **Size:** including the scriptc runtime:
  - Counter: 85 KB raw / 41 KB gzipped
  - CappedToken: 70 KB / 36 KB
  - Token: 93 KB / 44 KB
  - AmmPool: 86 KB / 40 KB
  - ShareVault: 91 KB / 42 KB
  - TimelockTreasury: 83 KB / 39 KB
  - AmmRouter: 71 KB / 36 KB

  The optimized Rust twins built against rc.4 are 123 KB, 134 KB and 130 KB. The vault, treasury and router were 320–343 KB on the general bigint backend before [word lowering](WORD_LOWERING.md#chain-queries-and-external-calls) took over their chain queries and external calls. That also cut their fuel by 68–92% ([report](../bench/ADVANCED_WORD_RESULTS.md)).
- **Shadow stack:** `scripts/link.mjs` links contracts with a 1 MiB stack, the size Rust uses. Zig's default for wasm32 is 16 MiB, which gave every instance about 17 MB of initial memory and made each Counter/Token call about 2.5 ms slower on the canonical indexer ([report](../bench/CANONICAL_STACK_SIZE_RESULTS.md)). The stack stays first, so an overflow traps. `buildLibrary({ stackSize: null })` keeps the toolchain default.
- **Fuel:** on the canonical indexer of the latest alkanes-rs release (v3.0.0-rc.4), including host and storage charges, TS uses less fuel than Rust O3/LTO plus wasm-opt:
  - 4.5–5.6× less for single Counter and Token operations;
  - 3.7× less for a cross-contract call;
  - 1.5–2.5× less for loop-bound calls;
  - 10–11× less for CappedToken views;
  - 2.4× less for an authenticated mint.

  | Call | TS | Rust |
  |---|---:|---:|
  | Counter read | 9,011 | 45,734 |
  | Counter increment | 11,862 | 53,254 |
  | Token mint | 13,706 | 77,287 |
  | CappedToken supply view | 5,175 | 54,730 |
  | CappedToken mint with auth | 86,925 | 206,942 |

  Sources: [Counter/Token](../bench/CANONICAL_V3_EXAMPLES.md) and [CappedToken](../bench/CANONICAL_V3_CAPPED_TOKEN.md) on rc.4. The earlier pinned revision f9446fd gives similar ratios ([Counter/Token](../bench/CANONICAL_EXAMPLES_0.4.7.md), [CappedToken](../bench/CANONICAL_CAPPED_TOKEN_0.4.7.md)). Most of the reduction comes from the [initialization snapshot](SNAPSHOT.md) and from hoisting literals into it; the [scriptc 0.4.7 comparison](../bench/SCRIPTC_047_RESULTS.md) breaks it down by variant. The [frontend comparison](../bench/FRONTEND_FUEL_RESULTS.md), [codec report](../bench/SDK_OPTIMIZATION_RESULTS.md) and [execution report](../bench/EXECUTION_RESULTS.md) record earlier optimization passes. Bigint-heavy loops remain expensive; Counter uses numbers only within a proven exact range.
- **Execution speed:** on rc.4, blocks take less time with TS than with Rust O3/LTO plus wasm-opt:
  - single Counter and Token operations: 14–18% less (12.5–13.5 ms against 15.2–15.9 ms);
  - CappedToken views: 27–28% less;
  - authenticated mints: 13–14% less;
  - a cross-contract call: 6% less.

  The same reports have the per-scenario times. The 1 MiB contract stack accounts for much of this ([stack report](../bench/CANONICAL_STACK_SIZE_RESULTS.md), measured on f9446fd). On this 4-vCPU VM a fixed cost of about 11–13 ms per block dominates. The earlier [canonical-runtime comparison](../bench/EXAMPLES_RUNTIME_RESULTS.md), [frontend comparison](../bench/FRONTEND_SPEED_RESULTS.md), [previous Rust comparison](../bench/SPEED_RESULTS.md), [older Rust tables](../bench/README.md) and [initial isolation report](../bench/ISOLATION.md) remain historical records. Fuel and CPU time are separate metrics.
- **Host reads cost one callback per 4 bytes.** That is cheap for storage values but would add up for `transaction()`/`block()` on large blocks.
- **Determinism** needs a proper audit before anything holds value. Known so far: floats in wasmi are software-deterministic, `Map` iteration is insertion-ordered, the clock reads 0, and randomness traps. Not yet audited: the rest of the scriptc runtime, such as hashing and GC timing.
- **Actual runtime coverage:** CappedToken tests deployment envelopes, initialization rollback, standard-auth opcode 1, real UTXO balances, cap/u128 boundaries, reentry, caller/callee rollback and callback cache invalidation through the unmodified indexer. Counter and Token add wide increments/mints, checked loops, storage fill, height, caller ownership and cross-contract data/rollback. The custody contracts run there too, with custody read from the indexer's balance table:
  - AmmPool deposits, swaps and redemptions, and AmmRouter two-hop routes;
  - ShareVault and TimelockTreasury authenticated with the upstream auth token, including vesting, the withdrawal window and expiry.

  On v3.0.0-rc.4, a vault deposit costs 17,445 fuel, a pool swap 19,251 and a two-pool route 51,474 ([record](../integration/CUSTODY_RESULTS_V3.md)). `delegatecall`/`staticcall` still need canonical-runtime integration coverage. The JS VM and wasmi harness now follow canonical balance movement (credit, debit, self-mint, per-entry transfers) and the 8e8 precompiles. Production RPC/wallet/PSBT adapters and a live Bitcoin-node deployment remain follow-up work.
