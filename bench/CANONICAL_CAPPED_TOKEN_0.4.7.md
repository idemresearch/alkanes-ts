# CappedToken on the actual Alkanes runtime

Machine: Intel(R) Xeon(R) Processor @ 2.80GHz, linux x64. 30 measured repetitions per variant/scenario after 3 warmups each, with rotating variant order. Both TS and Rust run through the unmodified indexer, canonical host functions, asset accounting, and wasmi 0.37.2.

Fuel is the outer entry allocation minus the canonical `FuelTank` transaction remainder after indexing our single-invocation block. It includes nested auth execution plus runtime storage/host charges. This upstream revision drops exit fuel when serializing traces, so the zero exit-trace field is not used. All benchmark invocations succeed and are required to consume nonzero fuel. Median time measures `index_block`, including module compilation, instantiation and indexer work; transaction/envelope construction and inspection are excluded. This is a local wasm-bindgen/Node execution of the release-built indexer, not production RPC latency or isolated export timing. Every repetition checks the complete response and resulting contract/auth storage against the same reference.

Deployment timing includes fresh-chain bootstrap and standard-contract setup, which dominate that row; it is not isolated deployment/initializer latency. Mint and views run after chain setup.

The wide mint uses a separate MAX-u128 cap deployment and amount `(1 << 96) + 5`; setup is excluded from its timing. Every variant also verifies the actual outgoing UTXO balances for that call.

Rust contract: alkanes-rs: f9446fdab77cdc12acbc85f8e9c91c9e5ac2f6cb
upstream tracked changes: false
Rust: rustc 1.86.0 (05f9846f8 2025-03-31)
profile: opt-level=3, lto=fat, codegen-units=1, panic=abort
wasm-opt: wasm-opt version 125 (version_125)
upstream Cargo.lock SHA-256: 0da32fe8c3a3e794b8aba19c29f6229ceaf7e8dad5b03d54bfe9a829edafaf9a
comparison Cargo.lock SHA-256: 5a200271d8a90282736310e90eea5e2f8a156f1d3eb9e8a574de53943ee4ed3d
rust-capped-token.wasm SHA-256: 9e815fe8f6d2fbb1d6a9890da63fe650368af610bbdade952a56649304f72fcf
rust-capped-token-opt.wasm SHA-256: 1a53c9d2d61e1e378537ebefb61fc995453bffcc6661c48236fb450360a90531
rust-test-auth.wasm SHA-256: 98cdc91a0b6c9aa34e92e0b1881331eb4c95bda51cecef515d75fc9a965b5dba

Both implementations use the same auth binary and one-unit opcode-1 auth flow. The upstream auth binary returns two units; both account for its actual response.

| scenario | TS fuel | Rust O3/LTO fuel | Rust + wasm-opt O3 fuel | TS median µs | Rust median µs | Rust + wasm-opt median µs |
|---|---:|---:|---:|---:|---:|---:|
| deploy+init | 9589 | 111996 | 62463 | 2053984.4 | 2013687.8 | 2084792.0 |
| mint+auth | 82045 | 308823 | 197787 | 26474.6 | 30626.3 | 30615.1 |
| mint+auth-wide | 82063 | 310224 | 199112 | 26277.3 | 30675.8 | 31178.9 |
| supply | 4008 | 94194 | 51454 | 11429.7 | 15740.8 | 15273.6 |
| authority | 4141 | 93446 | 51240 | 11364.3 | 15507.4 | 15412.9 |
| cap | 4012 | 93863 | 51209 | 11466.3 | 15623.0 | 15439.8 |

Build metadata:

```json
{
  "zig": "0.17.0",
  "binaryen": "wasm-opt version 125 (version_125)",
  "lowering": "word-v1",
  "nativeSDKSourceSHA256": "57bf06dc94f02dcfbf5f1e5aa21c2698328b2c2155920b555820439da0fb879a",
  "extendedSDKSourceSHA256": "cc2c26f18725e5965bb50c85123c32ad24460b453f01172f7c3a130659887d72",
  "upstream": "f9446fdab77cdc12acbc85f8e9c91c9e5ac2f6cb",
  "upstreamTrackedDirty": false,
  "hostRust": "rustc 1.97.0 (2d8144b78 2026-07-07)",
  "runner": "wasm-bindgen-test-runner 0.2.127",
  "scriptc": "0.4.7",
  "machine": "Intel(R) Xeon(R) Processor @ 2.80GHz, linux x64",
  "lockSHA256": "d505349e7198a391195700899067d6371ba96e4b0a87d33707b36cc81d3f5945",
  "artifacts": {
    "capped-token.wasm": {
      "bytes": 70476,
      "sha256": "891cffd1eaf43badbafca3f471e440bbd429005164d03cfc0b5b6faf060d13e2"
    },
    "rust-capped-token.wasm": {
      "bytes": 175375,
      "sha256": "9e815fe8f6d2fbb1d6a9890da63fe650368af610bbdade952a56649304f72fcf"
    },
    "rust-capped-token-opt.wasm": {
      "bytes": 133003,
      "sha256": "1a53c9d2d61e1e378537ebefb61fc995453bffcc6661c48236fb450360a90531"
    },
    "test-auth.wasm": {
      "bytes": 169666,
      "sha256": "98cdc91a0b6c9aa34e92e0b1881331eb4c95bda51cecef515d75fc9a965b5dba"
    },
    "auth.wasm": {
      "bytes": 179889,
      "sha256": "e0b4933736043edf5edfaa6af74aa6f86a11192ed8ab6d80bf02eb07f059a26e"
    },
    "init-probe.wasm": {
      "bytes": 66561,
      "sha256": "959fd9c18a0c9a0942a69a8e528b874b9e4b0b7322c010295c84329b2f96a7cd"
    },
    "cache-caller.wasm": {
      "bytes": 87927,
      "sha256": "6f5ef6b57a183042e8d185f6e6e24a2ffbe519bcee37086753302f0e0ab7a86d"
    },
    "cache-callee.wasm": {
      "bytes": 84755,
      "sha256": "38aa4b8bc03bc7e2b5038cad52e8b9181aa0768ccca0938d617d90201d284bb4"
    },
    "word.wasm": {
      "bytes": 77743,
      "sha256": "d63faccbc19e6c022151e40664270471e0009be555ef42d0dcf9d9e2adff8e60"
    }
  }
}
```

Reproduce with the recorded alkanes-rs revision: `ALKANES_RS=/path/to/alkanes-rs npm run test:runtime`, then `ALKANES_RS=/path/to/alkanes-rs npm run bench:capped -- --iterations 30 --output bench/CANONICAL_CAPPED_TOKEN_0.4.7.md`.
