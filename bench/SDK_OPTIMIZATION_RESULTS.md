# Production SDK codec optimization

scriptc/runtime 0.4.0; wasmi 0.37.2 with the host's 512-page memory setup. Each contract call sequence is repeated 20 times from a fresh world. All response data, ABI text, expected revert messages and fuel counts are checked. Fuel excludes production host surcharges; no wall-clock claims.

## counter

| call | legacy codecs fuel | production fuel | reduction |
|---|---:|---:|---:|
| __meta | 52869 | 54846 | -3.7% |
| [0] | 182468 | 73143 | 59.9% |
| [1,5] | 162512 | 68684 | 57.7% |
| [2] | 137404 | 63935 | 53.5% |
| [3] | 155769 | 71782 | 53.9% |
| [5,10000] | 7623183 | 7558858 | 0.8% |
| [6,1000] | 58009589 | 11008782 | 81.0% |

legacy: 267804 bytes, SHA-256 `158de3134d0ad8aa7186da1a13ec93af13b39107d55b6f938e6e1477d1469d15`.

production: 271766 bytes, SHA-256 `6f29c4dd1f576e238b03dffb7bf43c8812236acf68bc23fc2ce5523df75b7b9a`.

## token

| call | legacy codecs fuel | production fuel | reduction |
|---|---:|---:|---:|
| __meta | 51688 | 53647 | -3.8% |
| [0,1000] | 221749 | 82590 | 62.8% |
| [77,50] | 215523 | 79369 | 63.2% |
| [99] | 110156 | 56902 | 48.3% |
| [100] | 110196 | 56942 | 48.3% |
| [101] | 149041 | 63776 | 57.2% |

legacy: 271139 bytes, SHA-256 `1b6a1c3f6ed9339686e310eb7d8a55ccddea96c21eb8524948af8dad73cf1dc7`.

production: 275456 bytes, SHA-256 `c39e5b79b4a6f6237546c41b7c8bb01654513aaf581b338f88ad882508ac7dbd`.

Counter calls: initialize (0), increment by 5 (1,5), read (2), expected write-then-revert (3), sum of squares (5,10000), fill 1,000 storage entries (6,1000). Token calls: initialize supply 1,000 (0,1000), mint 50 (77,50), name (99), symbol (100), supply (101).

Reproduce: `npm run build`, `npm run build:bench:optimize`, then `npm run bench:sdk -- --output bench/SDK_OPTIMIZATION_RESULTS.md`. The legacy fixture preserves the prior algorithms; it is not used by production contracts.
