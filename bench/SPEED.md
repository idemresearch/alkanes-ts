# Target: faster than Rust

The target is lower instruction fuel **and** lower export execution time on matching contract behavior. Lower fuel alone is insufficient: storage-heavy TypeScript already uses less fuel while taking longer to execute. [Saved measurements](SPEED_RESULTS.md) include the unchanged Rust u128 implementation and a second Rust build given the same numeric fast path as TypeScript.

## Changes

`Contract` dispatch compares bigint opcodes directly instead of constructing decimal strings and building a string-keyed map in each fresh instance. Reverse registration order preserves duplicate opcodes' last-handler behavior and keeps the ABI registration order unchanged. This suits small method tables; lookup is linear in the number of methods. Large tables need separate measurement before adopting this as a scaling solution.

The counter's sum loop uses exact numeric arithmetic for `n <= 300,000`, then converts the result once to bigint for the u128 ABI. Its index stays a signed 32-bit integer. The largest square is 89,999,400,001; the largest sum is 8,999,955,000,050,000, below `Number.MAX_SAFE_INTEGER` (9,007,199,254,740,991). All terms and partial sums are nonnegative integers within the exact range. This retains the loop and does not replace it with a closed form. Larger inputs retain the original checked bigint loop. This is a contract fast path, not a general fixed-width u128 replacement.

The [incremental report](EXECUTION_RESULTS.md) compares the production artifacts from `588dda7` against this pass, with identical caller, sequence, ABI text and response bytes. Each sequence is repeated 20 times. The saved hashes identify the reference artifacts; the [previous codec report](https://github.com/idemresearch/alkanes-ts/blob/588dda7/bench/SDK_OPTIMIZATION_RESULTS.md) records them independently.

## Rust comparison

Run `ALKANES_RS=/path/to/alkanes-rs npm run build:bench:rust`. The builder reads the upstream pinned toolchain and lockfile, generates two comparison crates under `build/rust-comparison`, and leaves the upstream checkout untouched. It uses release opt-level 3, fat LTO and one codegen unit. The original u128 build goes to `bench/dist`; a feature adds the same exact numeric loop and fallback to the second build under `bench/dist/numeric-fast-path`. Source for that addition is `bench/rust/numeric-fast-path.rs`.

Run `npm run build`, then `npm run bench:speed -- --output bench/SPEED_RESULTS.md`. The report records the upstream revision, lockfile hashes, toolchain, machine and artifact hashes. It compares all original scenarios, then repeats arithmetic scenarios against the matched numeric Rust build. The runner checks full responses, transfers and storage across languages and on every repetition. ABI formatting/schema text and the known unknown-opcode message differences are allowed explicitly. Tests separately check exact sum values at the fast-path boundary and just above it, bigint overflow, duplicate registration, large opcodes and fallback arguments.

By default, timing excludes the host's 512-page growth so it reflects contract execution. `--grow` includes that setup in the separate instantiation column. Each execution still gets a fresh instance, matching the host model. Wall times are local measurements, not production indexer latency; host surcharges and alkane balance enforcement remain outside this harness.

The numeric path beats the original Rust u128 loop for sum(10,000). Rust given the same fast path remains faster. Ordinary TypeScript calls also remain slower in wall time. The next work is to reduce context parsing, response allocation and runtime initialization overhead, and validate those changes against the matched Rust build. The current result does not establish that scriptc is generally faster than Rust.
