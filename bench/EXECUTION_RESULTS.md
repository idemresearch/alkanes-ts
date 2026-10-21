# Production SDK optimization

scriptc/runtime 0.4.0; wasmi 0.37.2 with the host's 512-page memory setup. Each contract call sequence is repeated 20 times from a fresh world. All response data, ABI text, expected revert messages and fuel counts are checked. Fuel excludes production host surcharges; no wall-clock claims.

## counter

| call | previous checkpoint fuel | production fuel | reduction |
|---|---:|---:|---:|
| __meta | 52744 | 47411 | 10.1% |
| [0] | 66493 | 61495 | 7.5% |
| [1,5] | 63893 | 58794 | 8.0% |
| [2] | 60919 | 55658 | 8.6% |
| [3] | 68713 | 63284 | 7.9% |
| [5,10000] | 7555895 | 99134 | 98.7% |
| [6,1000] | 9111819 | 9101897 | 0.1% |

reference: 269888 bytes, SHA-256 `04690b9455dcc8e2e2194845f9f2945006993aa617bb1befe4495be1830d857d`.

production: 271240 bytes, SHA-256 `6d57597e4bab0410a42751c8dd62a4d43d0abe34020d9504988e16fd35ddbc83`.

## token

| call | previous checkpoint fuel | production fuel | reduction |
|---|---:|---:|---:|
| __meta | 51563 | 46720 | 9.4% |
| [0,1000] | 75905 | 71276 | 6.1% |
| [77,50] | 74459 | 69709 | 6.4% |
| [99] | 53957 | 49047 | 9.1% |
| [100] | 53997 | 48910 | 9.4% |
| [101] | 60736 | 55479 | 8.7% |

reference: 273559 bytes, SHA-256 `0e21041d05d343bb5ff42e465e1ce489809a103e27e0170918d6f738fec958c6`.

production: 274091 bytes, SHA-256 `9b4c2530b9ed0293060885793408ccaf384241746799bc29f75bfeed2d464a88`.

Counter calls: initialize (0), increment by 5 (1,5), read (2), expected write-then-revert (3), sum of squares (5,10000), fill 1,000 storage entries (6,1000). Token calls: initialize supply 1,000 (0,1000), mint 50 (77,50), name (99), symbol (100), supply (101).

Reference binaries were supplied with `--baseline`; their hashes are recorded above. Use `npm run bench:sdk -- --baseline <directory-with-reference-wasm> --output bench/EXECUTION_RESULTS.md`.
