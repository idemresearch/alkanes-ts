# CappedToken on the actual Alkanes runtime

Machine: Intel(R) Xeon(R) Processor @ 2.80GHz, linux x64. 30 measured repetitions per variant/scenario after 3 warmups each, with rotating variant order. Both TS and Rust run through the unmodified indexer, canonical host functions, asset accounting, and wasmi 0.37.2.

Fuel is the outer entry allocation minus the canonical `FuelTank` transaction remainder after indexing our single-invocation block. It includes nested auth execution plus runtime storage/host charges. This upstream revision drops exit fuel when serializing traces, so the zero exit-trace field is not used. All benchmark invocations succeed and are required to consume nonzero fuel. Median time measures `index_block`, including module compilation, instantiation and indexer work; transaction/envelope construction and inspection are excluded. This is a local wasm-bindgen/Node execution of the release-built indexer, not production RPC latency or isolated export timing. Every repetition checks the complete response and resulting contract/auth storage against the same reference.

Deployment timing includes fresh-chain bootstrap and standard-contract setup, which dominate that row; it is not isolated deployment/initializer latency. Mint and views run after chain setup.

The wide mint uses a separate MAX-u128 cap deployment and amount `(1 << 96) + 5`; setup is excluded from its timing. Every variant also verifies the actual outgoing UTXO balances for that call.

Rust contract: alkanes-rs: ea38c878931ff4b6dd64dd011962f2203d6e0a35
upstream tracked changes: false
Rust: rustc 1.86.0 (05f9846f8 2025-03-31)
profile: opt-level=3, lto=fat, codegen-units=1, panic=abort
wasm-opt: wasm-opt version 125 (version_125)
upstream Cargo.lock SHA-256: db8c0c61b0060a5b44babcfc262f39707aac1ef36635ebd16d996f6569d2d4e2
comparison Cargo.lock SHA-256: b40ad0d96d9dfd5817d7eb07c20606c6070154e850da9aabbd9bfce70f862841
rust-capped-token.wasm SHA-256: c39863ebff766e0bdbaba8f7e4506bf442ba719974302512230e648b43b11d8c
rust-capped-token-opt.wasm SHA-256: d3742db02adfa41b93735e36178dd28b98b6705c7adb4053d987b83b01bccc44
rust-test-auth.wasm SHA-256: d67e19d3a5ba240a79c2c95fa0fd3b18e9c53e2f8d17fff908b15f9e9255283c

Both implementations use the same auth binary and one-unit opcode-1 auth flow. The upstream auth binary returns two units; both account for its actual response.

| scenario | TS fuel | Rust O3/LTO fuel | Rust + wasm-opt O3 fuel | TS median µs | Rust median µs | Rust + wasm-opt median µs |
|---|---:|---:|---:|---:|---:|---:|
| deploy+init | 10420 | 116705 | 65486 | 3368069.9 | 3403107.3 | 3415698.6 |
| mint+auth | 86925 | 321302 | 206942 | 26753.6 | 31587.9 | 31204.5 |
| mint+auth-wide | 87039 | 322957 | 208593 | 27019.0 | 31562.6 | 31136.7 |
| supply | 5175 | 98444 | 54730 | 11555.3 | 15754.9 | 16006.0 |
| authority | 5365 | 97124 | 54260 | 11572.8 | 15699.1 | 15771.1 |
| cap | 5170 | 98290 | 54463 | 11649.4 | 15920.3 | 16115.5 |

Build metadata:

```json
{
  "zig": "0.17.0",
  "binaryen": "wasm-opt version 125 (version_125)",
  "lowering": "word-v1",
  "nativeSDKSourceSHA256": "57bf06dc94f02dcfbf5f1e5aa21c2698328b2c2155920b555820439da0fb879a",
  "extendedSDKSourceSHA256": "cc2c26f18725e5965bb50c85123c32ad24460b453f01172f7c3a130659887d72",
  "upstream": "ea38c878931ff4b6dd64dd011962f2203d6e0a35",
  "upstreamTrackedDirty": false,
  "hostRust": "rustc 1.97.0 (2d8144b78 2026-07-07)",
  "runner": "wasm-bindgen-test-runner 0.2.100",
  "scriptc": "0.4.7",
  "machine": "Intel(R) Xeon(R) Processor @ 2.80GHz, linux x64",
  "lockSHA256": "f390f538a69859c0208da4a746f61f77e2945a8ed033bb2b2b94d993821ae410",
  "artifacts": {
    "capped-token.wasm": {
      "bytes": 70364,
      "sha256": "828b2422dad7c8283e9adf84396af93e17259324d8e4a5c12887adc496338e1d"
    },
    "rust-capped-token.wasm": {
      "bytes": 176879,
      "sha256": "c39863ebff766e0bdbaba8f7e4506bf442ba719974302512230e648b43b11d8c"
    },
    "rust-capped-token-opt.wasm": {
      "bytes": 133962,
      "sha256": "d3742db02adfa41b93735e36178dd28b98b6705c7adb4053d987b83b01bccc44"
    },
    "test-auth.wasm": {
      "bytes": 170375,
      "sha256": "d67e19d3a5ba240a79c2c95fa0fd3b18e9c53e2f8d17fff908b15f9e9255283c"
    },
    "auth.wasm": {
      "bytes": 180660,
      "sha256": "d83fd4dd3a586638cce890e2f3c21d3dd3cfa290ee535901ba5aee0fa5af2b39"
    },
    "init-probe.wasm": {
      "bytes": 66459,
      "sha256": "2c4ffd491d17c36adb2ffbd4c9d72d6df0ef22f02f5ab95408a399aab47e4e85"
    },
    "cache-caller.wasm": {
      "bytes": 87817,
      "sha256": "b3a5a6228bc355e13331b246602ff0c8b151d4ec1c0de65b1dd459a380c03fd6"
    },
    "cache-callee.wasm": {
      "bytes": 84650,
      "sha256": "4b81a1e32cac5653cced3d39c9ca6a2f0ddf7762e763353e04e34254ca6aa520"
    },
    "word.wasm": {
      "bytes": 77621,
      "sha256": "706ce2fe2ca7b7793cc5f00081b9eccf5f62aeb459c690ae443581a376a3307d"
    }
  }
}
```

Reproduce with the recorded alkanes-rs revision: `ALKANES_RS=/path/to/alkanes-rs npm run test:runtime`, then `ALKANES_RS=/path/to/alkanes-rs npm run bench:capped -- --iterations 30 --output bench/CANONICAL_V3_CAPPED_TOKEN.md`.
