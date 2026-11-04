# Counter, Token and CappedToken integration verification

The tests use the upstream Alkanes indexer and its actual transaction, balance, nested-call, rollback and wasmi implementations. No upstream source is modified.

```text
running 11 tests
test custody::amm_router_routes_two_hops_through_real_pools ... ok
test custody::amm_pool_custody_matches_reserves_with_real_balances ... ok
test examples::token_owner_wide_mint_real_balances_and_nested_rollback ... ok
test examples::token_cross_calls_preserve_data_cache_and_failure_atomicity ... ok
test examples::counter_checked_storage_loops_height_and_rollback ... ok
test successful_callbacks_invalidate_the_caller_storage_cache ... ok
test real_auth_clients_balances_and_rollback ... ok
test native_words_preserve_wide_values_checked_operations_and_self_auth ... ok
test initialization_reentry_is_blocked ... ok
test initialization_and_numeric_boundaries ... ok
test authentication_failures_and_reentry ... ok
test result: ok. 11 passed; 0 failed; 0 ignored; 0 filtered out; finished in 83.14s
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
    },
    "counter.wasm": {
      "bytes": 85559,
      "sha256": "a2cb76fd58db2382a984c4a7d8fa8dcbd7c35cc19a752ef037a2c6d35588e462"
    },
    "token.wasm": {
      "bytes": 93412,
      "sha256": "284a7e9dbd44f39a2898b6893a43b805d1b5bdc41110ce6ca8b4e71c6a641ee0"
    },
    "counter-rust.wasm": {
      "bytes": 160411,
      "sha256": "17506f581ccdb92122781bb9264695fe481c7f42c17d58d8b73e7786c1f80bde"
    },
    "counter-rust-opt.wasm": {
      "bytes": 122019,
      "sha256": "4d727e8ae75edcea5cb226c8964a8778269b8785f7fb3bbc7cb97f7bbf689ae4"
    },
    "token-rust.wasm": {
      "bytes": 170912,
      "sha256": "e07d532dd7f1587cacd1e294ef080ab009109f5989ba1846402f0866154e2316"
    },
    "token-rust-opt.wasm": {
      "bytes": 129910,
      "sha256": "ebb444a8bb6e15d6d638d768d9a64e6359b5f1783e497692d001b29e1041fc0c"
    },
    "word-relay.wasm": {
      "bytes": 79412,
      "sha256": "b6415eefa7c7c8386a6191ba6b0c449093eeeac3193ce83db391f1e1155bfb63"
    },
    "amm-pool.wasm": {
      "bytes": 86228,
      "sha256": "5e43a1b9b9b445bcaa2f803f56dc8e085cb687ce4894f4e9248983b0f1c48ccf"
    },
    "amm-router.wasm": {
      "bytes": 322138,
      "sha256": "1d6db6f9aadf2c1d6628366f023fd0d1f6fb4a526290494be2b20f81d3349e05"
    }
  }
}
```
