# Counter, Token and CappedToken integration verification

The tests use the upstream Alkanes indexer and its actual transaction, balance, nested-call, rollback and wasmi implementations. No upstream source is modified.

```text
running 10 tests
test examples::token_owner_wide_mint_real_balances_and_nested_rollback ... ok
test examples::token_cross_calls_preserve_data_cache_and_failure_atomicity ... ok
test examples::native_checked_u128_uses_actual_runtime ... ok
test examples::counter_checked_storage_loops_height_and_rollback ... ok
test successful_callbacks_invalidate_the_caller_storage_cache ... ok
test real_auth_clients_balances_and_rollback ... ok
test native_words_preserve_wide_values_checked_operations_and_self_auth ... ok
test initialization_reentry_is_blocked ... ok
test initialization_and_numeric_boundaries ... ok
test authentication_failures_and_reentry ... ok
test result: ok. 10 passed; 0 failed; 0 ignored; 0 filtered out; finished in 30.56s
```

Covered: generated-client CREATE+init bytes; typed ID state; initialization gates and atomic deployment failure; actual upstream auth verification and returned assets; cap/max-u128 boundaries; failed-auth and post-auth rollback; auth and initializer reentry; callback cache invalidation; outgoing Bitcoin UTXO balances; complete TS/Rust response and storage parity. Additional Counter/Token coverage: checked wide increments/mints, numeric loops, storage fill, height, metadata responses, caller ownership, real UTXO balances and nested-call rollback.

```json
{
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
      "bytes": 92847,
      "sha256": "14aa41048dbfe2232819012f24090cbb7afa87330108eb692f9139c38bb70c6e"
    },
    "cache-callee.wasm": {
      "bytes": 86904,
      "sha256": "a5b51cb3a6298deddc16e505655d7ff0a1384a4beea79a8f32c9f75c5a24ff37"
    },
    "word.wasm": {
      "bytes": 158317,
      "sha256": "bac8cd3d1dae1171252f0961199cdc1763a52eb23e90fbd3d3ec44a3d8b66ebf"
    },
    "counter-native.wasm": {
      "bytes": 118814,
      "sha256": "ba578a90190992cc3d48ee6a71981019bb8384ab2f4d71da78f2530f736a11ef"
    },
    "counter-c-sdk-0.4.2.wasm": {
      "bytes": 114541,
      "sha256": "b2291b7265fc87e287b49f7f7b563ee0dad679bffb32310368e60f8d14232c9a"
    },
    "counter-native-generic-coercion.wasm": {
      "bytes": 115005,
      "sha256": "6941eeeb9654fced27d58ab45d479363d78cf6bb427c234e3e22422020d8378a"
    },
    "native-word-probe.wasm": {
      "bytes": 113930,
      "sha256": "80a3143e1309f5beae9d6ea1d547599eeaf4a55a89216de0dc445e066783d37a"
    },
    "counter.wasm": {
      "bytes": 110779,
      "sha256": "057c398ae02561c254cedd9fbcf4b2357f5db60099589589efe0d3d082e629ef"
    },
    "token.wasm": {
      "bytes": 105523,
      "sha256": "11fb9b6a8cdd5cde3d1eb1d86d5698a1e7fcb1316d3c03c6038fd8ea77725cbb"
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
      "bytes": 93458,
      "sha256": "c7aa0c8cfc9ad24d552c31f3931cf304971c5bb0527ee8ee265de20e345f2c7b"
    }
  }
}
```
