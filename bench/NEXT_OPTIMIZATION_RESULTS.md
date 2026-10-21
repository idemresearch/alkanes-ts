# Production SDK codec optimization

scriptc/runtime 0.4.0; wasmi 0.37.2 with the host's 512-page memory setup. Each contract call sequence is repeated 20 times from a fresh world. All response data, ABI text, expected revert messages and fuel counts are checked. Fuel excludes production host surcharges; no wall-clock claims.

## counter

| call | previous checkpoint fuel | production fuel | reduction |
|---|---:|---:|---:|
| __meta | 54846 | 52744 | 3.8% |
| [0] | 73143 | 66493 | 9.1% |
| [1,5] | 68684 | 63893 | 7.0% |
| [2] | 63935 | 60919 | 4.7% |
| [3] | 71782 | 68713 | 4.3% |
| [5,10000] | 7558858 | 7555895 | 0.0% |
| [6,1000] | 11008782 | 9111819 | 17.2% |

reference: 271766 bytes, SHA-256 `6f29c4dd1f576e238b03dffb7bf43c8812236acf68bc23fc2ce5523df75b7b9a`.

production: 269888 bytes, SHA-256 `04690b9455dcc8e2e2194845f9f2945006993aa617bb1befe4495be1830d857d`.

## token

| call | previous checkpoint fuel | production fuel | reduction |
|---|---:|---:|---:|
| __meta | 53647 | 51563 | 3.9% |
| [0,1000] | 82590 | 75905 | 8.1% |
| [77,50] | 79369 | 74459 | 6.2% |
| [99] | 56902 | 53957 | 5.2% |
| [100] | 56942 | 53997 | 5.2% |
| [101] | 63776 | 60736 | 4.8% |

reference: 275456 bytes, SHA-256 `c39e5b79b4a6f6237546c41b7c8bb01654513aaf581b338f88ad882508ac7dbd`.

production: 273559 bytes, SHA-256 `0e21041d05d343bb5ff42e465e1ce489809a103e27e0170918d6f738fec958c6`.

Counter calls: initialize (0), increment by 5 (1,5), read (2), expected write-then-revert (3), sum of squares (5,10000), fill 1,000 storage entries (6,1000). Token calls: initialize supply 1,000 (0,1000), mint 50 (77,50), name (99), symbol (100), supply (101).

Reference binaries were supplied with `--baseline`; their hashes are recorded above. Use `npm run bench:sdk -- --baseline <directory-with-reference-wasm> --output bench/NEXT_OPTIMIZATION_RESULTS.md`.
