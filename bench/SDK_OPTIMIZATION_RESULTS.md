# Production SDK optimization

scriptc/runtime 0.4.0; wasmi 0.37.2 with the host's 512-page memory setup. Each contract call sequence is repeated 20 times from a fresh world. All response data, ABI text, expected revert messages and fuel counts are checked. Fuel excludes production host surcharges; no wall-clock claims.

## counter

| call | legacy codecs fuel | production fuel | reduction |
|---|---:|---:|---:|
| __meta | 47536 | 47411 | 0.3% |
| [0] | 177467 | 61495 | 65.3% |
| [1,5] | 157410 | 58794 | 62.6% |
| [2] | 132140 | 55658 | 57.9% |
| [3] | 150337 | 63284 | 57.9% |
| [5,10000] | 166419 | 99134 | 40.4% |
| [6,1000] | 57999664 | 9101897 | 84.3% |

legacy: 269128 bytes, SHA-256 `fd632fff9476b08cac11b801d97a98d3747dcc3a232f4c268cef317515a79fdc`.

production: 271240 bytes, SHA-256 `6d57597e4bab0410a42751c8dd62a4d43d0abe34020d9504988e16fd35ddbc83`.

## token

| call | legacy codecs fuel | production fuel | reduction |
|---|---:|---:|---:|
| __meta | 46845 | 46720 | 0.3% |
| [0,1000] | 217120 | 71276 | 67.2% |
| [77,50] | 210773 | 69709 | 66.9% |
| [99] | 105246 | 49047 | 53.4% |
| [100] | 105109 | 48910 | 53.5% |
| [101] | 143784 | 55479 | 61.4% |

legacy: 271666 bytes, SHA-256 `00d1769f20d9f91c8d2fbecc8259fe3898d13d5f843674acf6a188e66a5f55c4`.

production: 274091 bytes, SHA-256 `9b4c2530b9ed0293060885793408ccaf384241746799bc29f75bfeed2d464a88`.

Counter calls: initialize (0), increment by 5 (1,5), read (2), expected write-then-revert (3), sum of squares (5,10000), fill 1,000 storage entries (6,1000). Token calls: initialize supply 1,000 (0,1000), mint 50 (77,50), name (99), symbol (100), supply (101).

Reproduce: `npm run build`, `npm run build:bench:optimize`, then `npm run bench:sdk -- --output bench/SDK_OPTIMIZATION_RESULTS.md`. The legacy fixture preserves the prior algorithms; it is not used by production contracts.
