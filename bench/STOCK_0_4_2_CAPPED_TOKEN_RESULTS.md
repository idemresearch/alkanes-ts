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
| deploy+init | 28360 | 28670 | 111996 | 62463 | 850319.7 | 859702.8 | 860536.6 | 866756.1 |
| mint+auth | 108865 | 109324 | 308823 | 197787 | 5636.0 | 5731.2 | 6789.9 | 6836.8 |
| mint+auth-wide | 108883 | 109342 | 310224 | 199112 | 5683.1 | 5756.1 | 6758.6 | 6793.7 |
| supply | 19978 | 20166 | 94194 | 51454 | 2255.4 | 2345.7 | 3329.3 | 3338.6 |
| authority | 20626 | 19827 | 93446 | 51240 | 2179.8 | 2271.4 | 3324.9 | 3252.0 |
| cap | 19306 | 20487 | 93863 | 51209 | 2145.9 | 2235.5 | 3253.7 | 3217.7 |

Build metadata:

```json
{
  "toolchain": {
    "mode": "stock scriptc CLI",
    "compilerPatches": [],
    "packages": {
      "scriptc": "0.4.2",
      "@scriptc/runtime-wasm32-wasi": "0.4.2",
      "@scriptc/types": "0.4.2"
    },
    "nativePackage": "@scriptc/cli-darwin-arm64",
    "executableSHA256": "c4c86c6decd10b127a64a4eea46f06a9265562fd38b515906416f188b077563d",
    "nativePackageIntegrity": "sha512-5hlE7yDZjvsz0YDdy3QLpltN+UosdDJ10OJVtmXAeXVxxWWrN1gw4+XYLNBKWG6hATFVH7FfGCNbi0fnugOPOA==",
    "packageLockSHA256": "33d5508fbd44800015edfd50dd4fd92fd01d0e490fd13d9a03d0256019f6f008",
    "node": "v24.22.0"
  },
  "baselineBuild": {
    "scriptc": "0.4.0",
    "revision": "aa4baa1d3dcf6c060a5ed7a381c8e9a261572456",
    "artifacts": {
      "counter": {
        "bytes": 110779,
        "sha256": "057c398ae02561c254cedd9fbcf4b2357f5db60099589589efe0d3d082e629ef"
      },
      "token": {
        "bytes": 105523,
        "sha256": "11fb9b6a8cdd5cde3d1eb1d86d5698a1e7fcb1316d3c03c6038fd8ea77725cbb"
      },
      "capped-token": {
        "bytes": 107660,
        "sha256": "70307bc7a3180e0fa9dea1d2c95096147f5c9e467cca895c01d434cb8c79e936"
      }
    }
  },
  "zig": "0.17.0",
  "binaryen": "wasm-opt version 125 (version_125)",
  "lowering": "word-v1",
  "nativeSDKSourceSHA256": "a2fdef252418cd6145f4baa7d3af48226e4dda0f5604bc96e6305200db1b0ec7",
  "extendedSDKSourceSHA256": "4efb602678dbf210598afa059f9d481bed1f53bc032649244f467f63918c676e",
  "upstream": "f9446fdab77cdc12acbc85f8e9c91c9e5ac2f6cb",
  "upstreamTrackedDirty": false,
  "hostRust": "rustc 1.91.1 (ed61e7d7e 2025-11-07)",
  "runner": "wasm-bindgen-test-runner 0.2.127",
  "scriptc": "0.4.2",
  "machine": "Apple M3 Max, darwin arm64",
  "lockSHA256": "d505349e7198a391195700899067d6371ba96e4b0a87d33707b36cc81d3f5945",
  "artifacts": {
    "capped-token.wasm": {
      "bytes": 111542,
      "sha256": "1c929820c2e78aeac5705ffa99dd55fa228f666222538edc2b323ac22eec75d0"
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
      "bytes": 92302,
      "sha256": "4c50f36c300c117f989d46844fa678dbfb7f4f1545032c1e1ab17377f6235c6d"
    },
    "cache-caller.wasm": {
      "bytes": 99048,
      "sha256": "3374a7d2bf6b7c174dc807cb50bad209e11281d98e003a586fe9763f1a9a664f"
    },
    "cache-callee.wasm": {
      "bytes": 93108,
      "sha256": "1100b5f92258e5e5b8b68fc03bc69649b0f57812702b49e0aeb1325bd5c2e351"
    },
    "word.wasm": {
      "bytes": 162199,
      "sha256": "b4191cb9825c1712f4163ae052b0d7b93863cb667a83b359ef5123dd5970b17c"
    },
    "capped-token-before.wasm": {
      "bytes": 107660,
      "sha256": "70307bc7a3180e0fa9dea1d2c95096147f5c9e467cca895c01d434cb8c79e936"
    }
  }
}
```

Reproduce with the recorded alkanes-rs revision: `ALKANES_RS=/path/to/alkanes-rs npm run test:runtime`, `ALKANES_RS=/path/to/alkanes-rs npm run build:bench:capped-opt`, then `ALKANES_RS=/path/to/alkanes-rs npm run bench:capped -- --iterations 30 --baseline dist/capped-opt/bigint-production.wasm --output bench/STOCK_0_4_2_CAPPED_TOKEN_RESULTS.md`.
