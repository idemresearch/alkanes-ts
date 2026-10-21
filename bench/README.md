# alkanes-rs vs alkanes-ts benchmark

This compares the TypeScript contracts in `contracts/` with Rust twins written against `alkanes-runtime`. Both run on the same alkanes host model built on wasmi 0.37.2, the engine and version the indexer uses.

For paired measurements separating initialization, arithmetic, byte encoding, host transport and SDK storage handling, see [fuel isolation](ISOLATION.md) and its [saved results](ISOLATION_RESULTS.md). Run it independently with `npm run build:bench:isolate` followed by `npm run bench:isolate`.

[Optimization experiments](OPTIMIZATION.md) compare scriptc 0.3.6/0.4.0, compiler contract annotations, and faster SDK codecs without a compiler fork. Run `npm run build:bench:optimize` followed by `npm run bench:optimize`.

The codec improvements are now applied to the production SDK. The [current production report](SDK_OPTIMIZATION_RESULTS.md) compares real counter/token contracts against the preserved legacy codecs using scriptc 0.4.0. Reproduce with `npm run build`, `npm run build:bench:optimize`, and `npm run bench:sdk`.

## Setup

- **Contracts:** `bench/rust/{counter,token}` reimplement `contracts/{counter,token}` with `alkanes-runtime`, using the same opcodes, storage keys, revert messages and responses. They are ports written for this benchmark, not upstream std contracts. The counter has two scaling workloads: `sum(n)` (Σi² over u128) and `fill(n)` (n storage writes).
- **Rust build:** run inside an alkanes-rs checkout (commit `18764c8`) as workspace members, with its pinned toolchain (rustc 1.86.0), Cargo.lock and release profile (`lto = "fat"`, `codegen-units = 1`). This is how alkanes-rs builds its std contracts, with no wasm-opt pass.
- **TypeScript build for the results below:** scriptc 0.3.6 through `scripts/build.mjs`, including binaryen `-Oz`. The project now pins 0.4.0; reruns record the current toolchain in the isolation and optimization reports.
- **Host:** `harness/src/lib.rs`. Fuel metering is on, there is no start function, every call gets a fresh instance, storage commits on success, and extcalls run nested with the callee's fuel charged to the caller. The per-byte fuel surcharges that the real host adds to host functions are not modeled. Both implementations call the same host functions, so those surcharges would add roughly the same absolute amount to each.
- **Machine:** a 4-vCPU Linux cloud container running wasmi natively. Timings are medians of 200 runs. Fuel was identical across runs.

Run it with:

```console
$ npm run build
$ ALKANES_RS=/path/to/alkanes-rs bench/build-rust.sh   # needs protoc and rustup
$ npm run bench                    # instantiation grows memory to 512 pages, like the indexer
$ npm run bench -- --no-grow       # contract execution cost without the grow
```

## Results

### Size and compile time

| contract | alkanes-rs | alkanes-ts | ratio | rs gzip | ts gzip | ratio | rs compile µs | ts compile µs | ratio |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| counter | 167,532 | 261,084 | 1.6× | 61,050 | 111,948 | 1.8× | 3,339 | 7,704 | 2.3× |
| token | 177,958 | 264,506 | 1.5× | 64,348 | 112,744 | 1.8× | 3,650 | 7,914 | 2.2× |

### Fuel and execution time

Fuel is the consensus-relevant cost. *exec* is the wall time of the `__execute` (or `__meta`) call itself, measured with `--no-grow` so the host's memory setup doesn't distort it (see below).

