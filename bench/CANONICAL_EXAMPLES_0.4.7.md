# Counter and Token on the actual Alkanes runtime

Intel(R) Xeon(R) Processor @ 2.80GHz, linux x64; scriptc 0.4.7. Three warmups and 30 measured repetitions per variant/scenario, rotating variant order. All implementations execute through the unmodified upstream indexer, canonical hosts, real UTXO balances and wasmi 0.37.2.

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
rust-counter.wasm SHA-256: 34b03cdc0f40daaa0552b4eeef986a202ce06be8082295e17071847751898891
rust-counter-opt.wasm SHA-256: cc80af5c99c4a7e69e263773b3b760ff6d559a248198a5857667acb6054c3b6c
rust-token.wasm SHA-256: e07d532dd7f1587cacd1e294ef080ab009109f5989ba1846402f0866154e2316
rust-token-opt.wasm SHA-256: ebb444a8bb6e15d6d638d768d9a64e6359b5f1783e497692d001b29e1041fc0c
numeric-fast-path/rust-counter.wasm SHA-256: 17506f581ccdb92122781bb9264695fe481c7f42c17d58d8b73e7786c1f80bde
numeric-fast-path/rust-counter-opt.wasm SHA-256: 4d727e8ae75edcea5cb226c8964a8778269b8785f7fb3bbc7cb97f7bbf689ae4
numeric-fast-path/rust-token.wasm SHA-256: bd4c14d11fca35680a94128d23ac9619615c0e262591e59a41380ddb52775e5c
numeric-fast-path/rust-token-opt.wasm SHA-256: f2f2cbfd4f68f874c89e6fd40246b1ccd944bb1fe425609ab33a5300f3770a3b
comparison Cargo.lock SHA-256: a39226658084ac848cdfb099d0f1e00fd7d5fa0346bbf8d088d86e10eccb4a31
```

## Counter

| scenario | typescript fuel | rust-o3-lto fuel | rust-o3-lto-wasm-opt fuel | typescript µs | rust-o3-lto µs | rust-o3-lto-wasm-opt µs |
|---|---:|---:|---:|---:|---:|---:|
| deploy+init | 10944 | 94928 | 52901 | 2078444.1 | 2090416.4 | 2066553.9 |
| fill-10 | 47342 | 205642 | 119093 | 16112.4 | 15723.0 | 15625.8 |
| height+log | 8348 | 80134 | 44872 | 15842.2 | 15740.5 | 15525.6 |
| increment | 10884 | 90336 | 50467 | 16111.7 | 15416.9 | 15610.6 |
| increment-wide | 11298 | 94481 | 52825 | 15858.4 | 15393.6 | 15449.3 |
| read | 8033 | 77336 | 43351 | 15773.9 | 15573.0 | 15452.0 |
| sum-100 | 8366 | 69876 | 39781 | 15791.3 | 15753.3 | 15323.1 |
| sum-10000 | 57660 | 112470 | 83212 | 15985.8 | 15736.3 | 15473.1 |

## Token

| scenario | typescript fuel | rust-o3-lto fuel | rust-o3-lto-wasm-opt fuel | typescript µs | rust-o3-lto µs | rust-o3-lto-wasm-opt µs |
|---|---:|---:|---:|---:|---:|---:|
| deploy+init | 14262 | 120868 | 65919 | 2069558.3 | 2100175.8 | 2101793.6 |
| forward-call | 14071 | 100086 | 56574 | 28099.8 | 31763.4 | 29874.5 |
| mint | 12452 | 138509 | 73784 | 16556.9 | 16229.1 | 15917.4 |
| mint-wide | 12842 | 143539 | 76861 | 16184.8 | 16402.1 | 15462.9 |
| name | 7290 | 69656 | 38503 | 15979.0 | 15928.0 | 15006.4 |
| supply | 8154 | 77636 | 42572 | 16347.6 | 16117.4 | 15248.6 |
| symbol | 7290 | 69399 | 38270 | 16018.9 | 16081.6 | 15043.1 |

Build metadata:

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
    }
  }
}
```

Reproduce: `ALKANES_RS=/path/to/alkanes-rs npm run test:examples`, `npm run build:bench:examples`, then `ALKANES_RS=/path/to/alkanes-rs npm run bench:examples -- --iterations 30`. Use the upstream/toolchain versions above.
