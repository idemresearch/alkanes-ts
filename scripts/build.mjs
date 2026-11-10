#!/usr/bin/env node
// Builds contracts/<name>/index.ts into an alkanes contract at dist/<name>.wasm.
//
//   1. Generate an entry module exposing execute(context) and meta().
//   2. Compile it with scriptc as a wasm32-wasi library (reactor). The link
//      goes through scripts/link.mjs, which replaces libc's vsnprintf and
//      snprintf with shim/printf.c when every format they can receive is
//      one it implements.
//   3. wasm-merge it with shim/adapter.wat (alkanes ABI <-> scriptc callbacks)
//      and shim/wasi.wat (deterministic WASI stand-ins).
//   4. Strip every export except memory/__execute/__meta and optimize, keeping
//      to wasm features the alkanes VM (wasmi 0.37) accepts.
//   5. Check the result only imports env.* and write a gzipped copy, which is
//      the form alkanes deployment envelopes carry.
//
// A build whose inputs are unchanged is skipped (see buildStamp), assembled
// shims are shared between contracts (build/cache), and the command line
// builds several contracts in parallel. docs/ARCHITECTURE.md has the details.

import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import ts from "typescript";
import { compileContract } from "../compiler/index.mjs";
import { generateClient } from "../compiler/client.mjs";
import { wordProfile, wordAdapter, U32_CONVERSION } from "../compiler/word-abi.mjs";
import { snapshotModule, SnapshotRefused } from "./snapshot.mjs";
import { functionNamesOnly, stripCustomSections } from "./printf-formats.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = (name) => join(root, "node_modules", ".bin", name);
const zig = process.env.ALKANES_ZIG || "zig";
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// Features used by scriptc output and supported by wasmi 0.37's default config.
const FEATURES = [
  "--mvp-features",
  "--enable-bulk-memory",
  "--enable-sign-ext",
  "--enable-nontrapping-float-to-int",
  "--enable-mutable-globals",
];

const PROFILE_CALLBACKS = [
  { name: "__alk_abort", params: [], returns: "void" },
  { name: "__alk_log", params: ["bytes"], returns: "void" },
  // An f64 offset, converted in the adapter: see shim/adapter.wat.
  { name: "__alk_scratch_read", params: ["f64"], returns: "u32" },
  { name: "__alk_load_storage", params: ["bytes"], returns: "u32" },
  { name: "__alk_balance", params: ["bytes", "bytes"], returns: "u32" },
  { name: "__alk_sequence", params: [], returns: "u32" },
  { name: "__alk_fuel", params: [], returns: "u32" },
  { name: "__alk_height", params: [], returns: "u32" },
  { name: "__alk_transaction", params: [], returns: "u32" },
  { name: "__alk_block", params: [], returns: "u32" },
  { name: "__alk_extcall", params: ["u32", "bytes", "bytes", "bytes", "f64"], returns: "i32" },
];

