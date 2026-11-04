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

import { execFileSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { compileContract } from "../compiler/index.mjs";
import { generateClient } from "../compiler/client.mjs";
import { wordCallbacks, sdkCallbacks, wordAdapter } from "../compiler/word-abi.mjs";
import { snapshotModule, SnapshotRefused } from "./snapshot.mjs";
import { stripCustomSections } from "./printf-formats.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = (name) => join(root, "node_modules", ".bin", name);

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
  { name: "__alk_scratch_read", params: ["u32"], returns: "u32" },
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
  run("zig", ["cc", "--target=wasm32-wasi", "-Oz", "-c", join(root, "shim", "printf.c"), "-o", partial]);
  renameSync(partial, object);
  return (printfObject = object);
}

function linkerEnvironment(report) {
  const linker = join(root, "scripts", "link.mjs");
  try {
    accessSync(linker, constants.X_OK);
  } catch {
    chmodSync(linker, 0o755); // scriptc executes SCRIPTC_LINKER directly
  }
  return { SCRIPTC_LINKER: linker, ALKANES_LINK_OBJECTS: minimalPrintfObject(), ALKANES_LINK_REPORT: report };
}

function buildContract(name, { snapshot = true, printf = "minimal" } = {}) {
  const source = join(root, "contracts", name, "index.ts");
  if (!existsSync(source)) throw new Error(`no contract at ${relative(root, source)}`);
  const work = join(root, "build", name);
  mkdirSync(work, { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });

  const entry = join(work, "entry.ts");
  const importPath = (p) => "./" + relative(work, p).replaceAll("\\", "/");
  const compiled = compileContract({ filename: source, wordLowering: true });
  if (compiled) {
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

  buildLibrary({ entry, work, out: join(root, "dist", `${name}.wasm`), word: compiled?.word, snapshot, printf });
}

// The isolation fixtures use the production linker/optimizer, with additional
// scalar exports and a benchmark-only hook into the adapter's init guard.
export function buildLibrary({ entry, work, out, extraExports = [], benchmark = false,
  compiler = bin("scriptc"), runtimePack, word = false, snapshot = true, printf = "minimal" }) {
  if (printf !== "minimal" && printf !== "libc") throw new Error(`unknown printf option ${printf}`);
  let snapshotInfo = null;
  mkdirSync(work, { recursive: true });
  mkdirSync(dirname(out), { recursive: true });
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
        callbacks: word === 'sdk' ? sdkCallbacks : word ? wordCallbacks : PROFILE_CALLBACKS,
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

  const compiled = join(work, "contract.wasm");
  const printfReport = join(work, "printf-formats.json");
  rmSync(printfReport, { force: true });
  run(compiler, ["build", "--lib", "--profile", profile, "-o", compiled], {
    ...process.env,
    SCRIPTC_TARGET: "wasm32-wasi",
    ...(runtimePack ? { SCRIPTC_RUNTIME_PACK: runtimePack } : {}),
    ...(printf === "minimal" ? linkerEnvironment(printfReport) : {}),
  });
  let linkedPrintf = "libc";
  if (printf === "minimal") {
    // The wrapper kept the name section for its format check; the rest of
    // the pipeline sees the module wasm-ld writes with --strip-debug.
    const report = JSON.parse(readFileSync(printfReport, "utf8"));
    linkedPrintf = report.printf;
    if (linkedPrintf !== "minimal") console.log(`${relative(root, out)}: libc printf kept (${report.reason})`);
    writeFileSync(compiled, stripCustomSections(readFileSync(compiled)));
  }

  const adapter = join(work, "adapter.wasm");
  const wasi = join(work, "wasi.wasm");
  let adapterSource = join(root, "shim", "adapter.wat");
  if (word) {
    adapterSource = join(work, "adapter.wat");
    writeFileSync(adapterSource, wordAdapter(word === 'sdk'));
    run("zig", ["cc", "--target=wasm32-wasi", "-O3", "-flto", "-mbulk-memory", "-nostdlib", "-fno-stack-protector", "-Wl,--no-entry", "-Wl,--import-memory", "-Wl,--export=__stack_pointer", join(root,word === 'sdk'?"shim/word-sdk.c":"shim/word.c"), "-o",join(work,"word.wasm")]);
    run(bin("wasm-dis"),[...FEATURES,join(work,"word.wasm"),"-o",join(work,"word.wat")]);
    const native=readFileSync(join(work,"word.wat"),"utf8");
    if(native.split('(import "env" "memory"').length!==2||/^\s*\(data\b/m.test(native))throw new Error("word SDK requires imported memory and no static data segments");
    writeFileSync(join(work,"word.wat"),native.replace('(import "env" "memory"','(import "contract" "memory"'));
    run(bin("wasm-as"),[...FEATURES,join(work,"word.wat"),"-o",join(work,"word.wasm")]);
  } else {
    // The init export is consumed by the build-time snapshot (or kept for the
    // isolation benchmarks); metadce removes it otherwise.
    adapterSource = join(work, "adapter.wat");
    writeFileSync(adapterSource, readFileSync(join(root, "shim", "adapter.wat"), "utf8")
      .replace("(func $ensure_initialized", '(func $ensure_initialized (export "__bench_init")'));
  }
  run(bin("wasm-as"), [...FEATURES, adapterSource, "-o", adapter]);
  run(bin("wasm-as"), [...FEATURES, join(root, "shim", "wasi.wat"), "-o", wasi]);

  const merged = join(work, "merged.wasm");
  run(bin("wasm-merge"), [
    ...FEATURES,
    compiled, "contract",
    adapter, "scriptc",
    wasi, "wasi_snapshot_preview1",
    ...(word ? [join(work,"word.wasm"),"word"] : []),
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
    run(bin("wasm-metadce"), [...FEATURES, merged, "--graph-file", initGraph, "-o", withInit]);
    try {
      const result = snapshotModule(readFileSync(withInit));
      const snapshotted = join(work, "snapshot.wasm");
      writeFileSync(snapshotted, result.bytes);
      run(bin("wasm-metadce"), [...FEATURES, snapshotted, "--graph-file", graph, "-o", reduced]);
      snapshotInfo = { pages: result.pages, segments: result.segments, dataBytes: result.dataBytes };
    } catch (error) {
      if (!(error instanceof SnapshotRefused)) throw error;
      console.log(`${relative(root, out)}: initialization not snapshotted (${error.message})`);
      run(bin("wasm-metadce"), [...FEATURES, merged, "--graph-file", graph, "-o", reduced]);
    }
  } else {
    run(bin("wasm-metadce"), [...FEATURES, merged, "--graph-file", graph, "-o", reduced]);
  }

  run(bin("wasm-opt"), [...FEATURES, "-Oz", "--strip-debug", "--strip-producers", reduced, "-o", out]);

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
  console.log(`${relative(root, out)}  ${bytes.length} bytes (${compressed.length} gzipped)` +
    (snapshotInfo ? `, initialized snapshot ${snapshotInfo.dataBytes} data bytes` : ""));
  return { bytes: bytes.length, gzipped: compressed.length, snapshot: snapshotInfo, printf: linkedPrintf };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // --no-snapshot keeps per-call initialization and --libc-printf links
  // libc's vsnprintf/snprintf, for A/B measurements.
  const args = process.argv.slice(2);
  const snapshot = !args.includes("--no-snapshot");
  const printf = args.includes("--libc-printf") ? "libc" : "minimal";
  const names = args.filter((a) => !a.startsWith("--"));
  const targets = names.length > 0 ? names : readdirSync(join(root, "contracts"));
  for (const name of targets) buildContract(name, { snapshot, printf });
}
