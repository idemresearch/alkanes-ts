# Counter, Token and CappedToken integration verification

The tests use the upstream Alkanes indexer and its actual transaction, balance, nested-call, rollback and wasmi implementations. No upstream source is modified.

```text
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
test result: ok. 11 passed; 0 failed; 0 ignored; 0 filtered out; finished in 115.12s
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
    },
    "counter.wasm": {
      "bytes": 85430,
      "sha256": "46154531f68c961babf5161d289b6014987d8947086e49703edc48df1cf939de"
    },
    "token.wasm": {
      "bytes": 93286,
      "sha256": "53b0076e9eb057e5f2a2be12badc717e76dda267159bbbf497eb4133d375b238"
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
      "bytes": 79310,
      "sha256": "52d232847cb711d0d8ce63390c481dbf00a0f8190e26f0585379f163c22cfe73"
    },
    "amm-pool.wasm": {
      "bytes": 86094,
      "sha256": "8cc73b9c1c1fb752c186ff0c3fffddffc85b2c4292a7fa752808e15cce08192d"
    },
    "amm-router.wasm": {
      "bytes": 321937,
      "sha256": "9509f4df9d4c86727c1945865b5f42593e4d51dacd4b0451ee3e164670b0d290"
    }
  }
}
```
