# Production contract comparison

scriptc/runtime 0.4.0; wasmi 0.37.2 with the host's 512-page memory setup. Each contract call sequence is repeated 20 times from a fresh world. All response data, ABI text, expected revert messages and fuel counts are checked. Fuel excludes production host surcharges; no wall-clock claims.

## counter

| call | previous checkpoint fuel | production fuel | reduction |
|---|---:|---:|---:|
| __meta | 47411 | 12311 | 74.0% |
| [0] | 61495 | 44472 | 27.7% |
| [1,5] | 58794 | 48904 | 16.8% |
| [2] | 55658 | 38721 | 30.4% |
| [3] | 63284 | 48932 | 22.7% |
| [5,10000] | 99134 | 86602 | 12.6% |
| [6,1000] | 9101897 | 9564357 | -5.1% |

reference: 271240 bytes, SHA-256 `6d57597e4bab0410a42751c8dd62a4d43d0abe34020d9504988e16fd35ddbc83`.

production: 224679 bytes, SHA-256 `f70906c4e0702661799e068c4b0dd676332f812c394a9e3ba679b37926c7c0c7`.

## token

| call | previous checkpoint fuel | production fuel | reduction |
|---|---:|---:|---:|
| __meta | 46720 | 46731 | -0.0% |
| [0,1000] | 71276 | 71303 | -0.0% |
| [77,50] | 69709 | 69728 | -0.0% |
| [99] | 49047 | 49058 | -0.0% |
| [100] | 48910 | 48921 | -0.0% |
| [101] | 55479 | 55490 | -0.0% |

reference: 274091 bytes, SHA-256 `9b4c2530b9ed0293060885793408ccaf384241746799bc29f75bfeed2d464a88`.

production: 274249 bytes, SHA-256 `f220ee3e7c175ecb932207810028df81cda42cc64d5d445e7079020595653cd2`.

Counter calls: initialize (0), increment by 5 (1,5), read (2), expected write-then-revert (3), sum of squares (5,10000), fill 1,000 storage entries (6,1000). Token calls: initialize supply 1,000 (0,1000), mint 50 (77,50), name (99), symbol (100), supply (101).

Reference binaries were supplied with `--baseline`; their hashes are recorded above. Use `npm run bench:sdk -- --baseline <directory-with-reference-wasm> --output bench/FRONTEND_FUEL_RESULTS.md`.
