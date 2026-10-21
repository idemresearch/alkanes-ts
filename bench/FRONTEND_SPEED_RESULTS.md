# Rust speed comparison

Machine: Apple M3 Max, darwin arm64. scriptc/runtime 0.4.0; wasmi 0.37.2.

Instruction fuel and median export execution time are separate metrics. Instantiation is shown separately. Every repetition checks fuel, full response (including transfers), and resulting storage. Cross-language checks allow ABI formatting/schema text differences and the documented unknown-opcode message difference. Production host surcharges and alkane balance enforcement are not modeled.

```text
alkanes-rs revision: f9446fdab77cdc12acbc85f8e9c91c9e5ac2f6cb
alkanes-rs tracked changes: no
upstream Cargo.lock SHA-256: 0da32fe8c3a3e794b8aba19c29f6229ceaf7e8dad5b03d54bfe9a829edafaf9a
Rust: rustc 1.86.0 (05f9846f8 2025-03-31)
profile: opt-level=3, lto=fat, codegen-units=1, panic=abort; no wasm-opt
rust-counter.wasm SHA-256: 0d75b2d5be6dfdebf9e3d969bf1c4022d036b139323400e9e131f0e2a7700c0f
rust-token.wasm SHA-256: 7a9ccf1eaf630022b1ae29a47b62119cfd1fd35966b2c5c02feab019b092442e
numeric-fast-path/rust-counter.wasm SHA-256: 65a733c601719cc7cff48a2782e555bf6db201634d1773e28c58637dc14d9d8d
numeric-fast-path/rust-token.wasm SHA-256: c1f690293ad00a8e8c4d3f6199423e8aafd4e212614a35d4b9f82b3d1e3a79cc
comparison Cargo.lock SHA-256: a39226658084ac848cdfb099d0f1e00fd7d5fa0346bbf8d088d86e10eccb4a31
counter.wasm SHA-256: f70906c4e0702661799e068c4b0dd676332f812c394a9e3ba679b37926c7c0c7
token.wasm SHA-256: f220ee3e7c175ecb932207810028df81cda42cc64d5d445e7079020595653cd2
```

# Original Rust u128 loop versus optimized TypeScript

The TS sum uses exact numeric arithmetic up to n=300,000; Rust here retains its original checked u128 loop. This compares the contract implementations, not equally optimized numeric representations.

## Binary size and compile time

Compile time is the median `Module::new` over 200 runs.

| contract | alkanes-rs | alkanes-ts | ratio | rs gzip | ts gzip | ratio | rs compile µs | ts compile µs | ratio |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| counter | 158766 | 224679 | 1.4× | 58782 | 98976 | 1.7× | 1225.2 | 2341.2 | 1.9× |
| token | 171035 | 274249 | 1.6× | 62446 | 115431 | 1.8× | 1313.0 | 2922.9 | 2.2× |

## Per-call cost

Fuel is wasmi instruction fuel (start budget 100000000). Times are medians over 200 runs: *exec* runs the export (nested extcalls included), *inst* instantiates (memory grow skipped: --no-grow).

