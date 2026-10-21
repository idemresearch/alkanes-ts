# Production SDK codec optimization

scriptc/runtime 0.4.0; wasmi 0.37.2 with the host's 512-page memory setup. Each contract call sequence is repeated 20 times from a fresh world. All response data, ABI text, expected revert messages and fuel counts are checked. Fuel excludes production host surcharges; no wall-clock claims.

## counter

| call | legacy codecs fuel | production fuel | reduction |
|---|---:|---:|---:|
| __meta | 52869 | 52744 | 0.2% |
| [0] | 182468 | 66493 | 63.6% |
| [1,5] | 162512 | 63893 | 60.7% |
| [2] | 137404 | 60919 | 55.7% |
| [3] | 155769 | 68713 | 55.9% |
| [5,10000] | 7623183 | 7555895 | 0.9% |
| [6,1000] | 58009589 | 9111819 | 84.3% |

legacy: 267804 bytes, SHA-256 `158de3134d0ad8aa7186da1a13ec93af13b39107d55b6f938e6e1477d1469d15`.

production: 269888 bytes, SHA-256 `04690b9455dcc8e2e2194845f9f2945006993aa617bb1befe4495be1830d857d`.

## token

| call | legacy codecs fuel | production fuel | reduction |
|---|---:|---:|---:|
| __meta | 51688 | 51563 | 0.2% |
| [0,1000] | 221749 | 75905 | 65.8% |
| [77,50] | 215523 | 74459 | 65.5% |
| [99] | 110156 | 53957 | 51.0% |
| [100] | 110196 | 53997 | 51.0% |
| [101] | 149041 | 60736 | 59.2% |

legacy: 271139 bytes, SHA-256 `1b6a1c3f6ed9339686e310eb7d8a55ccddea96c21eb8524948af8dad73cf1dc7`.

production: 273559 bytes, SHA-256 `0e21041d05d343bb5ff42e465e1ce489809a103e27e0170918d6f738fec958c6`.

Counter calls: initialize (0), increment by 5 (1,5), read (2), expected write-then-revert (3), sum of squares (5,10000), fill 1,000 storage entries (6,1000). Token calls: initialize supply 1,000 (0,1000), mint 50 (77,50), name (99), symbol (100), supply (101).

Reproduce: `npm run build`, `npm run build:bench:optimize`, then `npm run bench:sdk -- --output bench/SDK_OPTIMIZATION_RESULTS.md`. The legacy fixture preserves the prior algorithms; it is not used by production contracts.
