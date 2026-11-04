# Contract shadow-stack size on the actual Alkanes runtime

zig cc gives wasm32 modules a 16 MiB shadow stack placed before the data, so every scriptc contract instance started with 270–272 pages (about 17 MB) of linear memory. Rust contracts start with 17 pages. The build now links a 1 MiB stack, the size Rust uses, and the same contracts start with 29–32 pages. Fuel and every response are unchanged. The stack still precedes the data, so an overflow traps below address 0.

The unmodified alkanes-rs indexer ran at f9446fd on an Intel Xeon @ 2.80GHz (linux x64, 4 vCPU), with 3 warmups and 30 measured repetitions per variant and scenario, rotating variant order. "16 MiB stack" is the previous build; "1 MiB stack" is byte-identical to the current `dist/`. Fuel includes canonical host and storage charges. Times are median `index_block` microseconds, including module compilation and instantiation. On this machine a fixed cost of roughly 11–13 ms per block dominates every row.

## Counter and Token

With the 1 MiB stack every Counter and Token call indexes 1.8–2.9 ms faster, which makes them 14–16% faster than Rust O3/LTO plus wasm-opt O3. With the 16 MiB stack they were within a few percent of Rust.

| scenario | 16 MiB stack fuel | 1 MiB stack fuel | rust-o3-lto fuel | rust-o3-lto-wasm-opt fuel | 16 MiB stack µs | 1 MiB stack µs | rust-o3-lto µs | rust-o3-lto-wasm-opt µs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| deploy+init | 10944 | 10944 | 94928 | 52901 | 2081350.3 | 2087734.1 | 2133491.1 | 2094390.0 |
| fill-10 | 47342 | 47342 | 205642 | 119093 | 15548.5 | 12902.3 | 15608.0 | 14912.6 |
| height+log | 8348 | 8348 | 80134 | 44872 | 15527.2 | 12719.5 | 15454.6 | 15008.9 |
| increment | 10884 | 10884 | 90336 | 50467 | 15733.3 | 12883.0 | 15419.4 | 15206.9 |
| increment-wide | 11298 | 11298 | 94481 | 52825 | 15331.3 | 12843.9 | 15244.2 | 15081.0 |
| read | 8033 | 8033 | 77336 | 43351 | 15244.8 | 12848.7 | 15189.0 | 14916.6 |
| sum-100 | 8366 | 8366 | 69876 | 39781 | 15492.0 | 12997.0 | 15320.0 | 14786.5 |
| sum-10000 | 57660 | 57660 | 112470 | 83212 | 15695.0 | 12947.5 | 15633.3 | 14953.1 |

| scenario | 16 MiB stack fuel | 1 MiB stack fuel | rust-o3-lto fuel | rust-o3-lto-wasm-opt fuel | 16 MiB stack µs | 1 MiB stack µs | rust-o3-lto µs | rust-o3-lto-wasm-opt µs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| deploy+init | 14262 | 14262 | 120868 | 65919 | 2088029.6 | 2073821.7 | 2035354.2 | 2105076.3 |
| forward-call | 14071 | 14071 | 100086 | 56574 | 27726.3 | 25894.5 | 28406.4 | 27798.3 |
| mint | 12452 | 12452 | 138509 | 73784 | 16124.1 | 13290.6 | 15884.7 | 15597.2 |
| mint-wide | 12842 | 12842 | 143539 | 76861 | 15796.7 | 13404.5 | 15801.8 | 15601.9 |
| name | 7290 | 7290 | 69656 | 38503 | 15402.1 | 13188.6 | 15533.5 | 15298.5 |
| supply | 8154 | 8154 | 77636 | 42572 | 15481.9 | 13162.3 | 15565.1 | 15152.6 |
| symbol | 7290 | 7290 | 69399 | 38270 | 15565.7 | 13131.8 | 15649.4 | 15316.3 |

## CappedToken

CappedToken did not show the 16 MiB penalty in either run. The two runs differ by about ±0.5 ms in both directions. The second run is shown first:

| scenario | 16 MiB stack fuel | 1 MiB fuel | Rust O3/LTO fuel | Rust + wasm-opt O3 fuel | 16 MiB stack µs | 1 MiB median µs | Rust median µs | Rust + wasm-opt median µs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| deploy+init | 9589 | 9589 | 111996 | 62463 | 2066279.5 | 2077369.4 | 2071193.1 | 2121673.5 |
| mint+auth | 82045 | 82045 | 308823 | 197787 | 27755.8 | 26992.8 | 31293.0 | 31679.9 |
| mint+auth-wide | 82063 | 82063 | 310224 | 199112 | 27417.6 | 26150.5 | 31559.2 | 31544.6 |
| supply | 4008 | 4008 | 94194 | 51454 | 12107.9 | 11789.5 | 15957.7 | 16025.7 |
| authority | 4141 | 4141 | 93446 | 51240 | 12036.7 | 11851.8 | 15886.3 | 15871.0 |
| cap | 4012 | 4012 | 93863 | 51209 | 12138.1 | 11449.8 | 15901.1 | 15855.9 |

First run:

| scenario | 16 MiB stack fuel | 1 MiB fuel | Rust O3/LTO fuel | Rust + wasm-opt O3 fuel | 16 MiB stack µs | 1 MiB median µs | Rust median µs | Rust + wasm-opt median µs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| deploy+init | 9589 | 9589 | 111996 | 62463 | 2085347.5 | 2115953.9 | 2056488.9 | 2109055.8 |
| mint+auth | 82045 | 82045 | 308823 | 197787 | 26929.9 | 27984.1 | 30890.9 | 30556.3 |
| mint+auth-wide | 82063 | 82063 | 310224 | 199112 | 27216.1 | 27092.4 | 31324.2 | 30398.1 |
| supply | 4008 | 4008 | 94194 | 51454 | 11720.1 | 12187.7 | 15575.9 | 15376.3 |
| authority | 4141 | 4141 | 93446 | 51240 | 11476.8 | 12172.8 | 15947.3 | 15618.9 |
| cap | 4012 | 4012 | 93863 | 51209 | 11732.9 | 12196.5 | 15971.5 | 15365.2 |

Build metadata (Counter/Token run):

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
      "bytes": 79412,
      "sha256": "b6415eefa7c7c8386a6191ba6b0c449093eeeac3193ce83db391f1e1155bfb63"
    },
    "counter-before.wasm": {
      "bytes": 85559,
      "sha256": "a2cb76fd58db2382a984c4a7d8fa8dcbd7c35cc19a752ef037a2c6d35588e462"
    },
    "token-before.wasm": {
      "bytes": 93412,
      "sha256": "284a7e9dbd44f39a2898b6893a43b805d1b5bdc41110ce6ca8b4e71c6a641ee0"
    }
  }
}
```