| scenario | rs fuel | ts fuel | ratio | rs exec µs | ts exec µs | ratio | rs inst µs | ts inst µs | result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| counter `__meta` | 5557 | 12311 | 2.2× | 20.0 | 36.2 | 1.8× | 14.7 | 12.0 | rs: ABI, 630 bytes / ts: ABI, 611 bytes |
| counter initialize | 50456 | 44698 | 0.9× | 44.3 | 128.8 | 2.9× | 13.5 | 12.0 | ok |
| counter increment | 48849 | 49116 | 1.0× | 44.1 | 137.5 | 3.1× | 13.5 | 12.0 | u128 5 |
| counter get_count | 35067 | 38707 | 1.1× | 35.5 | 107.1 | 3.0× | 13.8 | 11.9 | u128 0 |
| counter revert (write, then throw) | 47797 | 48943 | 1.0× | 43.4 | 145.4 | 3.3× | 13.4 | 12.0 | revert "Error: intentional failure" |
| counter get_height + log | 38708 | 43046 | 1.1× | 38.6 | 117.5 | 3.0× | 14.0 | 12.0 | u128 900000 |
| counter unknown opcode | 32833 | 41263 | 1.3× | 36.1 | 120.2 | 3.3× | 13.7 | 11.8 | rs: revert "Error: Unrecognized opcode" / ts: revert "Error: Unrecognized opcode 99" |
| counter sum(n=100) | 33949 | 37336 | 1.1× | 44.9 | 101.0 | 2.2× | 14.1 | 12.0 | u128 328350 |
| counter sum(n=10,000) | 528949 | 86814 | 0.2× | 1269.1 | 219.5 | 0.2× | 15.0 | 12.1 | u128 333283335000 |
| counter fill(n=10) | 147235 | 134185 | 0.9× | 107.1 | 338.6 | 3.2× | 13.4 | 12.2 | ok |
| counter fill(n=1,000) | 13315638 | 9564583 | 0.7× | 10812.8 | 20959.2 | 1.9× | 22.2 | 17.2 | ok |
| token `__meta` | 5669 | 46731 | 8.2× | 22.4 | 112.6 | 5.0× | 15.1 | 14.5 | rs: ABI, 662 bytes / ts: ABI, 647 bytes |
| token initialize | 88391 | 71773 | 0.8× | 70.1 | 193.8 | 2.8× | 13.3 | 14.5 | ok |
| token mint (owner) | 85655 | 70198 | 0.8× | 66.6 | 189.4 | 2.8× | 13.5 | 14.7 | ok |
| token get_name | 40441 | 49277 | 1.2× | 39.5 | 129.7 | 3.3× | 13.9 | 14.5 | "TypeScript Token" |
| token get_total_supply | 47578 | 55702 | 1.2× | 43.7 | 152.2 | 3.5× | 13.6 | 14.6 | u128 1000 |
| token → counter extcall | 110686 | 106142 | 1.0× | 113.9 | 325.1 | 2.9× | 12.4 | 14.6 | u128 41 |
# Rust given the same numeric fast path

Both use exact numeric squares and accumulation for n ≤ 300,000, convert once at the boundary, and retain the u128/bigint loop above that bound. Only arithmetic scenarios are repeated here.

## Binary size and compile time

Compile time is the median `Module::new` over 200 runs.

| contract | alkanes-rs | alkanes-ts | ratio | rs gzip | ts gzip | ratio | rs compile µs | ts compile µs | ratio |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| counter | 159393 | 224679 | 1.4× | 59089 | 98976 | 1.7× | 1216.2 | 2344.3 | 1.9× |
| token | 171036 | 274249 | 1.6× | 62366 | 115431 | 1.9× | 1302.0 | 2924.7 | 2.2× |

## Per-call cost

Fuel is wasmi instruction fuel (start budget 100000000). Times are medians over 200 runs: *exec* runs the export (nested extcalls included), *inst* instantiates (memory grow skipped: --no-grow).

| scenario | rs fuel | ts fuel | ratio | rs exec µs | ts exec µs | ratio | rs inst µs | ts inst µs | result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| counter sum(n=100) | 29497 | 37336 | 1.3× | 33.0 | 100.7 | 3.1× | 14.2 | 12.0 | u128 328350 |
| counter sum(n=10,000) | 76522 | 86814 | 1.1× | 138.7 | 217.5 | 1.6× | 14.0 | 11.8 | u128 333283335000 |

Reproduce: set `ALKANES_RS` to the recorded alkanes-rs revision, run `npm run build:bench:rust`, `npm run build`, then `npm run bench:speed -- --output bench/SPEED_RESULTS.md`. Use `--grow` for the host's 512-page setup. Timings are local measurements, not production indexer latency.
