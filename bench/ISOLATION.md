# Isolating scriptc and SDK fuel

The end-to-end counter/token comparison cannot assign all extra fuel to scriptc. It includes TypeScript runtime semantics, the SDK's algorithms, contract initialization, serialization, and the ABI bridge. This suite measures smaller, paired workloads to distinguish those costs.

The saved report below predates the production codec optimizations. Current builds use the optimized SDK; see the [production before/after report](SDK_OPTIMIZATION_RESULTS.md) for the applied savings. The optimization suite preserves the original codecs as a repeatable baseline.

## Run

Requires the project's npm dependencies, Node.js 24+, Zig on `PATH`, and Rust with the `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`). An alkanes-rs checkout is not required. The saved run used scriptc 0.3.6, Zig 0.17.0, Binaryen 125, and rustc 1.91.1; each report records tool versions and module hashes.

```sh
npm run build:bench:isolate
npm run bench:isolate -- --iterations 20 --no-grow --output bench/ISOLATION_RESULTS.md
npm run bench:isolate -- --iterations 20
```

The last command includes the indexer's memory growth to 512 pages. Both modes produced identical instruction fuel for every row in the saved run. Host memory growth is outside the measured Wasm calls; this suite makes no wall-clock comparisons. In a sandbox, Zig's caches can be redirected into the workspace with `ZIG_GLOBAL_CACHE_DIR="$PWD/build/zig-global-cache" ZIG_LOCAL_CACHE_DIR="$PWD/build/zig-local-cache"` before the build command.

## What is measured

All TypeScript fixtures go through the same scriptc profile, production `shim/adapter.wat`, deterministic WASI shim, DCE and `wasm-opt -Oz` pipeline as the contracts. The only adapter change is a benchmark-only export of its existing initialization guard. Production contract exports stay unchanged.

The runner uses wasmi 0.37.2 with instruction fuel enabled and a 100M fuel budget. Every repetition creates a fresh instance. For initialized rows, it explicitly initializes that instance before starting the measurement. Prepared storage fixtures are also created before measuring. No successive calls are averaged on an increasingly populated heap. Any trap, abort, wrong result, or differing fuel count fails the run; reports are written only after all checks pass.

| Measurement | Control | Added work / interpretation |
|---|---|---|
| Startup | Standalone Rust and an SDK-free scriptc module | Explicit adapter initialization; includes runtime and module top-level initialization. Minimal scriptc is a floor, not a universal fixed cost. |
| Empty execution | Same 112-byte context and valid 20-byte empty response | Cold versus initialized calls in each module. Minimal TS and SDK TS are different compiled modules, so their difference is descriptive rather than a pure SDK ablation. |
| SDK execution pipeline | Same initialized SDK module returning empty response bytes | Calls actual `executeContract` on a prepared context: storage reset, context parsing, opcode dispatch, handler, response serialization. Both paths consume the output with the same checksum and length check. Excludes host context loading and the WAT entry/return path. |
| Arithmetic | SDK-free loop bodies: `number` versus `bigint`, plus native f64/u128 | Sum of squares, with no storage or byte encoding. Comparing unchecked `bigint` with actual `checkedAdd` isolates the SDK check as executed by scriptc. Native u128 differs semantically from arbitrary precision bigint. |
| u128 encoding | Same `(1n << 96n) + i` accumulation without encoding | Adds actual `u128ToBytes` and `bytesToU128` calls. Measures the current SDK's per-byte bigint encoding, allocation and decoding, rather than arithmetic alone. |
| Host results | Actual adapter storage request into scratch | Adds actual `hostLoadStorage`, allocation, and the four-byte scratch readback loop. The fixed host slot contains a deterministic payload of the requested length; no storage-key conversion/cache is involved. |
| Hex keys | Traversal of prepared 16-byte keys | Adds actual `toHex`, consumes string length, and normalizes the result to byte length. Includes string allocation and minor length normalization overhead. |
| Write cache | Direct `ByteWriter` serialization of prepared keys and values | Adds actual `store`/`serializeStorage`: hex key generation, entry objects, Map insertion/iteration and serialization. Both reset the cache and checksum the full serialized bytes. |

The Rust fixture is a small `no_std` module compiled directly with rustc (`opt-level=z`, fat LTO, panic abort). It is a native representation lower bound, **not** the existing alkanes-runtime twin. `black_box` retains native arithmetic loops and encoding data; that overhead remains in its fuel. The native encoding control and roundtrip optimize to the same cost because a fixed-width little-endian representation needs no bigint conversion machinery. Its f64 loop also has a different integer loop counter from the TS number loop, so it is a reference rather than a strict compiler efficiency comparison.

Arithmetic scalar results are checked against independent closed-form sums. Serialization is checked against a separately generated expected byte-stream checksum in Rust. Additional unmeasured calls validate all host payload bytes at lengths 0, 1, 3, 4, 5, 16, 64, 256 and 4096, including scratch-read tails. Separate encoding checks validate full-width values across 64-, 96- and 128-bit boundaries. Cold and initialized execution must return an exact empty response, not merely a successful call.

## Results and implications

See [the full saved report](ISOLATION_RESULTS.md). For these binaries:

- SDK-free scriptc initialization costs **3,581 fuel**, and a complete cold empty call costs **7,675**. The SDK probe module initializes in **18,414**; it imports more runtime features and constructs fixtures and the one-method contract. Neither number can be substituted directly for counter/token initialization.
- In the same initialized SDK module, adding the empty SDK execution pipeline costs **81,879 fuel**. This is a measurable SDK path cost, including the scriptc code needed to execute it.
- At 10,000 iterations, unchecked bigint arithmetic costs **5,090,374**, versus **470,034** for native u128. The SDK's checked addition adds another **2,341,443** on the TS side. An SDK-only change will not remove all arbitrary precision arithmetic overhead.
- Adding 1,000 u128 encoding roundtrips costs **17,010,685** over the TS arithmetic control. The byte-by-byte bigint codec is a substantial SDK optimization target.
- Scratch copying adds **618** for a 16-byte result, **5,838** for 256 bytes, and **90,391** for 4 KiB. The four-byte bridge matters for large payloads, but is much smaller than key conversion for small storage values in these probes.
- Adding the write cache for 1,000 entries costs **31,468,255** above direct serialization. A separate hex-conversion pair costs **30,991,006**. This strongly points to hex key construction as the first storage optimization to investigate; it is not a measured guarantee that replacing it saves exactly that amount in a full contract.

This corrects the earlier interpretation of the roughly 50K TS/Rust `__meta` difference as mostly runtime initialization. `__meta` also initializes the contract and generates/formats/encodes its ABI. The explicit initialization hook is the appropriate measurement for startup.

These are paired differences, not an additive percentage breakdown of counter/token fuel. Hex conversion is already included in the write-cache delta, and u128 encoding occurs inside the execution pipeline. SDK code runs through scriptc, so its measured cost includes compiler/runtime effects. Changing an algorithm may also change allocation, garbage collection and optimization decisions. Extra scalar exports can change DCE/inlining compared with production binaries; use these probes to choose an optimization, then validate savings in the end-to-end benchmarks.

The harness excludes production per-byte host surcharges, persistent host storage work, and indexer CPU costs. No result here estimates transaction fees or a production fuel limit.
