// Runs a contract from its TypeScript source in Node, so a test does not wait
// for a Wasm build and needs neither scriptc nor Zig.
//
// The frontend lowers the contract exactly as the build does for the general
// (bigint) backend: checked u128 operators, state accessors, dispatch. That
// TypeScript and the SDK modules it imports are transpiled and evaluated
// here, with the SDK's host callbacks (sdk/host.ts) supplied by the caller.
// AlkanesVM.deploy(id, "contracts/<name>/index.ts") is the way in.
//
// This is the same source the Wasm module is compiled from, run by V8
// instead of scriptc. It is not the shipped binary: fuel, module size and the
// fixed-width backend are only exercised by a built contract, so a contract
// that passes here should still run its tests against dist/ before it ships.
// test/source.test.mjs holds the two to identical results.

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { compileContract } from "../compiler/index.mjs";

const root = resolve(import.meta.dirname, "..");

// The callbacks sdk/host.ts declares. Every module is evaluated with these
// names bound to one invocation's host, as scriptc binds them to imports.
export const HOST_CALLBACKS = ["__alk_abort", "__alk_log", "__alk_scratch_read", "__alk_load_storage", "__alk_balance",
  "__alk_sequence", "__alk_fuel", "__alk_height", "__alk_transaction", "__alk_block", "__alk_extcall"];

// One compiled function per module, reused by every instance.
const factories = new Map();
function factory(file, text) {
  let run = factories.get(file);
  if (run) return run;
  const { outputText, diagnostics } = ts.transpileModule(text ?? readFileSync(file, "utf8"), {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, inlineSourceMap: true, inlineSources: true },
  });
  if (diagnostics.length > 0) {
    throw new Error(ts.formatDiagnostics(diagnostics, { getCurrentDirectory: () => root, getCanonicalFileName: (f) => f, getNewLine: () => "\n" }));
  }
  run = new vm.Script(`(function (exports, require, ${HOST_CALLBACKS.join(", ")}) {${outputText}\n})`, { filename: file }).runInThisContext();
  factories.set(file, run);
  return run;
}

export class SourceProgram {
  constructor(filename) {
    this.filename = resolve(filename);
    const compiled = compileContract({ filename: this.filename });
    for (const warning of compiled?.warnings ?? []) console.warn(warning);
    // A module that is not an authoring class exports a contract object, and
    // gets the entry the build writes for it.
    this.lowered = compiled ? compiled.lowered : `import contract from ${JSON.stringify(this.filename)};
import { contractMeta, executeContract } from ${JSON.stringify(join(root, "sdk", "contract.ts"))};
export function execute(context: Uint8Array): Uint8Array { return executeContract(contract, context); }
export function meta(): Uint8Array { return contractMeta(contract); }
`;
    this.manifest = compiled?.manifest ?? null;
    // A copy of the module that runs, named for V8 and kept for reference.
    this.entry = join(root, "build", "source", relative(root, this.filename));
    mkdirSync(dirname(this.entry), { recursive: true });
    writeFileSync(this.entry, this.lowered);
  }

  // A fresh module graph bound to `host`: module-level state (the SDK's
  // storage cache, the read-only flag) starts over, as it does in the fresh
  // Wasm instance every invocation gets.
  instantiate(host) {
    const callbacks = HOST_CALLBACKS.map((name) => host[name]);
    const modules = new Map();
    const load = (file, text) => {
      let module = modules.get(file);
      if (!module) {
        modules.set(file, (module = { exports: {} }));
        const require = (specifier) => {
          if (!specifier.startsWith(".") && !isAbsolute(specifier)) {
            throw new Error(`${relative(root, file)} imports "${specifier}"; source execution runs relative TypeScript modules only`);
          }
          return load(resolve(dirname(file), specifier)).exports;
        };
        factory(file, text)(module.exports, require, ...callbacks);
      }
      return module;
    };
    const { execute, meta } = load(this.entry, this.lowered).exports;
    return { execute, meta };
  }
}

// One program per source file and modification time.
const programs = new Map();
export function sourceProgram(filename) {
  const file = resolve(filename);
  const modified = statSync(file).mtimeMs;
  const cached = programs.get(file);
  if (cached?.modified === modified) return cached.program;
  factories.delete(join(root, "build", "source", relative(root, file)));
  const program = new SourceProgram(file);
  programs.set(file, { modified, program });
  return program;
}
