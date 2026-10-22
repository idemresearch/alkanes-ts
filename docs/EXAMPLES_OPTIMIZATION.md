# Counter and Token fixed-width SDK

Counter and Token retain their existing source, selectors, storage keys and response policy. The compiler selects `word-sdk-v1`, keeping scriptc 0.4.0 as the compiler for dispatch, contract methods, helper functions and loops. [Runtime results](../bench/EXAMPLES_RUNTIME_RESULTS.md) compare both with their previous bigint builds and optimized Rust. [Integration results](../integration/EXAMPLES_RESULTS.md) record canonical execution tests and artifact hashes.

## Measured results

The paired 30-run benchmark beats Rust O3/LTO plus wasm-opt O3 in both fuel and local indexing time on every measured ordinary-call scenario:

| Call | TS fuel | Optimized Rust fuel | TS median | Optimized Rust median |
|---|---:|---:|---:|---:|
| Counter increment | 26,680 | 50,467 | 3.09 ms | 3.47 ms |
| Counter read | 23,640 | 43,351 | 2.70 ms | 3.02 ms |
| Counter sum, n=10,000 | 74,319 | 83,212 | 2.76 ms | 3.05 ms |
| Token mint | 31,277 | 73,784 | 3.08 ms | 3.64 ms |
| Token mint above 2^96 | 31,632 | 76,861 | 2.79 ms | 3.38 ms |
| Token forward call | 49,978 | 71,763 | 5.00 ms | 5.92 ms |

Counter increment consumes 47% less fuel and takes 11% less time than this Rust baseline. Token mint consumes 58% less fuel and takes 15% less time. Counter's module shrinks from 226,144 to 110,779 bytes; Token shrinks from 274,295 to 105,523. The before binaries reproduce byte-for-byte. CappedToken's production binary is unchanged from the preceding optimization. These results describe the measured contracts and lowering subset, rather than a general language speed claim.

## What changed

The first fixed-width path supported CappedToken's narrow class syntax. Counter also uses temporary `StoragePointer` fields, dynamic storage suffixes, numeric and u128 loops, height and logging. Token uses the fluent SDK, module-level helpers, caller IDs, byte/string responses and a nested call. Those capabilities now have a compiler-private word SDK.

`compiler/word-sdk.mjs` type-checks its input against the original SDK before changing representation. It replaces bigint literals/operators with immutable word handles and checked operations, retains ordinary number arithmetic, and emits the methods and loops as TypeScript. String literals become lazy UTF-8 buffers. Public input/output values still use full-width u128 wire values. The native numeric conversion implements IEEE round-to-nearest, ties-to-even, and is differentially checked against bigint-to-number conversion across limb boundaries and deterministic random values.

`sdk/word-runtime.ts` implements the supported TypeScript-facing SDK surface. `shim/word-sdk.c` extends the existing metered Wasm SDK with raw byte/storage operations, checked multiplication, decimal formatting, context IDs, exact parcel forwarding and general call/response serialization. It has no Counter or Token selectors, ownership policy, sum algorithm or storage keys. The build merges these leaves into the same module; canonical host charges and wasmi fuel still apply. Only 29 callbacks are registered, within stock scriptc's 32-slot limit.

The normal class frontend still runs its checked-arithmetic and effect analysis first. Static fluent registrations are normalized into static dispatch before the same word SDK pass. Their metadata is generated from the original registrations. Duplicate/dynamic selectors, fallback handlers and unsupported syntax retain the existing SDK. The emitted manifest identifies the selected lowering; no scriptc or upstream runtime fork is needed.

## Preserved behavior

Counter retains the one-byte `/initialized` marker, typed `/count`, `/slots/` plus little-endian u128 suffixes, checked arithmetic, view guards, intentional rollback and height log. Its existing exact-number sum loop remains unchanged up to n=300,000; larger inputs use checked u128 operations. The Rust comparison has the same numeric fast path, checked fallback multiplication/addition, and incoming-asset rejection.

Token retains `/owner` as a serialized caller ID and `/totalsupply` as a u128. It retains its existing caller-ID ownership model; CappedToken's incoming auth-token policy is a separate API. Legacy responses forward incoming parcels exactly, including duplicate/zero entries, and append self issuance. Metadata and name/symbol bytes are preserved. A successful nested call clears the caller's cached checkpoint before later reads; failed calls roll back both sides through the actual runtime.

The SDK arena follows the canonical fresh-instance-per-invocation model. Native helpers use a separate bounded C stack and share contract memory; static data segments and unresolved imports are rejected by the build. Unsupported source features fall back for the whole contract rather than mixing bigint and word representations in a method.

## Verification and reproduction

```sh
npm run typecheck
npm test
ALKANES_RS=/path/to/alkanes-rs npm run test:examples
npm run build:bench:examples
ALKANES_RS=/path/to/alkanes-rs npm run bench:examples -- \
  --iterations 30 --baseline dist/examples-before
```

Use the toolchain versions and upstream revision recorded in the reports. `build:bench:examples` reproduces the previous bigint binaries without modifying the checkout. All 44 regression tests and nine canonical-runtime tests pass. The canonical suite covers Counter wide increments, rollback, numeric sums, storage fill, height and incoming-asset rejection; Token ownership rejection, wide issuance, real outgoing balances, name/symbol responses and nested-call rollback; and the existing CappedToken/auth and callback-cache tests. Separate Wasm differential tests check wide multiplication, numeric rounding, raw storage and logs; compatibility checks cover wide owner IDs, metadata and duplicate/zero transfers.

The runtime comparison uses three warmups and 30 measured runs per variant/scenario, rotating variant order. Every repetition checks complete responses and resulting storage. Its fuel includes canonical host/storage charges and nested execution. Timings measure local release-built wasm-bindgen/Node block indexing, including compilation and instantiation. Deployment timings include chain bootstrap. Token's forward-call scenario uses the same Counter callee for all variants to isolate caller cost.
