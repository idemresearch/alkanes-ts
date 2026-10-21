# scriptc optimization experiments

wasmi 0.37.2; 20 fresh-instance repetitions per row; memory growth: skipped. Every scalar result and fuel repetition is checked. Prepared inputs and explicit initialization are excluded from warm measurements. Production SDK sources are unchanged.

## scriptc 0.3.6

```text
scriptc and runtime pack: 0.3.6
@scriptc/types: 0.3.6
contracts.wasm SHA-256: 66eee60c49f48308101f86804a8d166fc2b8882e43e3e503266eef139b7f3f7f
baseline.wasm SHA-256: ae763b9d4a5402a675622e167ebeafd89fb50955d5525ba818e50b97f97877a6
annotations.wasm SHA-256: ae763b9d4a5402a675622e167ebeafd89fb50955d5525ba818e50b97f97877a6
codecs.wasm SHA-256: d774ba4b71cf43c097ac8caa05c8224dabac88142ac73bef302d2ee672595933
counter.wasm SHA-256: 4e44bad6c0389ca5c632ff8508364515020f877aca2d0b265c31a89c4662fc79
token.wasm SHA-256: eca29a3bf039790e9578f5f934609e309d35ae34f25b2ea740173f73eef7a3f2
```

### Compatibility checks

| probe | result |
|---|---|
| Int32 array | rejected: SC7006 |
| invalid Int32 | rejected: SC7002 |
| invalid NoThrow | rejected: SC7001 |
| ProgramLifetime in library | rejected: SC7008 |
| readonly linked Acyclic | rejected: SC7007 |
| native FFI in library | rejected: CLI library restriction |

### Annotation-only pairs in the same module

| contract | workload size | plain | annotated | change |
|---|---:|---:|---:|---:|
| Int32 scalar slots | 0 | 175 | 175 | +0 (+0.0%) |
| NoThrow | 0 | 175 | 175 | +0 (+0.0%) |
| Acyclic | 0 | 380 | 380 | +0 (+0.0%) |
| Immutable table | 0 | 178 | 178 | +0 (+0.0%) |
| Int32 scalar slots | 1 | 203 | 203 | +0 (+0.0%) |
| NoThrow | 1 | 185 | 185 | +0 (+0.0%) |
| Acyclic | 1 | 582 | 582 | +0 (+0.0%) |
| Immutable table | 1 | 199 | 199 | +0 (+0.0%) |
| Int32 scalar slots | 100 | 3272 | 3272 | +0 (+0.0%) |
| NoThrow | 100 | 1373 | 1373 | +0 (+0.0%) |
| Acyclic | 100 | 30123 | 30123 | +0 (+0.0%) |
| Immutable table | 100 | 2080 | 2080 | +0 (+0.0%) |
| Int32 scalar slots | 1000 | 31172 | 31172 | +0 (+0.0%) |
| NoThrow | 1000 | 12173 | 12173 | +0 (+0.0%) |
| Acyclic | 1000 | 272089 | 272089 | +0 (+0.0%) |
| Immutable table | 1000 | 19180 | 19180 | +0 (+0.0%) |
| Int32 scalar slots | 10000 | 310172 | 310172 | +0 (+0.0%) |
| NoThrow | 10000 | 120173 | 120173 | +0 (+0.0%) |
| Acyclic | 10000 | 3097915 | 3097915 | +0 (+0.0%) |
| Immutable table | 10000 | 190180 | 190180 | +0 (+0.0%) |

### SDK copies: baseline, annotations only, annotations + codec algorithms

| workload | baseline | annotations | annotation change | codecs | codec change vs baseline |
|---|---:|---:|---:|---:|---:|
| cold empty execute | 101185 | 101185 | +0 (+0.0%) | 49275 | -51910 (-51.3%) |
| initialized empty execute | 82784 | 82784 | +0 (+0.0%) | 28849 | -53935 (-65.2%) |
| SDK pipeline (prepared context) | 82374 | 82374 | +0 (+0.0%) | 28439 | -53935 (-65.5%) |
| hex keys, n=1,000 | 31037105 | 31037105 | +0 (+0.0%) | 1658095 | -29379010 (-94.7%) |
| write cache + serialization, n=1,000 | 38290653 | 38290653 | +0 (+0.0%) | 8899650 | -29391003 (-76.8%) |
| u128 roundtrip, n=1,000 | 19655519 | 19655519 | +0 (+0.0%) | 5546502 | -14109017 (-71.8%) |
| checked bigint sum, n=10,000 | 7431817 | 7431817 | +0 (+0.0%) | 7431817 | +0 (+0.0%) |
| host copy, 16 bytes | 1837 | 1837 | +0 (+0.0%) | 1837 | +0 (+0.0%) |
## scriptc 0.4.0

