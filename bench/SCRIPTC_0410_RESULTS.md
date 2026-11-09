# scriptc 0.4.10 and adapter-side argument conversion

Instruction fuel and module size for the production contracts, measured with `node bench/measure-wasmi.mjs` on the in-repo wasmi 0.37.2 host model (`harness/`, Linux x86_64). Fuel excludes canonical host/storage surcharges. The script runs every scenario on each variant and fails unless the observable results (response data, transfers, reverts and logs) are identical. Each row is the fuel of the scenario's last call.

Variants, all built from the same contract sources with Zig 0.17.0 and Binaryen 125:

- **0.4.7**: the previous production build (commit `fc186b1`).
- **0.4.10**: scriptc, runtime and types 0.4.10 with no other change.
- **current**: 0.4.10, u32 callback arguments converted in the adapter instead of by scriptc, and `wasm-opt -Oz --converge`.

## What the upgrade changed

Nothing needed porting: 0.4.10 compiles the SDK, the lowered contracts and every test fixture unchanged, and all tests pass. On its own it leaves fuel where it was (at most +0.3%) and adds 3.1–3.7 KB of code to every module. `npm run size` attributes that to the runtime's reference-counting code, which this repository does not control:

| function | 0.4.7 | 0.4.10 |
|---|---:|---:|
| `scr_dyn_dispose` | — | 2,491 |
| `scr_dyn_destroy` | 1,311 | 7 |
| `scr_weak_disposed` | 1,076 | — |
| `scr_cyc_on_release` | 7,040 | 7,916 |
| `scr_weak_unlink` | — | 845 |
| `scr_cyc_route_bypassed` | 466 | — |
| `scr_map_destroy` | — | 430 |
| `scr_dyn_release` | 638 | 1,044 |
| `scr_cyc_walked` | — | 380 |
| `scr_arr_get_f64` | 916 | 1,243 |

Reproduce with an isolated 0.4.7 toolchain (`buildLibrary({ compiler, runtimePack })`, as in `bench/build-optimization.mjs`) and `node scripts/size.mjs <old>/named.wasm <contract>`.

## Where the fuel went

A call-count profile of a Counter read showed 26 calls of `scr_bit_ushr` in a 3,898-fuel call. scriptc converts every callback argument declared `u32` with that function, an out-of-line `ToUint32` of about 25 instructions, before truncating the result again. It does so for constants and for values typed `Int32`, and for `i32` parameters with the signed counterpart, so no annotation avoids it. An `f64` parameter is passed unchanged.

The word SDK makes 19 callbacks for a view and 33 for an increment, most with two to four handle arguments. The build profile now declares those arguments `f64`, and the generated adapter converts each one inline: `i32.trunc_sat_f64_u`, convert back, compare. A value that is not an exact u32 takes the adapter's own `ToUint32` (`U32_CONVERSION` in `compiler/word-abi.mjs`), so the result is the one scriptc computed for every double; `test/word-abi.test.mjs` checks that against JavaScript's `>>> 0` on 300,000 bit patterns and the boundary values. The hand-written adapter of the general bigint backend does the same for `__alk_scratch_read`, the callback every host read repeats.

Ordinary calls use 7–29% less fuel than on 0.4.7 (most of them 13–28%), and the modules are 0.1–2.2 KB smaller than plain 0.4.10 because the call sites lost their conversion calls. `--converge` contributes about 0.7% of the fuel reduction. The authenticated rows change less (2–5%) because most of their fuel is the authority fixture, a bigint-backend contract that is the same binary for every variant. The `__meta` rows are constant data.

## What is left

- **Status checks are callbacks.** 5 of the 19 callbacks in a view and 10 of the 33 in an increment are `__w_status`, the check after each fallible operation. Returning the status with the operation's result would remove about a quarter of all callbacks.
- **Callback overhead is the runtime's.** Each callback runs `scr_library_callback_begin`, `scr_library_callback_end` and usually `scr_exc_pending`.
- **Code the calls never run.** Roughly 35–45% of each module's code section is the runtime's memory reclamation: the cycle collector (10.5 KB), release and destroy functions, weak references and dynamic values. A Counter read executes none of the collector. Alkanes discards the instance after every call, so a runtime flavor that never frees would remove this code and the release calls; `ProgramLifetime` is still refused in library builds. Module size matters because the indexer compiles the whole module on every call.

The canonical-indexer reports elsewhere in `bench/` were measured with 0.4.7 and were not rerun for this comparison.

