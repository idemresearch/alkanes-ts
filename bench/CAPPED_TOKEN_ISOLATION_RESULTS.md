# CappedToken compiler and SDK isolation

Machine: Apple M3 Max, darwin arm64. scriptc 0.4.0; Zig 0.17.0; wasm-opt version 125 (version_125).

wasmi 0.37.2, release native harness. Compilation: 30 fresh-engine/module samples. Export timing: 50 fresh-instance samples from identical state; instance creation shown separately, extra growth to 512 pages skipped. Startup: three fresh-instance checks of the existing adapter initialization guard, isolated from execution. The extra benchmark export can affect optimizer layout; production end-to-end numbers live in CAPPED_TOKEN_OPTIMIZATION_RESULTS.md.

The floor has no SDK. Empty adds the actual SDK dispatch/context/response pipeline on the same 112-byte context and identical empty output. Each empty module has cold and explicitly initialized measurements. Those linked-feature differences include scriptc implementation costs; they are not an additive percentage decomposition of CappedToken.

CappedToken variants preserve the authored methods. Arrays replace decimal-key maps in asset/storage bookkeeping. Codecs add a checked u32 encoding fast path; plain-codecs also replace DataView with byte operations. Error-only removes the non-Error formatting fallback as a **diagnostic ablation only**, not a production change. Binaryen O3 changes optimizer posture. Word is the shipped fixed-width representation and Wasm SDK; user methods still compile with scriptc.

All CappedToken/Rust rows check complete responses and resulting storage, including transfers, against one reference. They invoke the same actual standard-auth Wasm and opcode-1 parcel as the canonical tests. This standalone host model excludes production host surcharges, real balance enforcement and indexer CPU costs. Do not subtract its fuel from canonical-runtime totals to estimate host fees.

| module | bytes | compile µs | startup fuel | init fuel | mint fuel | supply fuel | mint instance µs | mint export µs | supply instance µs | supply export µs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| dist/capped-opt/floor.wasm | 59091 | 822.8 | 3758 | 7849 cold / 4099 warm empty | — | — | — | — | — | — |
| dist/capped-opt/empty.wasm | 203645 | 2264.1 | 8600 | 32110 cold / 23518 warm empty | — | — | — | — | — | — |
| dist/capped-opt/baseline.wasm | 242096 | 2559.3 | 11131 | 67665 | 230732 | 46309 | 15.2 | 493.6 | 13.0 | 123.8 |
| dist/capped-opt/arrays.wasm | 236641 | 2455.8 | 11102 | 60283 | 209856 | 42850 | 13.7 | 444.6 | 13.0 | 112.1 |
| dist/capped-opt/arrays-codecs.wasm | 238074 | 2517.0 | 11102 | 55753 | 198120 | 39979 | 13.1 | 404.8 | 12.9 | 104.0 |
| dist/capped-opt/arrays-plain-codecs.wasm | 232354 | 2437.5 | 11102 | 43020 | 164965 | 32260 | 12.8 | 352.1 | 12.5 | 89.2 |
| dist/capped-opt/error-only.wasm | 240049 | 2525.7 | 11097 | 67531 | 230598 | 46175 | 15.3 | 533.4 | 15.8 | 125.3 |
| dist/capped-opt/binaryen-o3.wasm | 252762 | 2650.2 | 11130 | 66599 | 227049 | 45787 | 12.9 | 473.0 | 12.5 | 116.1 |
| dist/capped-opt/word.wasm | 107682 | 828.0 | 3762 | 22427 | 104618 | 18693 | 9.5 | 180.5 | 9.0 | 48.2 |
| bench/dist/capped/rust-capped-token-opt.wasm | 133105 | 1351.2 | 0 | 46754 | 179894 | 31921 | 13.0 | 250.4 | 15.2 | 52.5 |

Hashes:

```text
dist/capped-opt/floor.wasm: 819080a55e2e39e30abd5d4f9a56573e485cdb38f83dbe1dde5de57130832c43
dist/capped-opt/empty.wasm: 2e7e091897aee9a21e156ed2c53ff63754c01a2ee777b6d301b1cc8578f2d2cb
dist/capped-opt/baseline.wasm: 416c35623e277f2a907780ea19e8470883ea9308c0ffd74d3062574b698d4ae0
dist/capped-opt/arrays.wasm: 0f90da6f985fd7e81e8b6219455394523213d1f9a3214b002e91fcdb7ab217b8
dist/capped-opt/arrays-codecs.wasm: 2f77fbdc58d98cabb471b9779cfb9bd21c9577851dda8c25522568d8c4014154
dist/capped-opt/arrays-plain-codecs.wasm: 19e59a7d19d88d0aa0bbb862ce02491a896bb2c99ae301a74e7e286b1c424349
dist/capped-opt/error-only.wasm: ec444c19b24f59cf9838d2459d4e587f6c5e1e1c4350c1385e5c4a52ce691a0c
dist/capped-opt/binaryen-o3.wasm: 2358d719cd7470d3eaa78e6371f026abbee4a39775443462ba64b36b49db6a5d
dist/capped-opt/word.wasm: 56d951f7c77956af86f822eeb4ae5b38be0e3a721e25866f0e343a081b9ffc11
bench/dist/capped/rust-capped-token-opt.wasm: 4a2d5dbd359d203a34bd1000d0cf624df454ea2cb24852239c85a6574d41b979
dist/capped-opt/auth.wasm: e0b4933736043edf5edfaa6af74aa6f86a11192ed8ab6d80bf02eb07f059a26e
```

Reproduce: `ALKANES_RS=/path/to/alkanes-rs npm run build:bench:capped-opt`, then `npm run bench:capped-opt`. Rust fixtures are built by `npm run build:bench:capped` at the recorded upstream revision.
