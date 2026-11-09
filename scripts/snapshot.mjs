// Build-time pre-initialization ("snapshot") for contract modules.
//
// Alkanes instantiates a fresh module for every invocation, so the scriptc
// reactor's _initialize and the contract's module-level code run on every
// call. That work is deterministic and host-independent: the WASI stand-ins
// are merged into the module and every remaining import is an env.* host
// function. This pass runs the init export once at build time, captures the
// resulting linear memory and globals, and rewrites the module so it starts in
// that state. The init function becomes a no-op and its code is removed by the
// following optimization pass.
//
// If initialization touches any env.* import, the snapshot is refused: the
// result would depend on host state. The caller decides whether to fail or keep
// the unsnapshotted module.

import binaryen from "binaryen";

const PAGE = 65536;
// Zero runs shorter than this stay inside one data segment; a segment header
// costs a few bytes, so splitting tiny gaps would grow the module.
const MIN_GAP = 16;

export class SnapshotRefused extends Error {}

// The same feature set the build passes to wasm-opt (wasmi 0.37 defaults).
const FEATURES = binaryen.Features.MVP | binaryen.Features.BulkMemory | binaryen.Features.BulkMemoryOpt |
  binaryen.Features.SignExt | binaryen.Features.NontrappingFPToInt | binaryen.Features.MutableGlobals;

function exportedFunction(module, name) {
  for (let i = 0; i < module.getNumExports(); i++) {
    const info = binaryen.getExportInfo(module.getExportByIndex(i));
    if (info.name === name && info.kind === binaryen.ExternalFunction) return info.value;
  }
  return null;
}

// Returns the bytes of a module whose initialization (performed by calling
// `initExport`) has already happened. `initExport` is removed. `debugInfo`
// keeps the input's name section in the result.
export function snapshotModule(bytes, { initExport = "__bench_init", features = FEATURES, debugInfo = false } = {}) {
  // 1. Instrument: export every defined global so its post-init value can be
  //    read. The instrumented copy is only used for evaluation.
  const probe = binaryen.readBinary(bytes);
  probe.setFeatures(features);
  const globals = [];
  for (let i = 0; i < probe.getNumGlobals(); i++) {
    const info = binaryen.getGlobalInfo(probe.getGlobalByIndex(i));
    if (info.module) continue; // imported globals cannot be rewritten
    if (info.type !== binaryen.i32 && info.type !== binaryen.i64 && info.type !== binaryen.f32 && info.type !== binaryen.f64) {
      throw new SnapshotRefused(`global ${info.name} has unsupported type`);
    }
    const exportName = `__snapshot_global_${globals.length}`;
    probe.addGlobalExport(info.name, exportName);
    globals.push({ name: info.name, type: info.type, mutable: info.mutable, exportName });
  }
  const instrumented = probe.emitBinary();
  probe.dispose();

  // 2. Evaluate with host imports that refuse to run.
  const wasmModule = new WebAssembly.Module(instrumented);
  const imports = {};
  for (const imp of WebAssembly.Module.imports(wasmModule)) {
    if (imp.kind !== "function") throw new SnapshotRefused(`non-function import ${imp.module}.${imp.name}`);
    imports[imp.module] ??= {};
    imports[imp.module][imp.name] = () => {
      throw new SnapshotRefused(`initialization called host import ${imp.module}.${imp.name}`);
    };
  }
  const instance = new WebAssembly.Instance(wasmModule, imports);
  const init = instance.exports[initExport];
  if (typeof init !== "function") throw new SnapshotRefused(`no ${initExport} export`);
  try {
    init();
  } catch (error) {
    if (error instanceof SnapshotRefused) throw error;
    throw new SnapshotRefused(`initialization trapped: ${error.message}`);
  }
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new SnapshotRefused("module does not export memory");
  const image = new Uint8Array(memory.buffer.slice(0));
  const values = new Map(globals.map((g) => [g.name, instance.exports[g.exportName].value]));

  // 3. Rewrite the original module.
  const module = binaryen.readBinary(bytes);
  module.setFeatures(features);
  const initFunction = exportedFunction(module, initExport);
  if (!initFunction) throw new SnapshotRefused(`no ${initExport} export`);

  // Globals: re-add each defined global with its captured value. References
  // are by name, so uses stay valid.
  for (const g of globals) {
    const value = values.get(g.name);
    let init;
    if (g.type === binaryen.i32) init = module.i32.const(value);
    else if (g.type === binaryen.i64) init = module.i64.const(Number(BigInt.asUintN(32, value)), Number(BigInt.asUintN(32, value >> 32n)));
    else if (g.type === binaryen.f32) init = module.f32.const(value);
    else init = module.f64.const(value);
    // Exported globals keep their export because exports refer to names.
    module.removeGlobal(g.name);
    module.addGlobal(g.name, g.type, g.mutable, init);
  }

  // Memory: the captured image becomes the initial contents. Only nonzero runs
  // are stored; memory starts zeroed.
  const segments = [];
  let i = 0;
  while (i < image.length) {
    while (i < image.length && image[i] === 0) i++;
    if (i >= image.length) break;
    const start = i;
    let end = i;
    let zeros = 0;
    while (i < image.length) {
      if (image[i] === 0) {
        zeros++;
        if (zeros >= MIN_GAP) break;
      } else {
        zeros = 0;
        end = i + 1;
      }
      i++;
    }
    segments.push({ name: `snapshot.${segments.length}`, offset: module.i32.const(start), data: image.subarray(start, end), passive: false });
    i = end;
  }
  if (!module.hasMemory()) throw new SnapshotRefused("module has no memory");
  const memInfo = module.getMemoryInfo();
  if (memInfo.module) throw new SnapshotRefused("imported memory cannot be snapshotted");
  if (memInfo.shared || memInfo.is64) throw new SnapshotRefused("unsupported memory kind");
  for (let s = 0; s < module.getNumMemorySegments(); s++) {
    if (module.getMemorySegmentInfo(String(s)).passive) throw new SnapshotRefused("passive data segments are not supported");
  }
  const pages = image.length / PAGE;
  // -1 is Binaryen's "no maximum": keep the original limits exactly.
  const max = memInfo.max === undefined ? -1 : Math.max(memInfo.max, pages);
  // setMemory replaces the memory definition and every active data segment;
  // it re-adds the export.
  module.removeExport("memory");
  module.setMemory(pages, max, "memory", segments, false, false);

  // The init export becomes unreachable; init itself becomes a no-op so the
  // reactor/runtime initialization code can be removed.
  module.removeExport(initExport);
  const replaceWithNop = (name) => {
    const info = binaryen.getFunctionInfo(module.getFunction(name));
    module.removeFunction(name);
    module.addFunction(name, info.params, info.results, [], module.nop());
  };
  // The init export is a thin wrapper around the adapter's run-once guard;
  // empty the guard itself so __execute/__meta no longer reach init code.
  const body = binaryen.getFunctionInfo(module.getFunction(initFunction)).body;
  const call = binaryen.getExpressionInfo(body);
  replaceWithNop(call.id === binaryen.CallId ? call.target : initFunction);

  if (!module.validate()) throw new Error("snapshot produced an invalid module");
  binaryen.setDebugInfo(debugInfo);
  let out;
  try {
    out = module.emitBinary();
  } finally {
    binaryen.setDebugInfo(false);
    module.dispose();
  }
  return { bytes: out, pages, segments: segments.length, dataBytes: segments.reduce((n, s) => n + s.data.length, 0) };
}
