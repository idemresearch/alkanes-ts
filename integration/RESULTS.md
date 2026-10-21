# CappedToken integration verification

The tests use the upstream Alkanes indexer and its actual transaction, balance, nested-call, rollback and wasmi implementations. No upstream source is modified.

```text
running 5 tests
test successful_callbacks_invalidate_the_caller_storage_cache ... ok
test real_auth_clients_balances_and_rollback ... ok
test initialization_reentry_is_blocked ... ok
test initialization_and_numeric_boundaries ... ok
test authentication_failures_and_reentry ... ok
test result: ok. 5 passed; 0 failed; 0 ignored; 0 filtered out; finished in 18.27s
```

Covered: generated-client CREATE+init bytes; typed ID state; initialization gates and atomic deployment failure; actual upstream auth verification and returned assets; cap/max-u128 boundaries; failed-auth and post-auth rollback; auth and initializer reentry; callback cache invalidation; outgoing Bitcoin UTXO balances; complete TS/Rust response and storage parity.

```json
{
  "upstream": "f9446fdab77cdc12acbc85f8e9c91c9e5ac2f6cb",
  "upstreamTrackedDirty": false,
  "hostRust": "rustc 1.91.1 (ed61e7d7e 2025-11-07)",
  "runner": "wasm-bindgen-test-runner 0.2.127",
  "scriptc": "0.4.0",
  "machine": "Apple M3 Max, darwin arm64",
  "lockSHA256": "d505349e7198a391195700899067d6371ba96e4b0a87d33707b36cc81d3f5945",
  "artifacts": {
    "capped-token.wasm": {
      "bytes": 242080,
      "sha256": "505a634b7d99850cc1cc941480dc1fc31676d75030fc4486d48d357543663028"
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
      "bytes": 235899,
      "sha256": "5481fafb672d4032f8704de4332859dda5e419bee64fea3ca97fb802fb6b176f"
    },
    "cache-caller.wasm": {
      "bytes": 268326,
      "sha256": "875756a406f21eda762f681ca42bf9898eb9489dc4cd3cefbb586de9a0929a20"
    },
    "cache-callee.wasm": {
      "bytes": 259312,
      "sha256": "9b30aef4c31e52410d25b23360ae155aba397ad6c988834af1996dd45e68e510"
    }
  }
}
```
