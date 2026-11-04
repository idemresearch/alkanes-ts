# Build-time initialization snapshot

Alkanes executes every call in a fresh Wasm instance: the indexer compiles the module, instantiates it, grows memory to 512 pages and calls `__execute` (`crates/alkanes/src/vm/instance.rs` in the recorded alkanes-rs revision). A scriptc library module therefore ran its whole initialization on every call: the WASI reactor's `_initialize`, the scriptc runtime's setup, and the contract module's top-level code. None of that work depends on the call.

`scripts/snapshot.mjs` performs it once, at build time, and ships the result.

## How it works

1. The production pipeline keeps the adapter's run-once initialization export (`__bench_init`) alive through a first `wasm-metadce` pass.
2. Every defined global gets a temporary export. The instrumented copy is instantiated in Node with an `env` import object whose functions all throw, and initialization is called once.
3. The original module is rewritten: each global's initializer becomes its captured value, memory's initial size becomes the captured page count (the original has no maximum and still has none), and the captured image replaces the data segments. Only nonzero runs are stored; zero gaps shorter than 16 bytes stay inside a segment.
4. The adapter's run-once guard becomes a no-op and the export is removed. The second `wasm-metadce` pass and `wasm-opt -Oz` then delete the initialization code.

`__execute` and `__meta` still call the guard, which is now empty. Everything else in the module is unchanged.

## Why it preserves behavior

- **Deterministic and host-independent.** The deterministic WASI stand-ins (`shim/wasi.wat`) are merged into the module before the snapshot, so the only imports left are the canonical `env.*` host functions. The snapshot instance gives each of them a function that throws. If initialization reaches any host function, the snapshot is refused and the build keeps the unsnapshotted module. It prints a note when that happens.
- **Same starting state.** A fresh instance of the snapshotted module starts with exactly the memory bytes and global values the original module had after initialization, including allocator state and memory size. Later `memory.grow` calls return the same page indexes as before.
- **Fresh-instance model.** Alkanes never reuses an instance, so no call can observe a difference between "initialized at instantiation" and "initialized at the start of the call".
- **Consensus.** Every indexer loads the same bytes. The snapshot is computed once, when the contract is built, so engine floating-point details at build time cannot cause divergence between indexers.

The build refuses the snapshot, rather than producing a wrong one, if any of these hold: initialization traps, a global has a non-numeric type, memory is imported, shared or 64-bit, or the module has passive data segments.

## Results

Instruction fuel under the in-repo wasmi 0.37.2 host model (`node bench/measure-wasmi.mjs`). Responses are identical across all variants; the script fails otherwise.

| Call | 0.4.0 | 0.4.7 | 0.4.7 + snapshot |
|---|---:|---:|---:|
| Counter increment | 21,101 | 21,303 | 13,016 (−38%) |
| Counter get_count | 19,079 | 19,215 | 10,928 (−43%) |
| Token mint | 25,420 | 26,066 | 11,414 (−55%) |
| Token name | 20,492 | 20,992 | 6,340 (−69%) |
| CappedToken supply view | 18,693 | 20,299 | 16,577 (−11%) |

The savings equal each module's initialization cost. Token's module-level code and string constants made its initialization the most expensive of the three. See [the full comparison](../bench/SCRIPTC_047_RESULTS.md) for every scenario, sizes and artifact hashes.

Paired local timings (`harness/target/release/bench`) put export execution at about half its previous time: for example, Counter get_count went from 224 µs to 120 µs and Token mint from 244 µs to 107 µs. Per-call wall time in the indexer is still dominated by module compilation and the 512-page memory grow, so code size matters more for latency than execution does.

## Disabling it

`node scripts/build.mjs --no-snapshot [contract]` builds without the snapshot, for A/B comparison. `buildLibrary({ snapshot: false })` does the same programmatically. Benchmark builds (`benchmark: true`) never snapshot, because the isolation harness measures initialization explicitly.
