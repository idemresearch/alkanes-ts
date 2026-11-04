# Word lowering for ShareVault, TimelockTreasury and AmmRouter

ShareVault, TimelockTreasury and AmmRouter used to fall back to the general bigint backend, because word-v1 did not support `height()`, `AlkaneId` equality and construction, `assets.available`, or external calls. With the [chain-query and external-call leaves](../docs/WORD_LOWERING.md#chain-queries-and-external-calls), every contract in the repository now uses a fixed-width lowering. Counter and Token use word-sdk-v1; the other five use word-v1. `test/word-advanced.test.mjs` checks that the three new word-v1 contracts behave identically on both backends.

Instruction fuel comes from the in-repo wasmi 0.37.2 host model (`node bench/measure-wasmi.mjs`). Each row is the fuel of a scenario's last call. The script fails if the two builds' observable results differ in any way: response data, transfers, reverts or logs.

Fuel excludes canonical host and storage surcharges. Auth calls include the callee: the authority is the TypeScript test fixture `test/fixtures/test-auth.ts`, which runs on the bigint backend and accounts for most of those rows. The router's swaps include the AmmPool calls, which are the same `dist/amm-pool.wasm` in both columns.

- **bigint:** the previous builds, with contract sources as of commit `a20fbe7`.
- **word:** this change.

Counter, Token, CappedToken and AmmPool are controls:

- Counter, Token and AmmPool changed only in code layout. They keep the same sizes and use the same fuel.
- CappedToken's auth now goes through the shared host-call path, which costs 23 more fuel per mint and 91 more bytes.

Reproduce with `npm run build`, then `node bench/measure-wasmi.mjs bigint=<previous dist> word=dist`.

| contract | scenario | bigint | word | word vs bigint |
|---|---|---:|---:|---:|
| counter | initialize | 4761 | 4761 | 0% |
| counter | increment | 5749 | 5749 | 0% |
| counter | get_count | 3890 | 3890 | 0% |
| counter | revert (write, then throw) | 4721 | 4721 | 0% |
| counter | height + log | 4205 | 4205 | 0% |
| counter | sum(n=100) | 4431 | 4431 | 0% |
| counter | fill(n=10) | 24607 | 24607 | 0% |
| counter | __meta | 371 | 371 | 0% |
| token | initialize | 7232 | 7232 | 0% |
| token | mint (owner) | 7234 | 7234 | 0% |
| token | name | 3344 | 3344 | 0% |
| token | total supply | 4208 | 4208 | 0% |
| token | __meta | 372 | 372 | 0% |
| capped-token | initialize | 4689 | 4689 | 0% |
| capped-token | supply view | 3756 | 3756 | 0% |
| capped-token | authority view | 3884 | 3884 | 0% |
| capped-token | cap view | 3755 | 3755 | 0% |
| capped-token | mint (auth) | 53883 | 53906 | +0.0% |
| capped-token | __meta | 1415 | 1415 | 0% |
| amm-pool | initialize | 6272 | 6272 | 0% |
| amm-pool | first addLiquidity | 13813 | 13813 | 0% |
| amm-pool | addLiquidity with refund | 17332 | 17332 | 0% |
| amm-pool | swap 0->1 | 12784 | 12784 | 0% |
| amm-pool | swap 1->0 | 12748 | 12748 | 0% |
| amm-pool | removeLiquidity | 14267 | 14267 | 0% |
| amm-pool | reserve view | 3771 | 3771 | 0% |
| amm-pool | quote view | 6089 | 6089 | 0% |
| amm-pool | __meta | 1425 | 1425 | 0% |
| share-vault | initialize | 71337 | 6864 | -90.4% |
| share-vault | first deposit | 98165 | 11480 | -88.3% |
| share-vault | second deposit | 104026 | 11469 | -89.0% |
| share-vault | redeem | 113563 | 10766 | -90.5% |
| share-vault | harvest (auth + yield) | 229794 | 57190 | -75.1% |
| share-vault | deposit while vesting | 121662 | 13845 | -88.6% |
| share-vault | previewDeposit view | 52808 | 7516 | -85.8% |
| share-vault | lockedProfit view | 54891 | 6409 | -88.3% |
| share-vault | __meta | 2649 | 1427 | -46.1% |
| timelock-treasury | initialize | 75378 | 6893 | -90.9% |
| timelock-treasury | deposit | 65226 | 6555 | -90.0% |
| timelock-treasury | schedule (auth) | 197012 | 55252 | -72.0% |
| timelock-treasury | execute (auth + payout) | 213853 | 56540 | -73.6% |
| timelock-treasury | cancel (auth) | 166355 | 53975 | -67.6% |
| timelock-treasury | pending asset view | 44825 | 4516 | -89.9% |
| timelock-treasury | held view | 52235 | 4115 | -92.1% |
| timelock-treasury | __meta | 2647 | 1426 | -46.1% |
| amm-router | version view | 27466 | 2560 | -90.7% |
| amm-router | swap1 (one pool) | 123613 | 20704 | -83.3% |
| amm-router | swap2 (two pools) | 189197 | 37148 | -80.4% |
| amm-router | swap1 slippage revert | 123862 | 20697 | -83.3% |
| amm-router | __meta | 2638 | 1418 | -46.2% |

| contract | variant | bytes | gzip | code section | SHA-256 |
|---|---|---:|---:|---:|---|
| counter | bigint | 85430 | 41013 | 56059 | `46154531f68c961babf5161d289b6014987d8947086e49703edc48df1cf939de` |
| counter | word | 85430 | 41012 | 56059 | `3ecfb0778db50f40437052c4879656cee5e141bbfecb1d70329a0b50f0f53b26` |
| token | bigint | 93286 | 44144 | 64383 | `53b0076e9eb057e5f2a2be12badc717e76dda267159bbbf497eb4133d375b238` |
| token | word | 93286 | 44144 | 64383 | `531c00bcfb73a3bd2a6a988a328fb927f59416b8b0eb7629a366630d011381f5` |
| capped-token | bigint | 70364 | 35662 | 44898 | `828b2422dad7c8283e9adf84396af93e17259324d8e4a5c12887adc496338e1d` |
| capped-token | word | 70455 | 35731 | 44989 | `c97f2497534b5d6c4339535f605a5a68531ad5706b6fdac99ddc4c8ea1284d9e` |
| amm-pool | bigint | 86094 | 40296 | 58083 | `8cc73b9c1c1fb752c186ff0c3fffddffc85b2c4292a7fa752808e15cce08192d` |
| amm-pool | word | 86094 | 40296 | 58083 | `8df6cccf1c25fce20de0c9b2a7958b91bf96190f0849fc4c132c31bb3601be5a` |
| share-vault | bigint | 342989 | 141648 | 292488 | `ffdf9ec460e1e805f5156915e925012612a58a9a31ea5617612421363e276f25` |
| share-vault | word | 90704 | 41984 | 61923 | `d03dd1bb541841f7b98bb7a63a47be72b39b5c7c0610ee5e1d5d52b8d879cf8b` |
| timelock-treasury | bigint | 337413 | 140343 | 287250 | `e943da7699d576e35be24a45b2ad5e291788cd3a9ef0b2cbaab979b36f5f8e4b` |
| timelock-treasury | word | 83029 | 38859 | 54417 | `6dca9bd00e3b3c395f4431c147823f71ce073570d98ebd196d89ce84221d0b5d` |
| amm-router | bigint | 321937 | 136268 | 275051 | `9509f4df9d4c86727c1945865b5f42593e4d51dacd4b0451ee3e164670b0d290` |
| amm-router | word | 71417 | 36378 | 46334 | `0d2ab3730f18550d6fa5bd30dda566cc3cf387fa683c1839df238f1f76b60f20` |
