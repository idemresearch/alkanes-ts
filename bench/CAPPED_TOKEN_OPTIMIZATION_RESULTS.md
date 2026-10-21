# CappedToken on the actual Alkanes runtime

Machine: Apple M3 Max, darwin arm64. 30 measured repetitions per variant/scenario after 3 warmups each, with rotating variant order. Both TS and Rust run through the unmodified indexer, canonical host functions, asset accounting, and wasmi 0.37.2.

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
rust-capped-token.wasm SHA-256: 61ebb25d9c66f52b2592d1e098256cb6c8169b5104f32b25f0c54fd9cab76cd8
rust-capped-token-opt.wasm SHA-256: 4a2d5dbd359d203a34bd1000d0cf624df454ea2cb24852239c85a6574d41b979
rust-test-auth.wasm SHA-256: 584bfb7494297cc8c0a12c3257d21562a4c27661b25bdf9a4446233b2e4ad38e

Both implementations use the same auth binary and one-unit opcode-1 auth flow. The upstream auth binary returns two units; both account for its actual response.

| scenario | TS before fuel | TS fuel | Rust O3/LTO fuel | Rust + wasm-opt O3 fuel | TS before µs | TS median µs | Rust median µs | Rust + wasm-opt median µs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| deploy+init | 85792 | 28360 | 111996 | 62463 | 860097.0 | 861577.2 | 857019.8 | 854893.6 |
| mint+auth | 253280 | 108865 | 308823 | 197787 | 10054.0 | 5705.4 | 6867.3 | 6898.2 |
| mint+auth-wide | 258197 | 108883 | 310224 | 199112 | 10089.5 | 5703.0 | 6900.3 | 6893.0 |
| supply | 71084 | 19978 | 94194 | 51454 | 6139.5 | 2313.1 | 3420.9 | 3393.6 |
| authority | 74128 | 20626 | 93446 | 51240 | 6073.4 | 2220.2 | 3378.1 | 3333.2 |
| cap | 70904 | 19306 | 93863 | 51209 | 6048.3 | 2153.1 | 3318.4 | 3326.9 |

Build metadata:

```json
{
  "zig": "0.17.0",
  "binaryen": "wasm-opt version 125 (version_125)",
  "lowering": "word-v1",
  "nativeSDKSourceSHA256": "a2fdef252418cd6145f4baa7d3af48226e4dda0f5604bc96e6305200db1b0ec7",
  "upstream": "f9446fdab77cdc12acbc85f8e9c91c9e5ac2f6cb",
  "upstreamTrackedDirty": false,
  "hostRust": "rustc 1.91.1 (ed61e7d7e 2025-11-07)",
  "runner": "wasm-bindgen-test-runner 0.2.127",
  "scriptc": "0.4.0",
  "machine": "Apple M3 Max, darwin arm64",
  "lockSHA256": "d505349e7198a391195700899067d6371ba96e4b0a87d33707b36cc81d3f5945",
  "artifacts": {
    "capped-token.wasm": {
      "bytes": 107660,
      "sha256": "70307bc7a3180e0fa9dea1d2c95096147f5c9e467cca895c01d434cb8c79e936"
    },
    "rust-capped-token.wasm": {
      "bytes": 175495,
      "sha256": "61ebb25d9c66f52b2592d1e098256cb6c8169b5104f32b25f0c54fd9cab76cd8"
    },
    "rust-capped-token-opt.wasm": {
      "bytes": 133105,
      "sha256": "4a2d5dbd359d203a34bd1000d0cf624df454ea2cb24852239c85a6574d41b979"
    },
    "test-auth.wasm": {
      "bytes": 169964,
      "sha256": "584bfb7494297cc8c0a12c3257d21562a4c27661b25bdf9a4446233b2e4ad38e"
    },
    "auth.wasm": {
      "bytes": 179889,
      "sha256": "e0b4933736043edf5edfaa6af74aa6f86a11192ed8ab6d80bf02eb07f059a26e"
    },
    "init-probe.wasm": {
      "bytes": 88418,
      "sha256": "dbaaee276d801bce8890380c70488ad5276c746886f04ffdb7954756ef852981"
    },
    "cache-caller.wasm": {
      "bytes": 268326,
      "sha256": "875756a406f21eda762f681ca42bf9898eb9489dc4cd3cefbb586de9a0929a20"
    },
    "cache-callee.wasm": {
      "bytes": 259312,
      "sha256": "9b30aef4c31e52410d25b23360ae155aba397ad6c988834af1996dd45e68e510"
    },
    "word.wasm": {
      "bytes": 158317,
      "sha256": "bac8cd3d1dae1171252f0961199cdc1763a52eb23e90fbd3d3ec44a3d8b66ebf"
    },
    "capped-token-before.wasm": {
      "bytes": 242080,
      "sha256": "505a634b7d99850cc1cc941480dc1fc31676d75030fc4486d48d357543663028"
    }
  }
}
```

Reproduce with the recorded alkanes-rs revision: `ALKANES_RS=/path/to/alkanes-rs npm run test:runtime`, `ALKANES_RS=/path/to/alkanes-rs npm run build:bench:capped-opt`, then `ALKANES_RS=/path/to/alkanes-rs npm run bench:capped -- --iterations 30 --baseline dist/capped-opt/bigint-production.wasm --output bench/CAPPED_TOKEN_OPTIMIZATION_RESULTS.md`.
