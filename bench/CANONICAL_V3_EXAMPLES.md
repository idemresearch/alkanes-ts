# Counter and Token on the actual Alkanes runtime

Intel(R) Xeon(R) Processor @ 2.80GHz, linux x64; scriptc 0.4.7. Three warmups and 30 measured repetitions per variant/scenario, rotating variant order. All implementations execute through the unmodified upstream indexer, canonical hosts, real UTXO balances and wasmi 0.37.2.

Fuel is the outer entry allocation minus canonical `FuelTank` remainder, including nested execution and host/storage fees. This upstream trace serializer drops exit fuel, so exit-trace zeros are not used. Median time measures local release-built wasm-bindgen/Node `index_block`, including module compilation and instantiation. Deployment rows include fresh-chain bootstrap, not isolated initializer latency. Fixture construction/inspection is excluded. This is local indexing latency, not RPC latency.

Counter Rust uses the same exact-number fast path up to n=300,000 as TS, plus checked u128 multiplication/addition in the fallback. It also rejects incoming assets on all entrypoints, matching Counter. Both Rust variants use O3, fat LTO, one codegen unit and panic=abort; the final column additionally uses wasm-opt O3. Token preserves caller-ID ownership and legacy forwarding, including duplicate/zero entries. Every repetition checks complete responses and resulting storage across all variants; minted balances are checked against actual outgoing UTXOs. The nested-call scenario uses the same optimized TS Counter callee for every Token variant.

Rust build:

```text
alkanes-rs revision: ea38c878931ff4b6dd64dd011962f2203d6e0a35
alkanes-rs tracked changes: no
upstream Cargo.lock SHA-256: db8c0c61b0060a5b44babcfc262f39707aac1ef36635ebd16d996f6569d2d4e2
Rust: rustc 1.86.0 (05f9846f8 2025-03-31)
profile: opt-level=3, lto=fat, codegen-units=1, panic=abort
wasm-opt: wasm-opt version 125 (version_125)
rust-counter.wasm SHA-256: eb1e826e52c09c56ffd1ca4a9a95d20dbe10ce22bde5aa2bcd0e4ee22760831c
rust-counter-opt.wasm SHA-256: e73a4c43c9e534acea13f8207fcbd8e945c85c8e2ebcfe634efb66c546c9c392
rust-token.wasm SHA-256: 363da8ca7e7559894613ea8dadad43366e0c779a0d9c279aa24f2d90046945b5
rust-token-opt.wasm SHA-256: 79de47ebeac62b8b29725e3ffeea1709c2486c75264cda983038b994cfe7a57d
numeric-fast-path/rust-counter.wasm SHA-256: 52e8cdb32a61eb2fb9f0a77e76e2ccc74cf954594e087304dda429299a3dc374
numeric-fast-path/rust-counter-opt.wasm SHA-256: 0ebca7e46978b742ab33c957cb597875c9239bfc5b46dce4cdb7e737a91781b8
numeric-fast-path/rust-token.wasm SHA-256: ee0f89cf3a80d68550922938f1b119a72e58eb7fcffa31d12cd98a838c6fa391
numeric-fast-path/rust-token-opt.wasm SHA-256: 4a8a51a2ba4d4369a0deefba19d6d7fa0dea2738d1d4221f3d00f73098c5612c
comparison Cargo.lock SHA-256: 6dd4a4b12e278a7727a2923b6c6a476502a07bb43a28e83c321bea462f8588d1
```

## Counter

| scenario | typescript fuel | rust-o3-lto fuel | rust-o3-lto-wasm-opt fuel | typescript µs | rust-o3-lto µs | rust-o3-lto-wasm-opt µs |
|---|---:|---:|---:|---:|---:|---:|
| deploy+init | 11868 | 97383 | 55193 | 3393938.6 | 3255494.6 | 3325481.0 |
| fill-10 | 48254 | 207309 | 120822 | 12751.6 | 15635.3 | 15420.6 |
| height+log | 9270 | 82226 | 46918 | 12536.6 | 15762.6 | 15315.0 |
| increment | 11862 | 93938 | 53254 | 12962.7 | 15761.3 | 15453.0 |
| increment-wide | 12372 | 96898 | 55072 | 12618.1 | 15523.6 | 15186.4 |
| read | 9011 | 80225 | 45734 | 12626.5 | 15287.7 | 15205.0 |
| sum-100 | 9278 | 71880 | 41737 | 12563.8 | 15532.4 | 15393.9 |
| sum-10000 | 58524 | 114378 | 85072 | 12783.2 | 15573.2 | 15552.4 |

## Token

| scenario | typescript fuel | rust-o3-lto fuel | rust-o3-lto-wasm-opt fuel | typescript µs | rust-o3-lto µs | rust-o3-lto-wasm-opt µs |
|---|---:|---:|---:|---:|---:|---:|
| deploy+init | 15192 | 124016 | 68310 | 3333740.1 | 3311450.1 | 3400577.6 |
| forward-call | 16061 | 103039 | 59516 | 26169.4 | 28257.7 | 27901.8 |
| mint | 13706 | 143159 | 77287 | 13475.7 | 16290.7 | 15854.5 |
| mint-wide | 14192 | 147710 | 80222 | 13178.8 | 16026.3 | 15773.4 |
| name | 8202 | 71579 | 40416 | 13142.9 | 15733.2 | 15637.0 |
| supply | 9150 | 80462 | 44931 | 13277.8 | 15895.9 | 15400.4 |
| symbol | 8202 | 71322 | 40183 | 13159.9 | 15777.7 | 15256.3 |

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
      "sha256": "52d232847cb711d0d8ce63390c481dbf00a0f8190e26f0585379f163c22cfe73"
    }
  }
}
```

Reproduce: `ALKANES_RS=/path/to/alkanes-rs npm run test:examples`, `npm run build:bench:examples`, then `ALKANES_RS=/path/to/alkanes-rs npm run bench:examples -- --iterations 30`. Use the upstream/toolchain versions above.
