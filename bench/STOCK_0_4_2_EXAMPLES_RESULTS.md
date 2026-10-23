# Counter and Token on the actual Alkanes runtime

Apple M3 Max, darwin arm64; scriptc 0.4.2. Three warmups and 30 measured repetitions per variant/scenario, rotating variant order. All implementations execute through the unmodified upstream indexer, canonical hosts, real UTXO balances and wasmi 0.37.2.

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
| deploy+init | 26637 | 26694 | 94928 | 52901 | 832179.3 | 832958.9 | 837890.7 | 835812.3 |
| fill-10 | 74210 | 74340 | 205642 | 119093 | 2674.2 | 2842.7 | 3076.4 | 3064.2 |
| height+log | 27834 | 28295 | 80134 | 44872 | 2632.4 | 2744.0 | 3030.1 | 2993.9 |
| increment | 26680 | 26826 | 90336 | 50467 | 2943.2 | 3027.3 | 3433.2 | 3409.5 |
| increment-wide | 27042 | 27194 | 94481 | 52825 | 2669.1 | 2845.7 | 3149.0 | 3108.4 |
| read | 23640 | 23789 | 77336 | 43351 | 2662.1 | 2740.0 | 3043.5 | 3005.6 |
| sum-100 | 24999 | 25145 | 69876 | 39781 | 2531.1 | 2686.4 | 2988.5 | 2960.6 |
| sum-10000 | 74319 | 74462 | 112470 | 83212 | 2683.2 | 2802.9 | 3065.7 | 3021.6 |

## Token

| scenario | typescript-before fuel | typescript fuel | rust-o3-lto fuel | rust-o3-lto-wasm-opt fuel | typescript-before µs | typescript µs | rust-o3-lto µs | rust-o3-lto-wasm-opt µs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| deploy+init | 32750 | 32928 | 120868 | 65919 | 839091.7 | 834421.5 | 834452.4 | 835675.5 |
| forward-call | 49981 | 50059 | 115278 | 71766 | 5106.9 | 5219.8 | 6066.5 | 5973.5 |
| mint | 31277 | 31455 | 138509 | 73784 | 2959.1 | 3194.4 | 3681.0 | 3661.0 |
| mint-wide | 31632 | 31823 | 143539 | 76861 | 2732.4 | 2933.4 | 3375.7 | 3312.5 |
| name | 25075 | 25249 | 69656 | 38503 | 2583.3 | 2767.5 | 3186.8 | 3125.4 |
| supply | 27134 | 27314 | 77636 | 42572 | 2639.8 | 2803.9 | 3216.2 | 3181.0 |
| symbol | 25447 | 25621 | 69399 | 38270 | 2573.3 | 2740.4 | 3182.6 | 3095.0 |

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
    },
    "counter-before.wasm": {
      "bytes": 110779,
      "sha256": "057c398ae02561c254cedd9fbcf4b2357f5db60099589589efe0d3d082e629ef"
    },
    "token-before.wasm": {
      "bytes": 105523,
      "sha256": "11fb9b6a8cdd5cde3d1eb1d86d5698a1e7fcb1316d3c03c6038fd8ea77725cbb"
    }
  }
}
```

Reproduce: `ALKANES_RS=/path/to/alkanes-rs npm run test:examples`, `npm run build:bench:examples`, then `ALKANES_RS=/path/to/alkanes-rs npm run bench:examples -- --iterations 30 --baseline dist/examples-before`. Use the upstream/toolchain versions above.
