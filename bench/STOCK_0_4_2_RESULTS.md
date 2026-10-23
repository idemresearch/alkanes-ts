# Stock scriptc 0.4.2 with the C SDK

Counter, Token and CappedToken use the unchanged C-SDK build path. The installed compiler binary matches its official npm native package. Compiler, runtime and types are pinned together at 0.4.2; no compiler patches are applied or executed for this qualification. Authored contracts, SDK C sources and Rust fixtures are unchanged by the upgrade.

30 measured repetitions after three warmups per variant/scenario, rotating variant order, on Apple M3 Max, darwin arm64. Every invocation runs through the unmodified Alkanes indexer, canonical hosts and wasmi 0.37.2. Complete responses and resulting storage must match across variants; Token/CappedToken mint scenarios also verify actual UTXO balances.

Fuel includes contract instructions, host/storage charges and nested execution. Time is local release-built wasm-bindgen/Node index_block latency, including Wasm compilation and instantiation. Transaction construction and inspection are excluded. Deployment includes fresh-chain bootstrap and standard-contract setup, so its time is not isolated initializer/deployment latency. No other builds/tests ran concurrently with timed benchmarks.

Both Rust variants use O3, fat LTO, one codegen unit and panic=abort. The stronger reference below also uses wasm-opt O3. Counter Rust has the same exact numeric sum fast path as TypeScript. TypeScript uses final wasm-opt Oz. CappedToken uses the same standard auth binary for every variant; nested Token calls use the same stock TypeScript Counter callee. Full per-variant tables and build provenance are in the linked reports.

## counter

| Call | Stock TS fuel | Rust + wasm-opt fuel | Stock TS median ms | Rust + wasm-opt median ms |
|---|---:|---:|---:|---:|
| deploy+init | 26694 | 52901 | 832.959 | 835.812 |
| fill-10 | 74340 | 119093 | 2.843 | 3.064 |
| height+log | 28295 | 44872 | 2.744 | 2.994 |
| increment | 26826 | 50467 | 3.027 | 3.410 |
| increment-wide | 27194 | 52825 | 2.846 | 3.108 |
| read | 23789 | 43351 | 2.740 | 3.006 |
| sum-100 | 25145 | 39781 | 2.686 | 2.961 |
| sum-10000 | 74462 | 83212 | 2.803 | 3.022 |

## token

| Call | Stock TS fuel | Rust + wasm-opt fuel | Stock TS median ms | Rust + wasm-opt median ms |
|---|---:|---:|---:|---:|
| deploy+init | 32928 | 65919 | 834.421 | 835.676 |
| forward-call | 50059 | 71766 | 5.220 | 5.974 |
| mint | 31455 | 73784 | 3.194 | 3.661 |
| mint-wide | 31823 | 76861 | 2.933 | 3.312 |
| name | 25249 | 38503 | 2.767 | 3.125 |
| supply | 27314 | 42572 | 2.804 | 3.181 |
| symbol | 25621 | 38270 | 2.740 | 3.095 |

## capped-token

| Call | Stock TS fuel | Rust + wasm-opt fuel | Stock TS median ms | Rust + wasm-opt median ms |
|---|---:|---:|---:|---:|
| authority | 19827 | 51240 | 2.271 | 3.252 |
| cap | 20487 | 51209 | 2.235 | 3.218 |
| deploy+init | 28670 | 62463 | 859.703 | 866.756 |
| mint+auth | 109324 | 197787 | 5.731 | 6.837 |
| mint+auth-wide | 109342 | 199112 | 5.756 | 6.794 |
| supply | 20166 | 51454 | 2.346 | 3.339 |

## Paired upgrade from stock scriptc 0.4.0

The baseline uses the same C SDK and contract sources, not the older bigint backend. These percentages compare variants within this run. Positive values mean the 0.4.2 build consumes more fuel or takes more time; local timing differences do not establish a universal performance change.

| Scenario | Before fuel | 0.4.2 fuel | Fuel change | Median time change |
|---|---:|---:|---:|---:|
| counter/deploy+init | 26637 | 26694 | 0.21% | 0.09% |
| counter/fill-10 | 74210 | 74340 | 0.18% | 6.30% |
| counter/height+log | 27834 | 28295 | 1.66% | 4.24% |
| counter/increment | 26680 | 26826 | 0.55% | 2.85% |
| counter/increment-wide | 27042 | 27194 | 0.56% | 6.61% |
| counter/read | 23640 | 23789 | 0.63% | 2.93% |
| counter/sum-100 | 24999 | 25145 | 0.58% | 6.14% |
| counter/sum-10000 | 74319 | 74462 | 0.19% | 4.46% |
| token/deploy+init | 32750 | 32928 | 0.54% | -0.56% |
| token/forward-call | 49981 | 50059 | 0.16% | 2.21% |
| token/mint | 31277 | 31455 | 0.57% | 7.95% |
| token/mint-wide | 31632 | 31823 | 0.60% | 7.36% |
| token/name | 25075 | 25249 | 0.69% | 7.13% |
| token/supply | 27134 | 27314 | 0.66% | 6.22% |
| token/symbol | 25447 | 25621 | 0.68% | 6.49% |
| capped-token/authority | 20626 | 19827 | -3.87% | 4.20% |
| capped-token/cap | 19306 | 20487 | 6.12% | 4.17% |
| capped-token/deploy+init | 28360 | 28670 | 1.09% | 1.10% |
| capped-token/mint+auth | 108865 | 109324 | 0.42% | 1.69% |
| capped-token/mint+auth-wide | 108883 | 109342 | 0.42% | 1.28% |
| capped-token/supply | 19978 | 20166 | 0.94% | 4.01% |

Baseline build provenance:

```json
{
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
}
```

## Reproduction and evidence

`npm ci`, `npm run typecheck`, `npm test`, `ALKANES_RS=/path/to/alkanes-rs npm run test:examples`, then `ALKANES_RS=/path/to/alkanes-rs npm run bench:stock -- --iterations 30 --baseline /path/to/saved-0.4.0-dist`.

The optional version baseline can be reproduced by building revision aa4baa1d3dcf6c060a5ed7a381c8e9a261572456 in a separate checkout with its stock 0.4.0 lockfile. Copy its counter/token/capped-token Wasm files into the baseline directory. This run saved the pre-upgrade files directly; their hashes appear above and in both detailed reports.

- [Counter and Token: all variants](STOCK_0_4_2_EXAMPLES_RESULTS.md)
- [CappedToken: all variants](STOCK_0_4_2_CAPPED_TOKEN_RESULTS.md)
- [Actual-runtime correctness](../integration/EXAMPLES_RESULTS.md)

Stock toolchain provenance:

```json
{
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
}
```