```text
scriptc and runtime pack: 0.4.0
@scriptc/types: 0.4.0
contracts.wasm SHA-256: bd1e3a5098caa07206bf3ef2c31e90c17a208a163947adcca5b2cf2cf492bd81
baseline.wasm SHA-256: 391413e68bed6b614b0877ed7febaf7cac4a15e306e77cc800d3edab74b0d9dc
annotations.wasm SHA-256: 391413e68bed6b614b0877ed7febaf7cac4a15e306e77cc800d3edab74b0d9dc
codecs.wasm SHA-256: 7370fc708ac67ddcd6a21c28b2025e125e6ddb87b1772d59eb57ceb71b8910cf
counter.wasm SHA-256: 91e44c966e5b707b92c0bf3486c3b8d04eb8f49883f53a066752702dfba55985
token.wasm SHA-256: 1ffe7762ab039baffb90c60f0c1bd4beebd0d3cb847432e9deb326793996300f
arrays.wasm SHA-256: bd1e3a5098caa07206bf3ef2c31e90c17a208a163947adcca5b2cf2cf492bd81
```

### Compatibility checks

| probe | result |
|---|---|
| Int32 array | accepted |
| invalid Int32 | rejected: SC7002 |
| invalid NoThrow | rejected: SC7001 |
| ProgramLifetime in library | rejected: SC7008 |
| readonly linked Acyclic | rejected: SC7007 |
| native FFI in library | rejected: CLI library restriction |

### Annotation-only pairs in the same module

| contract | workload size | plain | annotated | change |
|---|---:|---:|---:|---:|
| Int32 scalar slots | 0 | 175 | 175 | +0 (+0.0%) |
| NoThrow | 0 | 175 | 175 | +0 (+0.0%) |
| Acyclic | 0 | 396 | 396 | +0 (+0.0%) |
| Immutable table | 0 | 178 | 178 | +0 (+0.0%) |
| Int32[] + scalar slots | 0 | 175 | 175 | +0 (+0.0%) |
| Int32 scalar slots | 1 | 203 | 203 | +0 (+0.0%) |
| NoThrow | 1 | 185 | 185 | +0 (+0.0%) |
| Acyclic | 1 | 585 | 585 | +0 (+0.0%) |
| Immutable table | 1 | 199 | 199 | +0 (+0.0%) |
| Int32[] + scalar slots | 1 | 203 | 203 | +0 (+0.0%) |
| Int32 scalar slots | 100 | 3272 | 3272 | +0 (+0.0%) |
| NoThrow | 100 | 1373 | 1373 | +0 (+0.0%) |
| Acyclic | 100 | 28340 | 28340 | +0 (+0.0%) |
| Immutable table | 100 | 2080 | 2080 | +0 (+0.0%) |
| Int32[] + scalar slots | 100 | 3272 | 3272 | +0 (+0.0%) |
| Int32 scalar slots | 1000 | 31172 | 31172 | +0 (+0.0%) |
| NoThrow | 1000 | 12173 | 12173 | +0 (+0.0%) |
| Acyclic | 1000 | 254097 | 254097 | +0 (+0.0%) |
| Immutable table | 1000 | 19180 | 19180 | +0 (+0.0%) |
| Int32[] + scalar slots | 1000 | 31172 | 31172 | +0 (+0.0%) |
| Int32 scalar slots | 10000 | 310172 | 310172 | +0 (+0.0%) |
| NoThrow | 10000 | 120173 | 120173 | +0 (+0.0%) |
| Acyclic | 10000 | 2917911 | 2917911 | +0 (+0.0%) |
| Immutable table | 10000 | 190180 | 190180 | +0 (+0.0%) |
| Int32[] + scalar slots | 10000 | 310172 | 310172 | +0 (+0.0%) |

### SDK copies: baseline, annotations only, annotations + codec algorithms

| workload | baseline | annotations | annotation change | codecs | codec change vs baseline |
|---|---:|---:|---:|---:|---:|
| cold empty execute | 104127 | 104127 | +0 (+0.0%) | 50955 | -53172 (-51.1%) |
| initialized empty execute | 85098 | 85098 | +0 (+0.0%) | 29894 | -55204 (-64.9%) |
| SDK pipeline (prepared context) | 84688 | 84688 | +0 (+0.0%) | 29484 | -55204 (-65.2%) |
| hex keys, n=1,000 | 30760105 | 30760105 | +0 (+0.0%) | 1673095 | -29087010 (-94.6%) |
| write cache + serialization, n=1,000 | 38403799 | 38403799 | +0 (+0.0%) | 9304796 | -29099003 (-75.8%) |
| u128 roundtrip, n=1,000 | 19820512 | 19820512 | +0 (+0.0%) | 5655495 | -14165017 (-71.5%) |
| checked bigint sum, n=10,000 | 7431809 | 7431809 | +0 (+0.0%) | 7431809 | +0 (+0.0%) |
| host copy, 16 bytes | 1786 | 1786 | +0 (+0.0%) | 1786 | +0 (+0.0%) |

Contract annotations may enforce proofs the compiler already infers. The scalar Int32 pair uses the same explicit wrapping operations on both paths; it does not test Int32[] storage. SDK annotations mark AlkaneId as Acyclic and bytesEqual as NoThrow. The codec variant additionally replaces per-nibble string construction with ASCII-byte encoding, and per-byte bigint u128 encoding/decoding with two DataView u64 limbs (retaining the short-input fallback). These are SDK algorithms, not compiler patches. The readonly linked-node probe tests a separate Acyclic inference limitation. No production host surcharges are modeled. See bench/OPTIMIZATION.md.