Reproduce: `npm run build` writes the current variant to `dist/`. For the others, build commit `fc186b1` (0.4.7) and the commit "Update scriptc to 0.4.10", which changes only the pins; copy each `dist/`, then run `node bench/measure-wasmi.mjs label=dir ...`.

| contract | scenario | 0.4.7 | 0.4.10 | current | 0.4.10 vs 0.4.7 | current vs 0.4.7 |
|---|---|---:|---:|---:|---:|---:|
| counter | initialize | 4761 | 4769 | 4161 | +0.2% | -12.6% |
| counter | increment | 5749 | 5763 | 4764 | +0.2% | -17.1% |
| counter | get_count | 3890 | 3898 | 3374 | +0.2% | -13.3% |
| counter | revert (write, then throw) | 4721 | 4729 | 3943 | +0.2% | -16.5% |
| counter | height + log | 4205 | 4213 | 3749 | +0.2% | -10.8% |
| counter | sum(n=100) | 4431 | 4445 | 3863 | +0.3% | -12.8% |
| counter | fill(n=10) | 24607 | 24621 | 19965 | +0.1% | -18.9% |
| counter | __meta | 371 | 371 | 369 | 0% | -0.5% |
| token | initialize | 7232 | 7236 | 6014 | +0.1% | -16.8% |
| token | mint (owner) | 7234 | 7238 | 6074 | +0.1% | -16.0% |
| token | name | 3344 | 3348 | 3100 | +0.1% | -7.3% |
| token | total supply | 4208 | 4212 | 3769 | +0.1% | -10.4% |
| token | __meta | 372 | 372 | 370 | 0% | -0.5% |
| capped-token | initialize | 4689 | 4689 | 3625 | 0% | -22.7% |
| capped-token | supply view | 3756 | 3756 | 3025 | 0% | -19.5% |
| capped-token | authority view | 3884 | 3884 | 3085 | 0% | -20.6% |
| capped-token | cap view | 3755 | 3755 | 3024 | 0% | -19.5% |
| capped-token | mint (auth) | 57402 | 57402 | 55580 | 0% | -3.2% |
| capped-token | __meta | 1415 | 1415 | 1413 | 0% | -0.1% |
| amm-pool | initialize | 6272 | 6272 | 4548 | 0% | -27.5% |
| amm-pool | first addLiquidity | 13813 | 13813 | 10716 | 0% | -22.4% |
| amm-pool | addLiquidity with refund | 17332 | 17332 | 13266 | 0% | -23.5% |
| amm-pool | swap 0->1 | 12784 | 12784 | 9610 | 0% | -24.8% |
| amm-pool | swap 1->0 | 12748 | 12748 | 9574 | 0% | -24.9% |
| amm-pool | removeLiquidity | 14267 | 14267 | 10773 | 0% | -24.5% |
| amm-pool | reserve view | 3771 | 3771 | 3040 | 0% | -19.4% |
| amm-pool | quote view | 6089 | 6089 | 4913 | 0% | -19.3% |
| amm-pool | __meta | 1425 | 1425 | 1423 | 0% | -0.1% |
| share-vault | initialize | 6864 | 6864 | 4885 | 0% | -28.8% |
| share-vault | first deposit | 11472 | 11472 | 8286 | 0% | -27.8% |
| share-vault | second deposit | 11461 | 11461 | 8275 | 0% | -27.8% |
| share-vault | redeem | 10758 | 10758 | 7963 | 0% | -26.0% |
| share-vault | harvest (auth + yield) | 60678 | 60678 | 57841 | 0% | -4.7% |
| share-vault | deposit while vesting | 13886 | 13886 | 10021 | 0% | -27.8% |
| share-vault | previewDeposit view | 7508 | 7508 | 5492 | 0% | -26.9% |
| share-vault | lockedProfit view | 6463 | 6463 | 4910 | 0% | -24.0% |
| share-vault | __meta | 1427 | 1427 | 1425 | 0% | -0.1% |
| timelock-treasury | initialize | 57337 | 57337 | 55331 | 0% | -3.5% |
| timelock-treasury | deposit | 6559 | 6559 | 4917 | 0% | -25.0% |
| timelock-treasury | schedule (auth) | 60689 | 60689 | 58332 | 0% | -3.9% |
| timelock-treasury | execute (auth + payout) | 60215 | 60215 | 58190 | 0% | -3.4% |
| timelock-treasury | cancel (auth) | 57650 | 57650 | 56459 | 0% | -2.1% |
| timelock-treasury | pending asset view | 4516 | 4516 | 3545 | 0% | -21.5% |
| timelock-treasury | held view | 4115 | 4115 | 3269 | 0% | -20.6% |
| timelock-treasury | __meta | 1426 | 1426 | 1424 | 0% | -0.1% |
| amm-router | version view | 2560 | 2561 | 2224 | +0.0% | -13.1% |
| amm-router | swap1 (one pool) | 17530 | 17531 | 14947 | +0.0% | -14.7% |
| amm-router | swap2 (two pools) | 30800 | 30801 | 26695 | +0.0% | -13.3% |
| amm-router | swap1 slippage revert | 17523 | 17524 | 14955 | +0.0% | -14.7% |
| amm-router | __meta | 1418 | 1418 | 1416 | 0% | -0.1% |

