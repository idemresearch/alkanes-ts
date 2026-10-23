# Counter: native scriptc Alkanes target

30 measured repetitions per scenario and variant after 3 warmups, rotating variant order. Runs through the unmodified Alkanes indexer, canonical env imports, storage/rollback and wasmi 0.37.2. Every repetition checks the complete response and resulting storage against the same reference.

Fuel is the entry allocation minus the canonical FuelTank remainder after indexing a single-invocation block. Median time measures index_block including compilation, instantiation and indexer work; transaction construction and inspection are excluded. Deployment includes chain bootstrap and standard-contract setup. These are local Node/wasm-bindgen timings.

The 0.4.0 C SDK is the current production reference. The 0.4.2 C SDK changes only the scriptc/runtime release; the 0.4.2 native variant additionally replaces the C SDK with TypeScript storage/response handling, emits the Alkanes ABI in the compiler, and lowers checked u128 to scalar LLVM. Both Rust variants use the same Counter numeric fast path, O3, fat LTO, one codegen unit and panic=abort; the second also uses wasm-opt O3. All TypeScript variants use final wasm-opt Oz.

| Scenario | C SDK 0.4.0 fuel | C SDK 0.4.2 fuel | Native generic coercion fuel | Native 0.4.2 fuel | Rust O3/LTO fuel | Rust + wasm-opt fuel | C SDK 0.4.0 µs | C SDK 0.4.2 µs | Native generic coercion µs | Native µs | Rust µs | Rust + wasm-opt µs |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| counter/deploy+init | 26637 | 26694 | 26282 | 23592 | 94928 | 52901 | 843769.1 | 847590.6 | 847703.9 | 841692.9 | 854296.0 | 842952.6 |
| counter/fill-10 | 74210 | 74340 | 88125 | 66833 | 205642 | 119093 | 2564.6 | 2640.5 | 2668.0 | 2840.1 | 3098.3 | 3085.6 |
| counter/height+log | 27834 | 28295 | 27392 | 25139 | 80134 | 44872 | 2588.7 | 2627.7 | 2665.4 | 2829.5 | 3073.3 | 3020.9 |
| counter/increment | 26680 | 26826 | 25885 | 22861 | 90336 | 50467 | 2963.3 | 2968.1 | 3052.3 | 3109.8 | 3451.4 | 3430.1 |
| counter/increment-wide | 27042 | 27194 | 26037 | 23013 | 94481 | 52825 | 2722.9 | 2706.2 | 2726.3 | 2769.3 | 3180.5 | 3128.5 |
| counter/read | 23640 | 23789 | 21714 | 19856 | 77336 | 43351 | 2463.6 | 2522.8 | 2636.5 | 2763.6 | 3084.6 | 3037.1 |
| counter/sum-100 | 24999 | 25145 | 22250 | 20178 | 69876 | 39781 | 2391.2 | 2544.0 | 2533.8 | 2682.3 | 3007.4 | 2970.3 |
| counter/sum-10000 | 74319 | 74462 | 71675 | 69603 | 112470 | 83212 | 2515.6 | 2675.5 | 2661.8 | 2854.8 | 3108.9 | 3066.5 |

## Attribution limits

The two C-SDK versions isolate the scriptc release effect. The native generic-coercion ablation uses identical TypeScript SDK and ABI/intrinsic implementations, with scriptc’s original generic ToUint32 marshalling; its difference from native isolates the compiler coercion optimization. This fast path retains the generic fallback for negative, nonfinite and out-of-range values. Native versus C SDK on 0.4.2 measures the combined compiler-ABI, intrinsic, and SDK implementation change. Read/dispatch and arithmetic-heavy sum/fill rows expose different costs, but their difference is not a pure additive compiler tax. Fuel includes actual runtime host charges; elapsed time also includes compilation and indexing.

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
  },
  "native": {
    "scriptc": "0.4.2",
    "upstream": "4d049fbb8cc719e20cb52cd444b0d54db89f638a",
    "patchSHA256": "96912c5c9c2e9d54d63682e39e6dcf0e2b588688cb313ed146ba8a554546cfa8",
    "sdkSHA256": "3a5ccb042a69096894d838479398622492b9d9bcc13274ebbeebb831d2ec4dac",
    "referenceRelease": "0.4.0"
  }
}
```

Reproduce: `node scripts/native/setup.mjs`, `node scripts/native/build-reference.mjs`, `node scripts/native/build-ablation.mjs`, `npm run test:native`, then `ALKANES_RS=/path/to/alkanes-rs node integration/run.mjs --native-counter --bench --iterations 30`.
