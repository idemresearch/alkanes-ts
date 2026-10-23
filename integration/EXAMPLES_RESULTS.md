# Counter, Token and CappedToken integration verification

The tests use the upstream Alkanes indexer and its actual transaction, balance, nested-call, rollback and wasmi implementations. No upstream source is modified.

```text
running 9 tests
test examples::token_owner_wide_mint_real_balances_and_nested_rollback ... ok
test examples::token_cross_calls_preserve_data_cache_and_failure_atomicity ... ok
test examples::counter_checked_storage_loops_height_and_rollback ... ok
test successful_callbacks_invalidate_the_caller_storage_cache ... ok
test real_auth_clients_balances_and_rollback ... ok
test native_words_preserve_wide_values_checked_operations_and_self_auth ... ok
test initialization_reentry_is_blocked ... ok
test initialization_and_numeric_boundaries ... ok
test authentication_failures_and_reentry ... ok
test result: ok. 9 passed; 0 failed; 0 ignored; 0 filtered out; finished in 27.60s
```

Covered: generated-client CREATE+init bytes; typed ID state; initialization gates and atomic deployment failure; actual upstream auth verification and returned assets; cap/max-u128 boundaries; failed-auth and post-auth rollback; auth and initializer reentry; callback cache invalidation; outgoing Bitcoin UTXO balances; complete TS/Rust response and storage parity. Additional Counter/Token coverage: checked wide increments/mints, numeric loops, storage fill, height, metadata responses, caller ownership, real UTXO balances and nested-call rollback.

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
  "zig": "0.17.0",
  "binaryen": "wasm-opt version 125 (version_125)",
  "lowering": {
    "counter": "word-sdk-v1",
    "token": "word-sdk-v1"
  },
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
    "counter.wasm": {
      "bytes": 114541,
      "sha256": "b2291b7265fc87e287b49f7f7b563ee0dad679bffb32310368e60f8d14232c9a"
    },
    "token.wasm": {
      "bytes": 111748,
      "sha256": "8bde7ec9ab62ae5393f2607093c2db5140c1ef647877901038686953aa6a728b"
    },
    "counter-rust.wasm": {
      "bytes": 160581,
      "sha256": "80d6f8ec123d1550ad43a4ead7ba22a1381f71b5e152618a1554d00cfb2c64fd"
    },
    "counter-rust-opt.wasm": {
      "bytes": 122188,
      "sha256": "6264dc1a53e8cc018d67e3cd39f559cbeb6ee3d83015f2acae447903e97bff6c"
    },
    "token-rust.wasm": {
      "bytes": 171035,
      "sha256": "7a9ccf1eaf630022b1ae29a47b62119cfd1fd35966b2c5c02feab019b092442e"
    },
    "token-rust-opt.wasm": {
      "bytes": 130029,
      "sha256": "d2d63907a32da6b1d837a5f03b4f5af0e4e902a674a2f5ca7026558f760af792"
    },
    "word-relay.wasm": {
      "bytes": 98343,
      "sha256": "7edef17eb38b1206aa31fbea33bf519873e513f54ba95e3eac5d86f8c9aa8386"
    }
  }
}
```
