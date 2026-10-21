# Fuel isolation results

wasmi 0.37.2; 20 repetitions per row, each on a fresh instance. Memory grow: skipped. Every result and fuel repetition is checked. Initialization and fixture preparation are excluded from warm rows.

```text
scriptc: 0.3.6
native baseline: rustc 1.91.1 (ed61e7d7e 2025-11-07)
Zig: 0.17.0
Binaryen: wasm-opt version 125 (version_125)
minimal.wasm SHA-256: 7c7b461a73889d9c12093ae401c4ed0bf27e96804538e77dfbae2edd56d2eaa7
probes.wasm SHA-256: ae763b9d4a5402a675622e167ebeafd89fb50955d5525ba818e50b97f97877a6
native.wasm SHA-256: d4fd869f95e25562bbbfaed788633c2dcc9ce24a260ee06d6db4860d89b79a75
```

## Startup and empty execution

| fixture | initialization | cold empty execute | initialized empty execute | initialized scalar no-op |
|---|---:|---:|---:|---:|
| native Rust, no SDK | 2 | 2 | 2 | 3 |
| scriptc, no SDK | 3581 | 7675 | 4102 | 171 |
| scriptc + SDK (one method) | 18414 | 101185 | 82784 | 95 |

Same initialized SDK module, prepared context and identical empty response: byte response control **495**, SDK execution pipeline **82374**, added SDK pipeline fuel **+81879**. This excludes host context loading and the WAT entry/return adapter.


## Arithmetic (no storage, encoding or SDK dispatch)

| iterations | native f64 | scriptc number | native u128 | scriptc bigint | native checked u128 | scriptc checkedAdd | SDK check delta in TS |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 19 | 108 | 34 | 395 | 39 | 394 | -1 |
| 1 | 29 | 108 | 81 | 802 | 89 | 900 | +98 |
| 100 | 1019 | 591 | 4734 | 51274 | 5039 | 69972 | +18698 |
| 1000 | 10019 | 4866 | 47034 | 509374 | 50039 | 698172 | +188798 |
| 10000 | 100019 | 47616 | 470034 | 5090374 | 500039 | 7431817 | +2341443 |

## u128 encoding (same bigint accumulation, with/without SDK byte roundtrip)

| values | native control | native roundtrip | native delta | TS control | TS SDK roundtrip | TS delta |
|---:|---:|---:|---:|---:|---:|---:|
| 0 | 23 | 23 | +0 | 230 | 232 | +2 |
| 1 | 36 | 36 | +0 | 2398 | 18916 | +16518 |
| 100 | 1323 | 1323 | +0 | 264334 | 1944257 | +1679923 |
| 1000 | 13023 | 13023 | +0 | 2644834 | 19655519 | +17010685 |

## Host result transport (actual production WAT bridge and SDK)

| payload bytes | request into adapter scratch | SDK copy into Uint8Array | copy delta |
|---:|---:|---:|---:|
| 0 | 1219 | 1503 | +284 |
| 1 | 1219 | 1579 | +360 |
| 3 | 1219 | 1587 | +368 |
| 4 | 1219 | 1591 | +372 |
| 5 | 1219 | 1680 | +461 |
| 16 | 1219 | 1837 | +618 |
| 64 | 1219 | 2881 | +1662 |
| 256 | 1219 | 7057 | +5838 |
| 4096 | 1219 | 91610 | +90391 |

## Storage key conversion and write cache (prepared 16-byte keys/values)

| entries | key length control | toHex + length | hex delta | direct serialization | SDK cache + serialization | cache delta |
|---:|---:|---:|---:|---:|---:|---:|
| 0 | 99 | 104 | +5 | 3068 | 3126 | +58 |
| 1 | 145 | 31142 | +30997 | 10005 | 41403 | +31398 |
| 10 | 559 | 310475 | +309916 | 74583 | 390049 | +315466 |
| 100 | 4699 | 3103805 | +3099106 | 694671 | 3846496 | +3151825 |
| 1000 | 46099 | 31037105 | +30991006 | 6822398 | 38290653 | +31468255 |

Deltas are paired differences, not additive percentages of existing counter/token calls. `toHex` is part of the cache delta; do not add it again. SDK deltas include the cost of executing that SDK code through scriptc. The native fixture is a standalone lower bound, not alkanes-runtime. Native arithmetic/encoding uses black_box to retain the work. No production host surcharges or wall-clock claims. See bench/ISOLATION.md for methodology and limits.