| scenario | rs fuel | ts fuel | ratio | rs exec µs | ts exec µs | ratio |
|---|---:|---:|---:|---:|---:|---:|
| counter `__meta` | 5,710 | 57,862 | 10.1× | 14.5 | 509.0 | 35.1× |
| counter initialize | 50,696 | 238,404 | 4.7× | 98.4 | 1,192.6 | 12.1× |
| counter increment | 49,923 | 202,285 | 4.1× | 96.7 | 1,013.0 | 10.5× |
| counter get_count | 36,111 | 189,983 | 5.3× | 72.7 | 997.2 | 13.7× |
| counter revert (write, then throw) | 47,548 | 211,259 | 4.4× | 92.5 | 1,085.1 | 11.7× |
| counter get_height + log | 37,990 | 173,423 | 4.6× | 77.1 | 959.0 | 12.4× |
| counter unknown opcode | 31,656 | 144,282 | 4.6× | 74.0 | 792.1 | 10.7× |
| counter sum(n=100) | 33,341 | 229,086 | 6.9× | 84.6 | 1,181.8 | 14.0× |
| counter sum(n=10,000) | 528,341 | 8,166,053 | 15.5× | 2,467.9 | 43,630.5 | 17.7× |
| counter fill(n=10) | 146,195 | 802,507 | 5.5× | 264.6 | 2,884.8 | 10.9× |
| counter fill(n=1,000) | 13,230,585 | 65,569,899 | 5.0× | 24,815.2 | 203,468.7 | 8.2× |
| token `__meta` | 5,822 | 55,917 | 9.6× | 14.8 | 491.7 | 33.2× |
| token initialize | 85,818 | 266,987 | 3.1× | 159.0 | 1,198.6 | 7.5× |
| token mint (owner) | 82,744 | 262,280 | 3.2× | 153.2 | 1,267.9 | 8.3× |
| token get_name | 40,330 | 156,593 | 3.9× | 94.6 | 898.2 | 9.5× |
| token get_total_supply | 49,271 | 202,359 | 4.1× | 124.8 | 1,081.2 | 8.7× |
| token → counter extcall | 109,644 | 402,848 | 3.7× | 815.6 | 2,252.6 | 2.8× |

All scenarios return the same results from both implementations, with two expected differences: ABI formatting, and the unknown-opcode message (TS appends the opcode number).

### With the indexer's 512-page memory grow

After instantiating a contract, the indexer grows its memory to 512 pages (32 MiB). wasmi zero-fills grown pages eagerly. A Rust module starts at 17 pages and a scriptc module at 266, so Rust has more pages to fill:

| scenario | rs inst µs | ts inst µs | rs exec µs | ts exec µs |
|---|---:|---:|---:|---:|
| counter get_count | 21,440 | 10,523 | 372.3 | 1,233.5 |
| token mint (owner) | 22,264 | 11,011 | 451.9 | 1,440.4 |
| counter sum(n=10,000) | 22,074 | 11,412 | 2,874.9 | 43,424.1 |

Here instantiation costs 10–22 ms and dwarfs execution, and Rust pays about twice as much as TS. The grow also slows Rust's execution about 5× (73 → 372 µs for `get_count`), because its heap lands in freshly grown pages. TS execution barely changes. As a result, a full call on native wasmi takes about 11 ms for TS against about 22 ms for Rust.

This comes from how the host grows memory, not from either compiler. The production indexer runs wasmi inside a Wasm module under metashrew, where allocation behaves differently, so don't read these absolute times as production numbers.

## Takeaways

- **Typical calls cost 3–5× the fuel in TypeScript** (about 150K–270K vs 30K–90K). That is still well under the 3.5M minimum fuel a message gets on mainnet.
- **The roughly 50K extra fuel in `__meta` is not a direct initialization measurement.** It includes contract initialization and ABI generation/formatting. The [isolation suite](ISOLATION.md) measures initialization explicitly: 3,581 fuel for its SDK-free scriptc fixture and 18,414 for its SDK probe module. These are module-specific, not universal per-call costs.
- **u128 math is the weakest spot, at 15× the fuel and 18× the time.** `bigint` has no fixed width, so `sum(10,000)` costs 8.2M fuel vs 0.53M. Code that does heavy u128 arithmetic would need a fixed-width representation in the SDK.
- **Storage-heavy work costs 5× the fuel.** The [paired storage probes](ISOLATION_RESULTS.md) point primarily to hex-string key construction; copying small host results through the four-byte callback is much cheaper in isolation.
- **Wall-clock execution is worse than the fuel ratio suggests,** about 8–14× on typical calls. So for TS code, fuel understates real CPU cost relative to Rust. wasmi charges bulk memory ops only 1 fuel per 64 bytes, and TS code runs more indirect and runtime calls per unit of fuel. I haven't profiled which of these dominates.
- **Binaries are 1.5–1.8× larger and take 2.2–2.3× longer to compile.** The indexer caches compiled modules, so compile time is a one-time cost per block.

## Where the TS side could improve

- A fixed-width u128 type in the SDK (for example two 64-bit limbs) instead of `bigint`.
- Reading host results in larger chunks, or having scriptc support byte-returning callbacks, instead of one callback per 4 bytes.
- Keying the storage cache on bytes instead of hex strings.
- Cutting scriptc's reactor initialization for contracts that don't need the full runtime.
