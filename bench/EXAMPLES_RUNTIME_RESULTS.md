# Counter and Token on the actual Alkanes runtime

Apple M3 Max, darwin arm64; scriptc 0.4.0. Three warmups and 30 measured repetitions per variant/scenario, rotating variant order. All implementations execute through the unmodified upstream indexer, canonical hosts, real UTXO balances and wasmi 0.37.2.

Fuel is the outer entry allocation minus canonical `FuelTank` remainder, including nested execution and host/storage fees. This upstream trace serializer drops exit fuel, so exit-trace zeros are not used. Median time measures local release-built wasm-bindgen/Node `index_block`, including module compilation and instantiation. Deployment rows include fresh-chain bootstrap, not isolated initializer latency. Fixture construction/inspection is excluded. This is local indexing latency, not RPC latency.

Counter Rust uses the same exact-number fast path up to n=300,000 as TS, plus checked u128 multiplication/addition in the fallback. It also rejects incoming assets on all entrypoints, matching Counter. Both Rust variants use O3, fat LTO, one codegen unit and panic=abort; the final column additionally uses wasm-opt O3. Token preserves caller-ID ownership and legacy forwarding, including duplicate/zero entries. Every repetition checks complete responses and resulting storage across all variants; minted balances are checked against actual outgoing UTXOs. The nested-call scenario uses the same optimized TS Counter callee for every Token variant.

Rust build:

```text
alkanes-rs revision: f9446fdab77cdc12acbc85f8e9c91c9e5ac2f6cb
alkanes-rs tracked changes: no
upstream Cargo.lock SHA-256: 0da32fe8c3a3e794b8aba19c29f6229ceaf7e8dad5b03d54bfe9a829edafaf9a
Rust: rustc 1.86.0 (05f9846f8 2025-03-31)
profile: opt-level=3, lto=fat, codegen-units=1, panic=abort
wasm-opt: wasm-opt version 125 (version_125)
rust-counter.wasm SHA-256: 319243bed69b06bfede6599bb62602f484fdafa42fce2485f3df3cf8e8b13de7
rust-counter-opt.wasm SHA-256: e71e877a7441db144055866754aa497119b71bfacee0cf3733d848c82682c3b5
rust-token.wasm SHA-256: 7a9ccf1eaf630022b1ae29a47b62119cfd1fd35966b2c5c02feab019b092442e
rust-token-opt.wasm SHA-256: d2d63907a32da6b1d837a5f03b4f5af0e4e902a674a2f5ca7026558f760af792
numeric-fast-path/rust-counter.wasm SHA-256: 80d6f8ec123d1550ad43a4ead7ba22a1381f71b5e152618a1554d00cfb2c64fd
numeric-fast-path/rust-counter-opt.wasm SHA-256: 6264dc1a53e8cc018d67e3cd39f559cbeb6ee3d83015f2acae447903e97bff6c
numeric-fast-path/rust-token.wasm SHA-256: c1f690293ad00a8e8c4d3f6199423e8aafd4e212614a35d4b9f82b3d1e3a79cc
numeric-fast-path/rust-token-opt.wasm SHA-256: eefa58e939fa886be5161dc645334a31df455e08a6274e025b849735eb673194
comparison Cargo.lock SHA-256: a39226658084ac848cdfb099d0f1e00fd7d5fa0346bbf8d088d86e10eccb4a31
```

## Counter

| scenario | typescript-before fuel | typescript fuel | rust-o3-lto fuel | rust-o3-lto-wasm-opt fuel | typescript-before µs | typescript µs | rust-o3-lto µs | rust-o3-lto-wasm-opt µs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| deploy+init | 67824 | 26637 | 94928 | 52901 | 853635.1 | 849404.8 | 853588.9 | 851743.0 |
| fill-10 | 171493 | 74210 | 205642 | 119093 | 6005.7 | 2748.6 | 3107.4 | 3054.3 |
| height+log | 64132 | 27834 | 80134 | 44872 | 5718.3 | 2704.7 | 3049.0 | 3032.9 |
| increment | 69860 | 26680 | 90336 | 50467 | 6068.4 | 3087.8 | 3460.9 | 3469.4 |
| increment-wide | 74378 | 27042 | 94481 | 52825 | 5887.0 | 2808.8 | 3147.0 | 3136.0 |
| read | 60514 | 23640 | 77336 | 43351 | 5841.0 | 2701.3 | 3063.8 | 3018.4 |
| sum-100 | 56880 | 24999 | 69876 | 39781 | 5704.2 | 2617.0 | 3028.5 | 2952.9 |
| sum-10000 | 104759 | 74319 | 112470 | 83212 | 5838.6 | 2755.6 | 3130.1 | 3045.1 |

## Token

| scenario | typescript-before fuel | typescript fuel | rust-o3-lto fuel | rust-o3-lto-wasm-opt fuel | typescript-before µs | typescript µs | rust-o3-lto µs | rust-o3-lto-wasm-opt µs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| deploy+init | 94379 | 32750 | 120868 | 65919 | 851167.4 | 838660.6 | 857036.5 | 863665.1 |
| forward-call | 101285 | 49978 | 115275 | 71763 | 9402.4 | 4998.3 | 6005.3 | 5916.5 |
| mint | 103230 | 31277 | 138509 | 73784 | 7587.2 | 3078.1 | 3695.7 | 3635.8 |
| mint-wide | 107337 | 31632 | 143539 | 76861 | 7256.3 | 2792.8 | 3366.4 | 3380.4 |
| name | 70507 | 25075 | 69656 | 38503 | 6913.2 | 2587.9 | 3177.0 | 3122.9 |
| supply | 77335 | 27134 | 77636 | 42572 | 7006.2 | 2659.9 | 3253.0 | 3216.8 |
| symbol | 70370 | 25447 | 69399 | 38270 | 6907.4 | 2585.9 | 3211.3 | 3143.3 |

Build metadata:

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
    },
    "counter-before.wasm": {
      "bytes": 226144,
      "sha256": "df8373aac8b614859d65d60644cd11eafb32c243cadb9cc2d57747ba05ace580"
    },
    "token-before.wasm": {
      "bytes": 274295,
      "sha256": "9f8805bd4deb0fa9db73bc7a53c742de91555f3b54e488ed7f98ba51b413f30b"
    }
  }
}
```

Reproduce: `ALKANES_RS=/path/to/alkanes-rs npm run test:examples`, `npm run build:bench:examples`, then `ALKANES_RS=/path/to/alkanes-rs npm run bench:examples -- --iterations 30 --baseline dist/examples-before`. Use the upstream/toolchain versions above.
