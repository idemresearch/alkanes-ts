# scriptc optimization experiments

wasmi 0.37.2; 20 fresh-instance repetitions per row; memory growth: skipped. Every scalar result and fuel repetition is checked. Prepared inputs and explicit initialization are excluded from warm measurements. The baseline restores the legacy codecs; the codec variant uses the current production algorithms.

## scriptc 0.4.0

```text
scriptc and runtime pack: 0.4.0
@scriptc/types: 0.4.0
contracts.wasm SHA-256: bd1e3a5098caa07206bf3ef2c31e90c17a208a163947adcca5b2cf2cf492bd81
baseline.wasm SHA-256: c8a9a53fb298283969c5a64375242346184d3e48d1d754588ef190190ff4b48c
annotations.wasm SHA-256: c8a9a53fb298283969c5a64375242346184d3e48d1d754588ef190190ff4b48c
codecs.wasm SHA-256: 179e6df495f6cf9c227948a18e72efa66b01e5f2045a1dfa3de9438369fa5099
counter.wasm SHA-256: 6d57597e4bab0410a42751c8dd62a4d43d0abe34020d9504988e16fd35ddbc83
token.wasm SHA-256: 9b4c2530b9ed0293060885793408ccaf384241746799bc29f75bfeed2d464a88
legacy/counter.wasm SHA-256: fd632fff9476b08cac11b801d97a98d3747dcc3a232f4c268cef317515a79fdc
legacy/token.wasm SHA-256: 00d1769f20d9f91c8d2fbecc8259fe3898d13d5f843674acf6a188e66a5f55c4
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
| cold empty execute | 102852 | 102852 | +0 (+0.0%) | 46704 | -56148 (-54.6%) |
| initialized empty execute | 84666 | 84666 | +0 (+0.0%) | 28633 | -56033 (-66.2%) |
| SDK pipeline (prepared context) | 84257 | 84257 | +0 (+0.0%) | 28223 | -56034 (-66.5%) |
| hex keys, n=1,000 | 30760105 | 30760105 | +0 (+0.0%) | 1401095 | -29359010 (-95.4%) |
| write cache + serialization, n=1,000 | 38394801 | 38394801 | +0 (+0.0%) | 7362968 | -31031833 (-80.8%) |
| u128 roundtrip, n=1,000 | 19820512 | 19820512 | +0 (+0.0%) | 5655495 | -14165017 (-71.5%) |
| checked bigint sum, n=10,000 | 7431809 | 7431809 | +0 (+0.0%) | 7431809 | +0 (+0.0%) |
| host copy, 16 bytes | 1786 | 1786 | +0 (+0.0%) | 1786 | +0 (+0.0%) |

Contract annotations may enforce proofs the compiler already infers. The scalar Int32 pair uses the same explicit wrapping operations on both paths; it does not test Int32[] storage. SDK annotations mark AlkaneId as Acyclic and bytesEqual as NoThrow. The codec variant additionally replaces per-nibble string construction with arithmetic ASCII-byte encoding, per-byte bigint u128 encoding/decoding with two DataView u64 limbs (retaining the short-input fallback), and temporary DataView u32 writes with direct byte writes. These are SDK algorithms, not compiler patches. The readonly linked-node probe tests a separate Acyclic inference limitation. No production host surcharges are modeled. See bench/OPTIMIZATION.md.
