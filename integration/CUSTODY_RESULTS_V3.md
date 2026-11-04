# Counter, Token, CappedToken and custody contract integration verification

The tests use the upstream Alkanes indexer and its actual transaction, balance, nested-call, rollback and wasmi implementations. No upstream source is modified.

```text
test custody::timelock_treasury_pays_out_inside_its_window_with_real_auth ... ok
test custody::share_vault_vests_harvested_yield_with_real_auth ... ok
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
test result: ok. 13 passed; 0 failed; 0 ignored; 0 filtered out; finished in 142.46s
```

Covered: generated-client CREATE+init bytes; typed ID state; initialization gates and atomic deployment failure; actual upstream auth verification and returned assets; cap/max-u128 boundaries; failed-auth and post-auth rollback; auth and initializer reentry; callback cache invalidation; outgoing Bitcoin UTXO balances; complete TS/Rust response and storage parity. Additional Counter/Token coverage: checked wide increments/mints, numeric loops, storage fill, height, metadata responses, caller ownership, real UTXO balances and nested-call rollback. Custody coverage, with real UTXO balances and custody read from the indexer balance table: AmmPool deposits, swaps and redemptions; AmmRouter two-hop routes and slippage rollback; ShareVault deposits, an authenticated harvest with linear vesting, and redemption; TimelockTreasury deposits, authenticated scheduling, execution inside the window, expiry, replacement and cancellation. ShareVault and TimelockTreasury authenticate with the upstream auth token.

Custody calls (one run each; fuel includes nested calls and host/storage charges):

| scenario | fuel | µs |
|---|---:|---:|
| timelock-treasury deploy+initialize (real auth) | 91835 | 134632.1 |
| timelock-treasury deposit | 9965 | 17550.3 |
| timelock-treasury schedule (real auth) | 92276 | 61309.2 |
| timelock-treasury execute (real auth + payout) | 88576 | 31058.6 |
| timelock-treasury cancel (real auth) | 86051 | 32114.0 |
| share-vault deploy+initialize | 14873 | 19467.3 |
| share-vault first deposit | 17445 | 18927.8 |
| share-vault harvest (real auth + yield) | 94136 | 40204.3 |
| share-vault redeem | 18821 | 14947.1 |
| amm-router swap2 (two pools) | 51474 | 41443.5 |
| amm-pool deploy+initialize | 12747 | 13614.2 |
| amm-pool first addLiquidity | 21471 | 20434.5 |
| amm-pool quote view | 7477 | 16314.1 |
| amm-pool swap | 19251 | 18305.4 |
| amm-pool removeLiquidity | 21964 | 18287.6 |

```json
{
  "zig": "0.17.0",
  "binaryen": "wasm-opt version 125 (version_125)",
  "lowering": {
    "counter": "word-sdk-v1",
    "token": "word-sdk-v1"
  },
  "nativeSDKSourceSHA256": "c286d71301255d4cb347aa75642501c1c656856168e49b21b937e89bcf98e733",
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
      "bytes": 70455,
      "sha256": "c97f2497534b5d6c4339535f605a5a68531ad5706b6fdac99ddc4c8ea1284d9e"
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
      "bytes": 66535,
      "sha256": "10bcc845862cfe8e10894d0288f196af4c8a4888e37ce886eb5015a971409b4d"
    },
    "cache-caller.wasm": {
      "bytes": 87817,
      "sha256": "827589f03a45fe84a61d11eba3e3dff37bfa3bc6aa947fb3d7742986ae433885"
    },
    "cache-callee.wasm": {
      "bytes": 84650,
      "sha256": "7d9011339107e14fc59995d5a25beeaa6f6aee2fcf03005dadc7bc68102517c2"
    },
    "word.wasm": {
      "bytes": 77701,
      "sha256": "ab3b3383dfc28b2e454d4856d30fb455167c6816094b93a8613f58c1a5cdc0f6"
    },
    "counter.wasm": {
      "bytes": 85430,
      "sha256": "3ecfb0778db50f40437052c4879656cee5e141bbfecb1d70329a0b50f0f53b26"
    },
    "token.wasm": {
      "bytes": 93286,
      "sha256": "531c00bcfb73a3bd2a6a988a328fb927f59416b8b0eb7629a366630d011381f5"
    },
    "counter-rust.wasm": {
      "bytes": 161531,
      "sha256": "52e8cdb32a61eb2fb9f0a77e76e2ccc74cf954594e087304dda429299a3dc374"
    },
    "counter-rust-opt.wasm": {
      "bytes": 122624,
      "sha256": "0ebca7e46978b742ab33c957cb597875c9239bfc5b46dce4cdb7e737a91781b8"
    },
    "token-rust.wasm": {
      "bytes": 171622,
      "sha256": "363da8ca7e7559894613ea8dadad43366e0c779a0d9c279aa24f2d90046945b5"
    },
    "token-rust-opt.wasm": {
      "bytes": 130384,
      "sha256": "79de47ebeac62b8b29725e3ffeea1709c2486c75264cda983038b994cfe7a57d"
    },
    "word-relay.wasm": {
      "bytes": 79310,
      "sha256": "4e9930f2da69c7afddb9f6673d8b569fda195a1caef40ae5ae304ef40dd3e0eb"
    },
    "amm-pool.wasm": {
      "bytes": 86094,
      "sha256": "8df6cccf1c25fce20de0c9b2a7958b91bf96190f0849fc4c132c31bb3601be5a"
    },
    "amm-router.wasm": {
      "bytes": 71417,
      "sha256": "0d2ab3730f18550d6fa5bd30dda566cc3cf387fa683c1839df238f1f76b60f20"
    },
    "share-vault.wasm": {
      "bytes": 90795,
      "sha256": "7cb762252de12fb33d7d89f805cc4ed7f9dddbb9f93ba29eef3d1b0e486a44ae"
    },
    "timelock-treasury.wasm": {
      "bytes": 83114,
      "sha256": "75fec120bd3e381e9826835aaef7875ce16e7262071d97473edc2e4417bae644"
    }
  }
}
```
