# Stock scriptc 0.4.2 qualification

The default build pins the unmodified scriptc CLI, `@scriptc/runtime-wasm32-wasi`, and `@scriptc/types` to 0.4.2. Counter and Token retain `word-sdk-v1`; CappedToken retains `word-v1`. Contract sources, storage keys, opcodes, generated ABI/state manifests, SDK C sources and Rust comparison fixtures are unchanged by this upgrade. The existing C SDK and Alkanes/WASI adapters remain in the build.

The earlier direct-compiler experiment is historical research. Its compiler patch is not applied or executed for the stock build, tests, or benchmarks. The ordinary regression suite skips the three explicitly opt-in patch tests.

## Verification

- `npm ci` succeeds from the lockfile. The installed compiler executable is byte-identical to the official npm native package payload.
- `npm run typecheck` passes.
- `npm test` passes all 44 ordinary tests; the three experimental compiler-patch tests are skipped.
- The complete canonical integration suite passes all nine tests through the unmodified Alkanes indexer and wasmi 0.37.2. This covers Counter, Token and CappedToken, full-width arithmetic, state defaults, auth-token proof, actual UTXO balances, initialization/auth reentry, failed writes and nested-call rollback.
- A clean rebuild after `npm ci` produces byte-identical Wasm for all three contracts. Their ABI and state manifests match the saved 0.4.0 builds byte-for-byte.

The upstream checkout is `alkanes-rs` revision `f9446fdab77cdc12acbc85f8e9c91c9e5ac2f6cb`, with no tracked changes. Rust comparison contracts are rebuilt with O3, fat LTO, one codegen unit, panic=abort, plus a second variant processed by wasm-opt O3. Counter's Rust implementation uses the same exact-number sum fast path as TypeScript. Build metadata includes the upstream revision, lockfile hashes, Rust/tool versions and artifact hashes.

The generated build and SDK behavior are supported by this test coverage; this qualification does not add a live Bitcoin-node deployment or an independent security audit.

## Benchmarking

The [combined results](../bench/STOCK_0_4_2_RESULTS.md) compare all three contracts with optimized Rust and their saved stock-0.4.0 C-SDK binaries. There are 21 scenarios and four variants, with three warmups and 30 measured repetitions per variant/scenario. Every repetition checks complete responses and resulting state; mint scenarios verify actual UTXO balances. No compiler patches participate in any variant.

Fuel and indexing time are reported separately. Indexing time includes Wasm compilation and instantiation. Deployment rows additionally include fresh-chain bootstrap and standard-contract setup, so they do not measure isolated initializer/deployment latency. Measurements run sequentially with other builds/tests idle.

```sh
npm ci
npm run typecheck
npm test
ALKANES_RS=/path/to/alkanes-rs npm run test:examples
ALKANES_RS=/path/to/alkanes-rs npm run bench:stock -- --iterations 30
```

For a paired version comparison, supply `--baseline /path/to/saved-0.4.0-dist` to `bench:stock`. That directory must contain `counter.wasm`, `token.wasm`, and `capped-token.wasm`. It can be recreated by building revision `aa4baa1d3dcf6c060a5ed7a381c8e9a261572456` in a separate checkout with its stock-0.4.0 lockfile. An optional `BUILD.json` preserves baseline provenance. The reported comparison saved those files directly before upgrading; their hashes are recorded in both detailed reports.

The reports also record package versions, the stock compiler executable hash and official package integrity, source/lock hashes, and every contract/fixture hash. Counter and Token share one benchmark pass; CappedToken follows in a separate pass through the same runtime. Raw logs and metadata are saved under `build/stock-0.4.2/`.
