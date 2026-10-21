# Can scriptc fuel improve without a fork?

Yes. The strongest improvements in the original experiment came from changing SDK algorithms with scriptc 0.3.6. The project now uses **0.4.0**, and the codec improvements are applied in `sdk/bytes.ts`. See the [production before/after report](SDK_OPTIMIZATION_RESULTS.md) for current counter/token measurements. The builder preserves the previous codec algorithms in baseline copies under `build/optimization/<version>/`; other SDK and contract code is current on both sides. Contracts use the optimized production codecs.

Subsequent work removes string-keyed opcode dispatch and adds a bounded exact numeric loop to the counter's sum method. The [execution report](EXECUTION_RESULTS.md) measures these changes against `588dda7`. The [speed comparison](SPEED.md) also checks wall time against Rust given the same numeric path; the remaining bigint arithmetic probe remains unchanged.

See [the historical experiment report](OPTIMIZATION_RESULTS.md). Its descriptions of codec candidates and unchanged production sources describe the state at the time of that experiment.

## Results

| Original scriptc 0.3.6 workload | Baseline fuel | Codec variant fuel | Reduction |
|---|---:|---:|---:|
| Cold empty execution, SDK probe contract | 101,185 | 49,275 | 51.3% |
| SDK execution pipeline, prepared context | 82,374 | 28,439 | 65.5% |
| Hex conversion, 1,000 prepared 16-byte keys | 31,037,105 | 1,658,095 | 94.7% |
| Write cache and serialization, 1,000 entries | 38,290,653 | 8,899,650 | 76.8% |
| u128 encoding/decoding, 1,000 values | 19,655,519 | 5,546,502 | 71.8% |
| Checked bigint arithmetic, 10,000 iterations | 7,431,817 | 7,431,817 | 0% |

These are whole measured workload costs, not the control-subtracted deltas in the earlier isolation report. Deltas overlap: hex conversion is included in the write-cache workload, and decoding is included in the SDK execution pipeline. Every row was repeated 20 times on fresh instances with result and fuel checks. Running with and without the host's 512-page memory growth produced identical fuel.

The same codec ideas also improve actual counter calls under wasmi 0.37.2. These are separate smoke-call measurements using both contracts built with scriptc 0.3.6, the same caller and the same call sequence:

| Counter call | Production SDK baseline | Codec SDK copy |
|---|---:|---:|
| initialize | 180,428 | 71,254 |
| increment by 5 | 160,142 | 66,654 |
| get_count | 134,861 | 62,066 |
| sum(10,000) | 7,620,441 | 7,556,871 |
| fill(1,000) | 59,317,432 | 11,099,838 |

Unlike the repeated microbenchmarks, the smoke figures above were collected in one pass before the compiler upgrade. The current `npm run bench:sdk` measures production contracts against `dist/optimization/0.4.0/legacy` using the same compiler, checks identical results and repeats each sequence 20 times. The historical numbers above used 0.3.6. The intentional revert at opcode 3 is expected.

## What changed in the experimental SDK copy

The **annotations** variant marks `AlkaneId` as `Acyclic` and `bytesEqual` as `NoThrow`. It produces byte-for-byte identical optimized Wasm to the baseline on both tested compilers. `AlkaneId` is live in the context parser; `bytesEqual` is not reached by these SDK probes, so its marker cannot affect their runtime. Separate paired kernels test active `NoThrow`, `Int32`, `Acyclic` and `Immutable` functions. Those kernels also produce no fuel improvement. This is evidence about these workloads, not a claim that annotations never help; some contracts formalize optimizations the compiler can already infer.

The **codecs** variant retains those annotations and now uses the production algorithms. The **baseline** and **annotations** variants restore the three codec functions, hex table and `ByteWriter` class from `bench/optimization/legacy-codecs.ts`, so promotion into production does not erase the comparison. The optimizations are:

- `toHex` builds an ASCII `Uint8Array`, then decodes it once. Nibble values are converted to ASCII arithmetically, avoiding both per-nibble string construction and a global lookup table's initialization. The cache still uses the same exact lowercase hex keys; no storage schema or cache semantics change.
- `u128ToBytes` writes two little-endian `DataView.setBigUint64` limbs instead of performing sixteen bigint masking/shifting steps. `bytesToU128` similarly reads two limbs when sixteen bytes are available, while retaining the original short-input and unusual-offset fallback. Range checks remain in place.
- `ByteWriter.u32` writes four bytes with numeric shifts instead of allocating a temporary `DataView`. Its modulo conversion and the writer's deferred byte references and repeated `finish()` behavior are preserved.

The codec changes do not alter `checkedAdd`, bigint multiplication, the host callback ABI or the four-byte scratch loop. Consequently the arithmetic and host-copy controls retain exactly their baseline fuel. The large improvement in empty SDK execution comes primarily from more efficient parsing of the u128 fields in the context and response encoding.

In the original 0.3.6 experiment, the ASCII lookup table added initialization work: counter `__meta` rose from 50,222 to 52,247 fuel and its raw binary grew from 261,223 to 265,245 bytes. The follow-up in `588dda7` removes that table and the u32 DataView allocations. Against checkpoint `0a1dd35`, counter metadata falls from 54,846 to 52,744 fuel, initialization from 73,143 to 66,493, and fill(1,000) from 11,008,782 to 9,111,819 (17.2% less). Both contracts shrink by about 1.9 KB. See that pass's [incremental report](NEXT_OPTIMIZATION_RESULTS.md) for 20 checked repetitions and artifact hashes. The preserved reference hashes match the production artifacts recorded at `0a1dd35` in `bench/SDK_OPTIMIZATION_RESULTS.md`.