| contract | variant | bytes | gzip | code section | SHA-256 |
|---|---|---:|---:|---:|---|
| counter | 0.4.7 | 85430 | 41012 | 56059 | `3ecfb0778db50f40437052c4879656cee5e141bbfecb1d70329a0b50f0f53b26` |
| counter | 0.4.10 | 89143 | 42396 | 59756 | `0898b0c37771e223c17dab8ac9e2b84997ea4ff66570cd507bf69dcbd5f5f343` |
| counter | current | 88942 | 42246 | 59539 | `669cb3ecd6d922a2b88eaa479dbfead50125430876768ce2a773d003d45a0bd3` |
| token | 0.4.7 | 93286 | 44144 | 64383 | `531c00bcfb73a3bd2a6a988a328fb927f59416b8b0eb7629a366630d011381f5` |
| token | 0.4.10 | 96991 | 45398 | 68072 | `6a14e2ca68451c17c7869c44edbd7b26b53e7eff67192f8b2966072042b3ad0d` |
| token | current | 96616 | 45357 | 67702 | `584128421d9faded79a96bc750712bd00c07ef38472eaebe9770204522a8a948` |
| capped-token | 0.4.7 | 70455 | 35731 | 44989 | `c97f2497534b5d6c4339535f605a5a68531ad5706b6fdac99ddc4c8ea1284d9e` |
| capped-token | 0.4.10 | 73622 | 36755 | 48146 | `83b0957917d86f4e76296737654e4a22ec6db6d1490db90c09ffc8e7aedd8731` |
| capped-token | current | 73532 | 36760 | 48012 | `d0a20859050ee8f6a73259953b4e46b1e916263b5bad59c22db17160206d7d6e` |
| amm-pool | 0.4.7 | 86094 | 40296 | 58083 | `8df6cccf1c25fce20de0c9b2a7958b91bf96190f0849fc4c132c31bb3601be5a` |
| amm-pool | 0.4.10 | 89259 | 41559 | 61237 | `acc4df268b3e783d18df72f089935e2c0dfa251fdfca7075a9f342f190b85add` |
| amm-pool | current | 88384 | 41294 | 60310 | `624d53f6044d3cfdf8ce8d6de899025d5f52333907559533d2a529cd4710b356` |
| share-vault | 0.4.7 | 90795 | 42008 | 61997 | `7cb762252de12fb33d7d89f805cc4ed7f9dddbb9f93ba29eef3d1b0e486a44ae` |
| share-vault | 0.4.10 | 93938 | 43178 | 65124 | `c241ff892ced5eb96d4374f4b66f2d11a32d53aa8c1d5f051491f60a249d83d3` |
| share-vault | current | 92695 | 42684 | 63852 | `99dc60dc3b92bbf3d053d8639d3537f8b86c838fe3cfa4ceef56531389b0b16d` |
| timelock-treasury | 0.4.7 | 83114 | 38918 | 54503 | `75fec120bd3e381e9826835aaef7875ce16e7262071d97473edc2e4417bae644` |
| timelock-treasury | 0.4.10 | 86271 | 39959 | 57643 | `ca9b3e554c101082044f994c51c47ae05bc58c63a4fab554f466d58e0b776e40` |
| timelock-treasury | current | 85025 | 39594 | 56344 | `6f290801020e26e2dca18f8b36887167dceccd4e7445fe28cea381d63ea6d470` |
| amm-router | 0.4.7 | 71417 | 36378 | 46334 | `0d2ab3730f18550d6fa5bd30dda566cc3cf387fa683c1839df238f1f76b60f20` |
| amm-router | 0.4.10 | 74585 | 37346 | 49493 | `a169c61d25408a291f6ab5be57ca4976123e087b9ae4ad34a4f5195a24ab0227` |
| amm-router | current | 72380 | 36677 | 47306 | `43bdbee3663765300e865036e1d6c3c5457be00da2bb7de34ed0d910eb4cf55d` |
