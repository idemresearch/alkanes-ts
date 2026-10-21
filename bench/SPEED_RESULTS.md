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
counter.wasm SHA-256: 6d57597e4bab0410a42751c8dd62a4d43d0abe34020d9504988e16fd35ddbc83
token.wasm SHA-256: 9b4c2530b9ed0293060885793408ccaf384241746799bc29f75bfeed2d464a88
```

# Original Rust u128 loop versus optimized TypeScript

The TS sum uses exact numeric arithmetic up to n=300,000; Rust here retains its original checked u128 loop. This compares the contract implementations, not equally optimized numeric representations.

## Binary size and compile time

Compile time is the median `Module::new` over 200 runs.

| contract | alkanes-rs | alkanes-ts | ratio | rs gzip | ts gzip | ratio | rs compile µs | ts compile µs | ratio |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| counter | 158766 | 271240 | 1.7× | 58782 | 114998 | 2.0× | 1203.7 | 2864.8 | 2.4× |
| token | 171035 | 274091 | 1.6× | 62446 | 115407 | 1.8× | 1338.2 | 2905.5 | 2.2× |

## Per-call cost

Fuel is wasmi instruction fuel (start budget 100000000). Times are medians over 200 runs: *exec* runs the export (nested extcalls included), *inst* instantiates (memory grow skipped: --no-grow).

| scenario | rs fuel | ts fuel | ratio | rs exec µs | ts exec µs | ratio | rs inst µs | ts inst µs | result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| counter `__meta` | 5557 | 47411 | 8.5× | 21.2 | 110.8 | 5.2× | 15.6 | 14.0 | rs: ABI, 630 bytes / ts: ABI, 611 bytes |
| counter initialize | 50456 | 61721 | 1.2× | 44.7 | 167.7 | 3.8× | 13.7 | 14.2 | ok |
| counter increment | 48849 | 59006 | 1.2× | 43.8 | 157.0 | 3.6× | 13.9 | 14.1 | u128 5 |
| counter get_count | 35067 | 55642 | 1.6× | 35.5 | 149.2 | 4.2× | 14.2 | 14.2 | u128 0 |
| counter revert (write, then throw) | 47797 | 63293 | 1.3× | 43.5 | 177.8 | 4.1× | 13.8 | 14.1 | revert "Error: intentional failure" |
| counter get_height + log | 38708 | 59295 | 1.5× | 38.6 | 156.7 | 4.1× | 14.2 | 14.0 | u128 900000 |
| counter unknown opcode | 32833 | 52832 | 1.6× | 36.0 | 143.0 | 4.0× | 13.6 | 13.9 | rs: revert "Error: Unrecognized opcode" / ts: revert "Error: Unrecognized opcode 99" |
| counter sum(n=100) | 33949 | 49868 | 1.5× | 45.0 | 128.2 | 2.9× | 14.4 | 13.9 | u128 328350 |
| counter sum(n=10,000) | 528949 | 99346 | 0.2× | 1264.5 | 245.4 | 0.2× | 14.8 | 14.1 | u128 333283335000 |
| counter fill(n=10) | 147235 | 140961 | 1.0× | 107.1 | 349.4 | 3.3× | 13.6 | 14.0 | ok |
| counter fill(n=1,000) | 13315638 | 9102123 | 0.7× | 10486.0 | 20075.3 | 1.9× | 13.8 | 24.7 | ok |
| token `__meta` | 5669 | 46720 | 8.2× | 22.2 | 114.9 | 5.2× | 15.8 | 15.3 | rs: ABI, 662 bytes / ts: ABI, 647 bytes |
| token initialize | 88391 | 71746 | 0.8× | 70.1 | 199.0 | 2.8× | 14.0 | 15.9 | ok |
| token mint (owner) | 85655 | 70179 | 0.8× | 66.4 | 188.4 | 2.8× | 14.0 | 15.2 | ok |
| token get_name | 40441 | 49266 | 1.2× | 40.3 | 129.7 | 3.2× | 14.8 | 15.2 | "TypeScript Token" |
| token get_total_supply | 47578 | 55691 | 1.2× | 43.8 | 160.5 | 3.7× | 13.8 | 17.0 | u128 1000 |
| token → counter extcall | 110686 | 123059 | 1.1× | 115.6 | 379.4 | 3.3× | 13.1 | 16.1 | u128 41 |
# Rust given the same numeric fast path

Both use exact numeric squares and accumulation for n ≤ 300,000, convert once at the boundary, and retain the u128/bigint loop above that bound. Only arithmetic scenarios are repeated here.

## Binary size and compile time

Compile time is the median `Module::new` over 200 runs.

| contract | alkanes-rs | alkanes-ts | ratio | rs gzip | ts gzip | ratio | rs compile µs | ts compile µs | ratio |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| counter | 159393 | 271240 | 1.7× | 59089 | 114998 | 1.9× | 1208.5 | 2893.2 | 2.4× |
| token | 171036 | 274091 | 1.6× | 62366 | 115407 | 1.9× | 1301.3 | 2933.2 | 2.3× |

## Per-call cost

Fuel is wasmi instruction fuel (start budget 100000000). Times are medians over 200 runs: *exec* runs the export (nested extcalls included), *inst* instantiates (memory grow skipped: --no-grow).

| scenario | rs fuel | ts fuel | ratio | rs exec µs | ts exec µs | ratio | rs inst µs | ts inst µs | result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| counter sum(n=100) | 29497 | 49868 | 1.7× | 33.0 | 128.8 | 3.9× | 14.3 | 13.8 | u128 328350 |
| counter sum(n=10,000) | 76522 | 99346 | 1.3× | 138.2 | 246.2 | 1.8× | 14.3 | 13.8 | u128 333283335000 |

Reproduce: set `ALKANES_RS` to the recorded alkanes-rs revision, run `npm run build:bench:rust`, `npm run build`, then `npm run bench:speed -- --output bench/SPEED_RESULTS.md`. Use `--grow` for the host's 512-page setup. Timings are local measurements, not production indexer latency.
