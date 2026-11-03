# scriptc 0.4.7 and the initialization snapshot

Instruction fuel and module size for the production contracts, measured with `node bench/measure-wasmi.mjs` on the in-repo wasmi 0.37.2 host model (`harness/`, Linux x86_64). Fuel excludes canonical host/storage surcharges. The script runs every scenario on each variant and fails unless the observable results (response data, transfers, reverts and logs) are identical, so no fuel difference hides a behavior difference. Each row is the fuel of the scenario's last call.

Variants, all built from the same sources and Zig 0.17.0 / Binaryen 125:

- **0.4.0**: the previous production build (scriptc 0.4.0). The CappedToken SHA-256 matches the committed reports byte for byte.
- **0.4.7**: scriptc, runtime and types 0.4.7 with no other change (`node scripts/build.mjs --no-snapshot`).
- **0.4.0+snapshot** / **0.4.7+snapshot**: the same compilers plus the [build-time initialization snapshot](../docs/SNAPSHOT.md).

On its own, 0.4.7 costs more fuel per call than 0.4.0 (+0.1–14%; CappedToken's word-v1 path regresses most). Its code section is also 7–15% larger, and compilation of the whole module happens on every Alkanes invocation. Function-level profiling attributes CappedToken's per-call regression to heavier array runtime paths (`scr_arr_push_many`, `scr_bytes_from_arr`) that run when generated code builds byte literals. The snapshot removes each module's initialization cost from every call, which outweighs the release regression in every non-`__meta` scenario.

AmmPool (general bigint backend) exists only in the snapshot variants. On that backend 0.4.7 produces a 30% larger module than 0.4.0 (331,759 vs 254,708 bytes).

The canonical-indexer reports elsewhere in `bench/` were not rerun for this comparison.

Reproduce: `node scripts/build.mjs` (0.4.7+snapshot, written to `dist/`), `node scripts/build.mjs --no-snapshot` (0.4.7). The 0.4.0 variants use `buildLibrary({ compiler, runtimePack })` with an isolated install of `scriptc@0.4.0` and `@scriptc/runtime-wasm32-wasi@0.4.0`. Then run `node bench/measure-wasmi.mjs label=dir ...`.

| contract | scenario | 0.4.0 | 0.4.7 | 0.4.0+snapshot | 0.4.7+snapshot | 0.4.7 vs 0.4.0 | 0.4.0+snapshot vs 0.4.0 | 0.4.7+snapshot vs 0.4.0 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| counter | initialize | 20036 | 20060 | 11791 | 11773 | +0.1% | -41.2% | -41.2% |
| counter | increment | 21101 | 21303 | 12856 | 13016 | +1.0% | -39.1% | -38.3% |
| counter | get_count | 19079 | 19215 | 10834 | 10928 | +0.7% | -43.2% | -42.7% |
| counter | revert (write, then throw) | 24705 | 25481 | 16460 | 17194 | +3.1% | -33.4% | -30.4% |
| counter | height + log | 23273 | 24121 | 15028 | 15834 | +3.6% | -35.4% | -32.0% |
| counter | sum(n=100) | 20620 | 20674 | 12375 | 12387 | +0.3% | -40.0% | -39.9% |
| counter | fill(n=10) | 51031 | 51303 | 42786 | 43016 | +0.5% | -16.2% | -15.7% |
| counter | __meta | 62967 | 79101 | 54726 | 70818 | +25.6% | -13.1% | +12.5% |
| token | initialize | 25081 | 25727 | 10894 | 11075 | +2.6% | -56.6% | -55.8% |
| token | mint (owner) | 25420 | 26066 | 11233 | 11414 | +2.5% | -55.8% | -55.1% |
| token | name | 20492 | 20992 | 6305 | 6340 | +2.4% | -69.2% | -69.1% |
| token | total supply | 22551 | 23093 | 8364 | 8441 | +2.4% | -62.9% | -62.6% |
| token | __meta | 70902 | 88456 | 56719 | 73807 | +24.8% | -20.0% | +4.1% |
| capped-token | initialize | 22427 | 24965 | 18653 | 21261 | +11.3% | -16.8% | -5.2% |
| capped-token | supply view | 18693 | 20299 | 14923 | 16577 | +8.6% | -20.2% | -11.3% |
| capped-token | authority view | 19336 | 21089 | 15564 | 17368 | +9.1% | -19.5% | -10.2% |
| capped-token | cap view | 18016 | 20507 | 14242 | 16778 | +13.8% | -20.9% | -6.9% |
| capped-token | __meta | 51894 | 78801 | 48134 | 75557 | +51.8% | -7.2% | +45.6% |
| amm-pool | initialize | — | — | 62878 | 61929 | — | — | — |
| amm-pool | first addLiquidity | — | — | 150651 | 149010 | — | — | — |
| amm-pool | addLiquidity with refund | — | — | 187533 | 184574 | — | — | — |
| amm-pool | swap 0->1 | — | — | 130319 | 128870 | — | — | — |
| amm-pool | swap 1->0 | — | — | 130267 | 128818 | — | — | — |
| amm-pool | removeLiquidity | — | — | 167147 | 165658 | — | — | — |
| amm-pool | reserve view | — | — | 39012 | 38812 | — | — | — |
| amm-pool | quote view | — | — | 47252 | 46871 | — | — | — |
| amm-pool | __meta | — | — | 2706 | 2645 | — | — | — |

| contract | variant | bytes | gzip | code section | SHA-256 |
|---|---|---:|---:|---:|---|
| counter | 0.4.0 | 110779 | 48546 | 95128 | `057c398ae02561c254cedd9fbcf4b2357f5db60099589589efe0d3d082e629ef` |
| counter | 0.4.7 | 118949 | 51671 | 103195 | `173976b5b0d65f16f7571a1c9edd904480c9b10e728b7daaa6dacf36e95a256a` |
| counter | 0.4.0+snapshot | 118627 | 50950 | 93495 | `3d18686f34a9b5eff1f8635b077bff983da9cae7a8f101a735f8bc0580b1d0ab` |
| counter | 0.4.7+snapshot | 126727 | 54115 | 101501 | `872d3998ec5bd6e33c8cc8e19edfefea0c81ec024f503e63e0e68c6031194994` |
| token | 0.4.0 | 105523 | 47744 | 89846 | `11fb9b6a8cdd5cde3d1eb1d86d5698a1e7fcb1316d3c03c6038fd8ea77725cbb` |
| token | 0.4.7 | 119301 | 52741 | 103504 | `2c7b92dea7d9e34cfd40ecb8342977c772f3979259644119625d58e1a5225246` |
| token | 0.4.0+snapshot | 113103 | 49956 | 87101 | `1287f7dfc23f5a04c6e28f0116a3795a454ff05954c191c8ca4d9c42a6ae6a6b` |
| token | 0.4.7+snapshot | 126599 | 55169 | 100504 | `ef86c9c226a569708ad1fdaa885b7a1c983bf5b3235ba8572d21b58ff8fcf546` |
| capped-token | 0.4.0 | 107660 | 46750 | 92774 | `70307bc7a3180e0fa9dea1d2c95096147f5c9e467cca895c01d434cb8c79e936` |
| capped-token | 0.4.7 | 115798 | 49803 | 100883 | `a1f4442a3a6f49125b7fad8ad71c3055e09a3dad81d65eefb625a184a09f8aae` |
| capped-token | 0.4.0+snapshot | 115718 | 49095 | 91717 | `4bcb68473b808a37b45c04e3c73cd25c04a0c3ff59f299df01f16b584dbd40df` |
| capped-token | 0.4.7+snapshot | 123855 | 52339 | 99822 | `ad69bcd925ac2661bda0cc8305fcd84c83c1f241df1e44fa347d28cf9f839c9d` |
| amm-pool | 0.4.0+snapshot | 254708 | 106944 | 216585 | `012b5d993f3ce534445272a9d5f06daa4324682f7ecf6a90839b858f9f32bf38` |
| amm-pool | 0.4.7+snapshot | 331759 | 138098 | 282458 | `98e9ea37fa342b7eb21bc74753edaca78ccd7d54145f21583eefbed6556fcc22` |