The [current warm probes](SDK_PROBE_RESULTS.md) separate these SDK effects from checked arithmetic and host-copy controls, which retain identical fuel. The current [cumulative production report](SDK_OPTIMIZATION_RESULTS.md) shows metadata slightly below the legacy baseline. The codec still allocates buffers and uses bigint conversions at limb boundaries. These savings do not imply Rust parity or a completed runtime determinism audit.

## Upstream features versus a compiler fork

The original 0.3.6 package's declarations, compiler diagnostics and generated Wasm were the reference for support. The public documentation also described newer features, so we tested an isolated 0.4.0 toolchain with its matching runtime pack and type package before upgrading the project's pins.

| Feature | 0.3.6 Wasm library | 0.4.0 Wasm library | Consequence |
|---|---|---|---|
| Scalar `Int32`, `NoThrow`, simple `Acyclic`, `Immutable` | Accepted | Accepted | No extra savings in the paired kernels tested here. |
| `Int32[]` | Rejected, SC7006 | Accepted | An ordinary upstream upgrade enables it. The test kernel is still identical to its unannotated counterpart. |
| Invalid scalar `Int32` assignment | Rejected, SC7002 | Rejected, SC7002 | The compiler checks the contract rather than silently erasing it. |
| A throwing `NoThrow` function | Rejected, SC7001 | Rejected, SC7001 | Annotation cannot remove real error behavior. |
| `ProgramLifetime` | Rejected, SC7008 | Rejected, SC7008 | Executable-only; unavailable in our library build. |
| Native `--ffi` | Rejected by library CLI | Rejected by library CLI | Not a direct route to C helpers in our existing build mode. |
| Constructor-only readonly linked `Acyclic` node | Rejected, SC7007 | Rejected, SC7007 | A conservative inference limitation worth reporting upstream with the generated repro. |

Exact diagnostics and tiny source/profile repros are saved under `dist/optimization/<version>/COMPATIBILITY.json` and `build/optimization/<version>/compatibility/`. The checked diagnostic failures are part of the build script. The readonly node rejection should not be generalized to all acyclic classes; the scalar-field class in the paired kernel compiles successfully.

Upgrading alone was not a general fuel solution in the original sample: the unmodified SDK pipeline grew from 82,374 to 84,688 fuel, checked bigint math changed by only eight fuel, and some object allocations and host operations improved. The compiler and runtime change together, so this is a toolchain comparison rather than an isolated compiler pass comparison. The current project combines 0.4.0 with the optimized SDK codecs.

The codec improvements are now applied and representative contracts are remeasured by `bench:sdk`. Heavy arithmetic would still benefit from a fixed-width u128 representation or batched native Wasm helpers. Such helpers may be linked through the existing callback/WAT approach; `--ffi` being unavailable does not by itself require changing the compiler. A fork would become relevant if we specifically need compiler-level bigint specialization or library ownership/ABI features that upstream will not provide. Neither is required for the gains demonstrated here.

Official references: [contract types](https://scriptc.dev/docs/contracts), [Wasm library ABI and ownership](https://scriptc.dev/docs/wasm), [FFI limits](https://scriptc.dev/docs/ffi).

## Reproduce

Install project dependencies, then run:

```sh
npm run build:bench:optimize
npm run bench:optimize -- --iterations 20 --no-grow
npm run test:bench:optimize
ALKANES_DIST=dist/optimization/0.4.0 npm test
npm run build
npm run bench:sdk -- --output bench/SDK_OPTIMIZATION_RESULTS.md
```

`test:bench:optimize` runs the production codec tests, which are also included in `npm test`. They compare the actual SDK with independently expected hexadecimal bytes and the preserved legacy functions across all byte values, 500 seeded random u128s, limb boundaries, offset typed-array views, short storage values, unusual offsets and out-of-range inputs. Writer tests cover numeric u32 boundaries, fractions, nonfinite values, 500 seeded random u32s, byte aliasing and repeated finishes. The tests transpile the production TypeScript using the project's TypeScript compiler. The fuel runner separately validates full-width Wasm roundtrips and expected scalar checksums.

To reproduce the codec follow-up comparison, build production contracts from `0a1dd35` and `588dda7` in separate checkouts with their pinned toolchain, then use `bench:sdk -- --baseline <directory-with-reference-wasm>` from `588dda7`. The subsequent [execution comparison](EXECUTION_RESULTS.md) uses `588dda7` as its reference and the current checkout as production. Verify reference hashes against each saved report. To regenerate the current probe report, use `npm run bench:optimize -- --iterations 20 --no-grow --output bench/SDK_PROBE_RESULTS.md`.

The benchmark runner defaults to the last toolchain built by `build:bench:optimize`. To compare the current algorithms under both toolchains without changing the root pins, install 0.3.6 in an isolated directory, then build the current 0.4.0 side. These reruns include subsequent SDK changes; the historical report remains a record of its original artifacts:

```sh
npm install --prefix build/toolchains/scriptc-0.3.6 --save-exact \
  scriptc@0.3.6 @scriptc/runtime-wasm32-wasi@0.3.6 @scriptc/types@0.3.6 --ignore-scripts
node build/toolchains/scriptc-0.3.6/node_modules/scriptc/scripts/install-native.mjs
npm run build:bench:optimize -- --toolchain build/toolchains/scriptc-0.3.6
npm run build:bench:optimize
npm run bench:optimize -- --versions 0.3.6,0.4.0 --iterations 20 --no-grow \
  --output /tmp/toolchain-comparison.md
ALKANES_DIST=dist/optimization/0.4.0 npm test
```

Omit `--no-grow` for the indexer's memory setup. Zig cache redirection and the instruction-fuel harness limitations are the same as in [the isolation suite](ISOLATION.md). Artifact hashes and type/compiler versions are included in each saved report. These experiments used Zig 0.17.0 and Binaryen 125.