function run(cmd, args, env = process.env) {
  try {
    execFileSync(cmd, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    process.stderr.write(e.stdout?.toString() ?? "");
    process.stderr.write(e.stderr?.toString() ?? "");
    throw new Error(`${relative(root, cmd)} failed`);
  }
}

// The tools a build runs, checked once per process so a missing one is
// reported by name instead of as a failed command. The versions are part of
// every build stamp.
let toolchainVersions = null;
export function toolchain() {
  if (toolchainVersions) return toolchainVersions;
  if (Number(process.versions.node.split(".")[0]) < 24) {
    throw new Error(`alkanes-ts needs Node.js 24 or later; this is ${process.version}`);
  }
  const installed = (name) => {
    try {
      return JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")).version;
    } catch {
      throw new Error(`${name} is not installed; run npm install`);
    }
  };
  const versions = {
    node: process.version,
    scriptc: installed("scriptc"),
    runtime: installed("@scriptc/runtime-wasm32-wasi"),
    types: installed("@scriptc/types"),
    binaryen: installed("binaryen"),
  };
  if (versions.scriptc !== versions.runtime) {
    throw new Error(`scriptc ${versions.scriptc} needs @scriptc/runtime-wasm32-wasi at the same version, found ${versions.runtime}; run npm install`);
  }
  try {
    versions.zig = execFileSync(zig, ["version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    throw new Error(e.code === "ENOENT"
      ? `Zig was not found (tried "${zig}"). Install it from https://ziglang.org/download/ (the saved reports use 0.17.0) and put it on PATH, or set ALKANES_ZIG to the executable.`
      : `could not run "${zig} version": ${e.message}`);
  }
  return (toolchainVersions = versions);
}

// Outputs that depend only on the toolchain and a shim's source, shared by
// every contract. The rename keeps concurrent builds (parallel contracts,
// parallel test files) from reading a partial file.
const cacheDirectory = join(root, "build", "cache");
function shared(name, inputs, produce) {
  const path = join(cacheDirectory, `${name}-${sha256(JSON.stringify(inputs)).slice(0, 24)}.wasm`);
  if (!existsSync(path)) {
    mkdirSync(cacheDirectory, { recursive: true });
    const partial = `${path}.${process.pid}.tmp`;
    produce(partial);
    renameSync(partial, path);
  }
  return path;
}

// -g keeps function names; every step does until the last (see finish).
function assemble(source) {
  return shared("wat", [toolchain().binaryen, FEATURES, readFileSync(source, "utf8")],
    (out) => run(bin("wasm-as"), [...FEATURES, "-g", source, "-o", out]));
}

// shim/word.c or shim/word-sdk.c as a module that imports the contract's
// memory and has no data of its own.
function wordModule(sdk, stackSize) {
  const source = join(root, sdk ? "shim/word-sdk.c" : "shim/word.c");
  const args = ["--target=wasm32-wasi", "-O3", "-flto", "-mbulk-memory", "-nostdlib", "-fno-stack-protector",
    "-Wl,--no-entry", "-Wl,--import-memory", "-Wl,--export=__stack_pointer",
    ...(stackSize === null ? [] : [`-Wl,-z,stack-size=${stackSize}`])];
  const sources = ["shim/word.c", "shim/word-sdk.c"].map((file) => readFileSync(join(root, file), "utf8"));
  return shared("word", [toolchain().zig, toolchain().binaryen, FEATURES, args, sdk, sources], (out) => {
    const linked = `${out}.linked.wasm`, text = `${out}.wat`;
    try {
      run(zig, ["cc", ...args, source, "-o", linked]);
      run(bin("wasm-dis"), [...FEATURES, linked, "-o", text]);
      const native = readFileSync(text, "utf8");
      if (native.split('(import "env" "memory"').length !== 2 || /^\s*\(data\b/m.test(native)) {
        throw new Error("word SDK requires imported memory and no static data segments");
      }
      writeFileSync(text, native.replace('(import "env" "memory"', '(import "contract" "memory"'));
      run(bin("wasm-as"), [...FEATURES, "-g", text, "-o", out]);
    } finally {
      rmSync(linked, { force: true });
      rmSync(text, { force: true });
    }
  });
}

// shim/printf.c replaces libc's vsnprintf/snprintf at scriptc's link step,
// through the scripts/link.mjs SCRIPTC_LINKER wrapper, wherever every format
// it can receive is one it implements. Compiled once per process; the rename
// keeps concurrent builds (parallel test files) from reading a partial file.
let printfObject = null;
export function minimalPrintfObject() {
  if (printfObject) return printfObject;
  const object = join(root, "build", "shim", "printf.o");
  const partial = `${object}.${process.pid}`;
  mkdirSync(dirname(object), { recursive: true });
  run(zig, ["cc", "--target=wasm32-wasi", "-Oz", "-c", join(root, "shim", "printf.c"), "-o", partial]);
  renameSync(partial, object);
  return (printfObject = object);
}

// Shadow-stack size for contract modules. zig's wasm32 default is 16 MiB,
// placed before the data; 1 MiB matches Rust's wasm32 default and keeps each
// instance's initial memory small (scripts/link.mjs explains the cost).
export const CONTRACT_STACK_SIZE = 1 << 20;

function linkerEnvironment(report, printf, stackSize) {
  if (printf !== "minimal" && stackSize === null) return {};
  const linker = join(root, "scripts", "link.mjs");
  try {
    accessSync(linker, constants.X_OK);
  } catch {
    chmodSync(linker, 0o755); // scriptc executes SCRIPTC_LINKER directly
  }
  return {
    SCRIPTC_LINKER: linker,
    ALKANES_ZIG: zig,
    ALKANES_LINK_OBJECTS: printf === "minimal" ? minimalPrintfObject() : "",
    ...(printf === "minimal" ? { ALKANES_LINK_REPORT: report } : {}),
    ...(stackSize === null ? {} : { ALKANES_STACK_SIZE: String(stackSize) }),
    ALKANES_KEEP_NAMES: "1",
  };
}

// Build stamps. A build is skipped when nothing that decides its output has
// changed since the build that wrote the files on disk: the entry module and
// every file it imports, the pipeline's own scripts and shims, the options,
// the toolchain versions and the environment variables the tools read. The
// stamp is a hash of all of those, stored beside the intermediates. A stamp
// that cannot be computed (an import that is not a file) disables the skip.
const PIPELINE_FILES = ["scripts/build.mjs", "scripts/link.mjs", "scripts/snapshot.mjs", "scripts/printf-formats.mjs",
  "compiler/word-abi.mjs", "shim/adapter.wat", "shim/wasi.wat", "shim/printf.c", "shim/word.c", "shim/word-sdk.c",
  "tsconfig.json"];
let pipelineHash = null;
function pipelineInputs() {
  if (pipelineHash) return pipelineHash;
  const hash = createHash("sha256");
  for (const file of PIPELINE_FILES) hash.update(`${file}\0`).update(readFileSync(join(root, file))).update("\0");
  // scriptc reads its settings (type patches, package options) from the
  // "scriptc" key; the rest of package.json does not reach a build.
  const settings = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  hash.update(JSON.stringify([settings.type ?? null, settings.scriptc ?? null]));
  return (pipelineHash = hash.digest("hex"));
}

// The entry module and the files it reaches through relative or absolute
// imports, with their hashes. Bare specifiers (@scriptc/types) are covered by
// the toolchain versions.
function sourceGraph(entry) {
  const seen = new Map();
  const queue = [resolve(entry)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return null;
    }
    seen.set(file, sha256(text));
    for (const { fileName } of ts.preProcessFile(text, true, true).importedFiles) {
      if (fileName.startsWith(".") || isAbsolute(fileName)) queue.push(resolve(dirname(file), fileName));
    }
  }
  return [...seen].map(([file, hash]) => [relative(root, file), hash]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function buildStamp({ entry, out, compiler, runtimePack, options }) {
  const sources = sourceGraph(entry);
  if (!sources) return null;
  const tool = (path) => {
    const stat = statSync(path);
    return [path, stat.size, stat.mtimeMs];
  };
  return sha256(JSON.stringify({
    format: 1,
    out: relative(root, out),
    entry: relative(root, entry),
    options,
    toolchain: toolchain(),
    compiler: compiler === bin("scriptc") ? null : tool(compiler),
    runtimePack: runtimePack ? [runtimePack, existsSync(join(runtimePack, "package.json")) ? readFileSync(join(runtimePack, "package.json"), "utf8") : null] : null,
    environment: Object.entries(process.env).filter(([name]) => name.startsWith("SCRIPTC_") || name === "ALKANES_ZIG").sort(),
    pipeline: pipelineInputs(),
    sources,
  }));
}

const summary = (out, result) => `${relative(root, out)}  ${result.bytes} bytes (${result.gzipped} gzipped)` +
  (result.snapshot ? `, initialized snapshot ${result.snapshot.dataBytes} data bytes` : "");

function buildContract(name, options = {}) {
  const source = join(root, "contracts", name, "index.ts");
  if (!existsSync(source)) throw new Error(`no contract at ${relative(root, source)}`);
  const work = join(root, "build", name);
  mkdirSync(work, { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });

  const entry = join(work, "entry.ts");
  const importPath = (p) => "./" + relative(work, p).replaceAll("\\", "/");
  const compiled = compileContract({ filename: source, wordLowering: true });
  if (compiled) {
    for (const warning of compiled.warnings ?? []) console.warn(warning);
    writeFileSync(entry, compiled.lowered);
    writeFileSync(join(root, "dist", `${name}.abi.json`), compiled.abi + "\n");
    writeFileSync(join(root, "dist", `${name}.manifest.json`), JSON.stringify(compiled.manifest, null, 2) + "\n");
    writeFileSync(join(root, "dist", `${compiled.manifest.contract}Client.ts`), generateClient(compiled.manifest, join(root, "client/runtime.ts")));
  } else writeFileSync(
    entry,
    `// Generated by scripts/build.mjs.
import contract from "${importPath(source)}";
import { contractMeta, executeContract } from "${importPath(join(root, "sdk", "contract.ts"))}";

export function execute(context: Uint8Array): Uint8Array {
  return executeContract(contract, context);
}

export function meta(): Uint8Array {
  return contractMeta(contract);
}
`,
  );

  return buildLibrary({ entry, work, out: join(root, "dist", `${name}.wasm`), word: compiled?.word, ...options });
}

// Steps 3 and 4: merge the compiled module with the shims, remove what the
// final exports do not reach, snapshot initialization and optimize. Function
// names are carried through every step (-g) and removed at the end, so
// <work>/named.wasm is the shipped module with its names: the input for
// scripts/size.mjs and for profilers.
function finish({ compiled, work, out, word, stackSize, extraExports, benchmark, snapshot }) {
  let snapshotInfo = null;

  let adapterSource;
  if (word) {
    adapterSource = join(work, "adapter.wat");
    writeFileSync(adapterSource, wordAdapter(word === "sdk"));
    copyFileSync(wordModule(word === "sdk", stackSize), join(work, "word.wasm"));
  } else {
    // The init export is consumed by the build-time snapshot (or kept for the
    // isolation benchmarks); metadce removes it otherwise.
    adapterSource = join(work, "adapter.wat");
    writeFileSync(adapterSource, readFileSync(join(root, "shim", "adapter.wat"), "utf8")
      .replace("(func $ensure_initialized", '(func $ensure_initialized (export "__bench_init")')
      .replace(";; @u32-conversion", U32_CONVERSION));
  }
  const adapter = join(work, "adapter.wasm");
  const wasi = join(work, "wasi.wasm");
  copyFileSync(assemble(adapterSource), adapter);
  copyFileSync(assemble(join(root, "shim", "wasi.wat")), wasi);

  const merged = join(work, "merged.wasm");
  run(bin("wasm-merge"), [
    ...FEATURES, "-g",
    compiled, "contract",
    adapter, "scriptc",
    wasi, "wasi_snapshot_preview1",
    ...(word ? [join(work, "word.wasm"), "word"] : []),
    "-o", merged,
  ]);

  const roots = (names) => JSON.stringify(names.map((e) => ({ name: e, root: true, export: e })));
  const finalRoots = ["memory", "__execute", "__meta", ...extraExports.map((e) => e.symbol),
    ...(benchmark ? ["__bench_init"] : [])];
  const graph = join(work, "dce-graph.json");
  writeFileSync(graph, roots(finalRoots));
  const reduced = join(work, "reduced.wasm");
  // Production modules start from a build-time snapshot of initialization
  // (scripts/snapshot.mjs). Benchmark builds keep explicit initialization
  // because the isolation harness measures it through __bench_init.
  if (snapshot && !benchmark) {
    const initGraph = join(work, "dce-graph-init.json");
    writeFileSync(initGraph, roots([...finalRoots, "__bench_init"]));
    const withInit = join(work, "reduced-init.wasm");
    run(bin("wasm-metadce"), [...FEATURES, "-g", merged, "--graph-file", initGraph, "-o", withInit]);
    try {
      const result = snapshotModule(readFileSync(withInit), { debugInfo: true });
      const snapshotted = join(work, "snapshot.wasm");
      writeFileSync(snapshotted, result.bytes);
      run(bin("wasm-metadce"), [...FEATURES, "-g", snapshotted, "--graph-file", graph, "-o", reduced]);
      snapshotInfo = { pages: result.pages, segments: result.segments, dataBytes: result.dataBytes };
    } catch (error) {
      if (!(error instanceof SnapshotRefused)) throw error;
      console.log(`${relative(root, out)}: initialization not snapshotted (${error.message})`);
      run(bin("wasm-metadce"), [...FEATURES, "-g", merged, "--graph-file", graph, "-o", reduced]);
    }
  } else {
    run(bin("wasm-metadce"), [...FEATURES, "-g", merged, "--graph-file", graph, "-o", reduced]);
  }

  const named = join(work, "named.wasm");
  run(bin("wasm-opt"), [...FEATURES, "-Oz", "--converge", "-g", "--strip-producers", reduced, "-o", named]);
  writeFileSync(out, stripCustomSections(readFileSync(named)));
  return snapshotInfo;
}

// The isolation fixtures use the production linker/optimizer, with additional
// scalar exports and a benchmark-only hook into the adapter's init guard.
//
// `cache: false` rebuilds even when the build stamp matches (the command
// line's --force, or ALKANES_NO_CACHE=1).
export function buildLibrary({ entry, work, out, extraExports = [], benchmark = false,
  compiler = bin("scriptc"), runtimePack, word = false, snapshot = true, printf = "minimal",
  stackSize = CONTRACT_STACK_SIZE, cache = !process.env.ALKANES_NO_CACHE }) {
  if (printf !== "minimal" && printf !== "libc") throw new Error(`unknown printf option ${printf}`);
  // null keeps the toolchain's 16 MiB stack, to reproduce earlier binaries.
  if (stackSize !== null && !(Number.isInteger(stackSize) && stackSize > 0 && stackSize % 16 === 0)) {
    throw new Error(`stackSize must be a positive multiple of 16 or null, got ${stackSize}`);
  }
  toolchain();
  mkdirSync(work, { recursive: true });
  mkdirSync(dirname(out), { recursive: true });

  const compiled = join(work, "contract.wasm");
  const stampFile = join(work, `${relative(dirname(out), out)}.stamp.json`);
  const stamp = buildStamp({ entry, out, compiler, runtimePack, options: { extraExports, benchmark, word, snapshot, printf, stackSize } });
  if (stamp && cache) {
    try {
      const previous = JSON.parse(readFileSync(stampFile, "utf8"));
      if (previous.stamp === stamp && existsSync(compiled) && existsSync(`${out}.gz`) &&
          sha256(readFileSync(out)) === previous.sha256) {
        console.log(`${summary(out, previous.result)}, unchanged`);
        return { ...previous.result, cached: true };
      }
    } catch {
      // No stamp, or outputs missing: build.
    }
  }
  rmSync(stampFile, { force: true });

  const profile = join(work, "profile.json");
  writeFileSync(
    profile,
    JSON.stringify(
      {
        profile_format: 1,
        name: "contract",
        entry: relative(work, entry),
        emission: "llvm",
        abi: {
          prefix: "contract_",
          init_symbol: "contract_init",
          sink_register_symbol: "contract_sink",
          callback_register_symbol: "contract_callback",
        },
        callbacks: word ? wordProfile(word === "sdk") : PROFILE_CALLBACKS,
        exports: [
          { export: "execute", symbol: "contract_execute", params: ["bytes"], returns: word ? "f64" : "bytes" },
          { export: "meta", symbol: "contract_meta", params: [], returns: "bytes" },
          ...extraExports,
        ],
      },
      null,
      2,
    ),
  );

  const printfReport = join(work, "printf-formats.json");
  rmSync(printfReport, { force: true });
  run(compiler, ["build", "--lib", "--profile", profile, "-o", compiled], {
    ...process.env,
    SCRIPTC_TARGET: "wasm32-wasi",
    ...(runtimePack ? { SCRIPTC_RUNTIME_PACK: runtimePack } : {}),
    ...linkerEnvironment(printfReport, printf, stackSize),
  });
  let linkedPrintf = "libc";
  if (printf === "minimal") {
    const report = JSON.parse(readFileSync(printfReport, "utf8"));
    linkedPrintf = report.printf;
    if (linkedPrintf !== "minimal") console.log(`${relative(root, out)}: libc printf kept (${report.reason})`);
  }
  if (printf === "minimal" || stackSize !== null) {
    // The wrapper kept the name section, for its format check and for
    // named.wasm. Everything else wasm-ld would remove with --strip-debug
    // (DWARF, producers, names of anything but functions) goes here.
    writeFileSync(compiled, functionNamesOnly(readFileSync(compiled)));
  }

  const snapshotInfo = finish({ compiled, work, out, word, stackSize, extraExports, benchmark, snapshot });

  const bytes = readFileSync(out);
  const module = new WebAssembly.Module(bytes);
  const badImports = WebAssembly.Module.imports(module).filter((i) => i.module !== "env" || i.kind !== "function");
  if (badImports.length > 0) {
    throw new Error(
      `unresolved imports: ${badImports.map((i) => `${i.module}.${i.name}`).join(", ")}`,
    );
  }
  const exports = WebAssembly.Module.exports(module).map((e) => e.name).sort();
  const expected = ["__execute", "__meta", "memory", ...extraExports.map((e) => e.symbol),
    ...(benchmark ? ["__bench_init"] : [])].sort();
  if (exports.join(",") !== expected.join(",")) {
    throw new Error(`unexpected exports: ${exports.join(", ")}`);
  }
  const compressed = gzipSync(bytes, { level: 9 });
  writeFileSync(`${out}.gz`, compressed);
  const result = { bytes: bytes.length, gzipped: compressed.length, snapshot: snapshotInfo, printf: linkedPrintf };
  console.log(summary(out, result));

  if (stamp) writeFileSync(stampFile, JSON.stringify({ stamp, sha256: sha256(bytes), result }, null, 2) + "\n");
  return result;
}

const USAGE = `usage: node scripts/build.mjs [contract ...] [options]

Builds contracts/<contract>/index.ts into dist/<contract>.wasm; every contract
when none is named.

  --force          rebuild even when nothing changed (also: ALKANES_NO_CACHE=1)
  --jobs <n>       contracts built at once (default: one per CPU)
  --no-snapshot    keep per-call initialization, for A/B measurements
  --libc-printf    link libc's vsnprintf/snprintf, for A/B measurements
`;

function parseArguments(args) {
  const options = { names: [], flags: [], jobs: availableParallelism() };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--jobs" || arg === "-j" || arg.startsWith("--jobs=")) {
      const value = arg.startsWith("--jobs=") ? arg.slice(7) : args[++i];
      if (!/^[1-9][0-9]*$/.test(value ?? "")) throw new Error(`--jobs needs a positive number\n\n${USAGE}`);
      options.jobs = Number(value);
    } else if (["--force", "--no-snapshot", "--libc-printf"].includes(arg)) options.flags.push(arg);
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}\n\n${USAGE}`);
    else options.names.push(arg);
  }
  return options;
}

async function main(args) {
  const { help, names, flags, jobs } = parseArguments(args);
  if (help) return void process.stdout.write(USAGE);
  const available = readdirSync(join(root, "contracts")).filter((name) => existsSync(join(root, "contracts", name, "index.ts"))).sort();
  const targets = names.length > 0 ? [...new Set(names)] : available;
  const unknown = targets.filter((name) => !available.includes(name));
  if (unknown.length > 0) throw new Error(`no contract named ${unknown.join(", ")}; contracts/ has ${available.join(", ")}`);
  toolchain();

  const started = performance.now();
  let failed = 0;
  if (targets.length === 1 || jobs === 1) {
    // --no-snapshot keeps per-call initialization and --libc-printf links
    // libc's vsnprintf/snprintf, for A/B measurements.
    const options = { snapshot: !flags.includes("--no-snapshot"), printf: flags.includes("--libc-printf") ? "libc" : "minimal", ...(flags.includes("--force") ? { cache: false } : {}) };
    for (const name of targets) buildContract(name, options);
  } else {
    // One process per contract. Output is printed in the order the contracts
    // were named, each one's as a block.
    let next = 0;
    const results = targets.map(() => Promise.withResolvers());
    const worker = async () => {
      while (next < targets.length) {
        const index = next++;
        execFile(process.execPath, [fileURLToPath(import.meta.url), targets[index], ...flags, "--jobs=1"],
          { cwd: root, maxBuffer: 1 << 26 }, (error, stdout, stderr) => results[index].resolve({ error, stdout, stderr }));
        await results[index].promise;
      }
    };
    for (let i = 0; i < Math.min(jobs, targets.length); i++) worker();
    for (const { promise } of results) {
      const { error, stdout, stderr } = await promise;
      process.stdout.write(stdout);
      process.stderr.write(stderr);
      if (error) failed++;
    }
  }
  if (failed > 0) throw new Error(`${failed} of ${targets.length} contracts failed to build`);
  if (targets.length > 1) console.log(`${targets.length} contracts in ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    // Diagnostics carry their own file:line:column; a stack adds nothing.
    process.stderr.write(`${process.env.ALKANES_DEBUG ? error.stack : error.message}\n`);
    process.exitCode = 1;
  }
}
