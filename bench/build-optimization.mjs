#!/usr/bin/env node
import { buildLibrary } from "../scripts/build.mjs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { symbols } from "./isolation/exports.mjs";
import { prepareVariant } from "./optimization/variants.mjs";
import { compileContract } from "../compiler/index.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--toolchain")) {
  throw new Error("usage: node bench/build-optimization.mjs [--toolchain DIRECTORY]");
}
const toolchain = args.length ? resolve(args[1], "node_modules") : join(root, "node_modules");
const compiler = join(toolchain, "scriptc/bin/scriptc.exe");
const runtimePack = join(toolchain, "@scriptc/runtime-wasm32-wasi");
const version = execFileSync(compiler, ["--version"], { encoding: "utf8" }).trim();
const work = join(root, "build/optimization", version);
const out = join(root, "dist/optimization", version);
mkdirSync(join(work, "node_modules/@scriptc"), { recursive: true });
const typesLink = join(work, "node_modules/@scriptc/types");
const existingTypes = lstatSync(typesLink, { throwIfNoEntry: false });
if (existingTypes) {
  if (!existingTypes.isSymbolicLink()) throw new Error(`expected a generated types symlink at ${typesLink}`);
  unlinkSync(typesLink);
}
symlinkSync(join(toolchain, "@scriptc/types"), typesLink, "dir");
mkdirSync(join(work, "contracts"), { recursive: true });
const microEntry = join(work, "contracts/entry.ts");
cpSync(join(root, "bench/optimization/probes.ts"), microEntry);
const exports = {
  prepare: "prepare", plainIntegerArray: "plain_integer_array", contractedIntegerArray: "contracted_integer_array",
  plainNoThrow: "plain_no_throw", contractedNoThrow: "contracted_no_throw",
  plainAcyclic: "plain_acyclic", contractedAcyclic: "contracted_acyclic",
  plainImmutable: "plain_immutable", contractedImmutable: "contracted_immutable",
};
buildLibrary({
  entry: microEntry,
  work: join(work, "contracts"),
  out: join(out, "contracts.wasm"),
  compiler, runtimePack,
  benchmark: true,
  extraExports: Object.entries(exports).map(([name, symbol]) => ({
    export: name, symbol: `contract_probe_${symbol}`, params: ["u32"], returns: "f64",
  })),
});

for (const variant of ["baseline", "annotations", "codecs"]) {
  const directory = join(work, variant);
  prepareVariant(root, directory, variant);
  buildLibrary({
    entry: join(directory, "bench/isolation/probes.ts"), work: directory,
    out: join(out, `${variant}.wasm`), compiler, runtimePack, benchmark: true,
    extraExports: Object.entries(symbols).map(([name, symbol]) => ({
      export: name, symbol: `contract_probe_${symbol}`, params: ["u32"], returns: "f64",
    })),
  });
}

// Retain real legacy contracts for a repeatable production before/after check.
for (const variant of ["baseline", "codecs"]) {
  const directory = join(work, variant);
  cpSync(join(root, "contracts"), join(directory, "contracts"), { recursive: true });
  for (const name of ["counter", "token"]) {
    const entry = join(directory, `${name}-entry.ts`);
    const compiled = compileContract({ filename: join(directory, "contracts", name, "index.ts"), sdkDirectory: join(directory, "sdk") });
    writeFileSync(entry, compiled?.lowered ?? `import contract from "./contracts/${name}/index.ts";
import { executeContract, contractMeta } from "./sdk/contract.ts";
export function execute(context: Uint8Array): Uint8Array { return executeContract(contract, context); }
export function meta(): Uint8Array { return contractMeta(contract); }
`);
    const destination = variant === "baseline" ? join(out, "legacy", `${name}.wasm`) : join(out, `${name}.wasm`);
    buildLibrary({ entry, work: join(directory, name), out: destination, compiler, runtimePack });
  }
}

// These checks distinguish unsupported features from annotations silently
// ignored by the compiler. Diagnostics are retained beside each toolchain.
const checks = [
  ["Int32 array", 'import type { Int32 } from "@scriptc/types";\nconst values: Int32[] = [1, 2];', "values.length", null],
  ["invalid Int32", 'import type { Int32 } from "@scriptc/types";\nconst bad: Int32 = 1.5;', "bad", "SC7002"],
  ["invalid NoThrow", 'import type { NoThrow } from "@scriptc/types";\nfunction bad(): NoThrow<number> { throw new Error("test"); }', "bad()", "SC7001"],
  ["ProgramLifetime in library", 'import type { ProgramLifetime } from "@scriptc/types";\nclass Item implements ProgramLifetime { value = 1; }', "new Item().value", "SC7008"],
  ["readonly linked Acyclic", 'import type { Acyclic } from "@scriptc/types";\nclass Link implements Acyclic { readonly next: Link | null; constructor(next: Link | null) { this.next = next; } }', "new Link(null).next === null ? 1 : 0", null],
];
const diagnostics = [];
for (const [name, declarations, expression, expectedCode] of checks) {
  const directory = join(work, "compatibility", name.replaceAll(/[^a-z0-9]/gi, "-"));
  mkdirSync(directory, { recursive: true });
  const entry = join(directory, "entry.ts");
  writeFileSync(entry, `${declarations}\nexport function probe(): number { return ${expression}; }\n`);
  const profile = join(directory, "profile.json");
  writeFileSync(profile, JSON.stringify({
    profile_format: 1, name: "check", entry: "entry.ts", emission: "llvm",
    abi: { prefix: "check_", init_symbol: "check_init", sink_register_symbol: "check_sink" },
    exports: [{ export: "probe", symbol: "check_probe", params: [], returns: "f64" }],
  }));
  const result = spawnSync(compiler, ["build", "--lib", "--profile", profile, "-o", join(directory, "check.wasm")], {
    cwd: root, env: { ...process.env, SCRIPTC_TARGET: "wasm32-wasi", SCRIPTC_RUNTIME_PACK: runtimePack }, encoding: "utf8",
  });
  if (result.error) throw result.error;
  const message = result.stdout + result.stderr;
  if (expectedCode && (result.status === 0 || !message.includes(expectedCode))) {
    throw new Error(`${name}: expected ${expectedCode}, got ${message}`);
  }
  if (!expectedCode && result.status !== 0 && !/SC700[267]/.test(message)) {
    throw new Error(`${name}: unexpected failure: ${message}`);
  }
  diagnostics.push({ name, accepted: result.status === 0, diagnostic: message.replaceAll(root + "/", "") });
}
// --ffi is not accepted by library mode, even with an empty valid manifest.
const ffi = join(work, "compatibility/ffi.json");
writeFileSync(ffi, JSON.stringify({ ffi_format: 1, functions: [] }));
const ffiResult = spawnSync(compiler, ["build", "--lib", "--profile", join(work, "contracts/profile.json"), "--ffi", ffi], { encoding: "utf8" });
const ffiMessage = ffiResult.stdout + ffiResult.stderr;
if (ffiResult.error) throw ffiResult.error;
if (ffiResult.status === 0 || !/ffi|library/i.test(ffiMessage)) throw new Error(`unexpected FFI result: ${ffiMessage}`);
diagnostics.push({ name: "native FFI in library", accepted: false, diagnostic: ffiMessage.replaceAll(root + "/", "") });
const typedArrays = diagnostics.find((d) => d.name === "Int32 array").accepted;
if (typedArrays) {
  const entry = join(work, "arrays/entry.ts");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, readFileSync(microEntry, "utf8").replace("let integers: number[]", "let integers: Int32[]"));
  buildLibrary({
    entry, work: dirname(entry), out: join(out, "arrays.wasm"), compiler, runtimePack, benchmark: true,
    extraExports: Object.entries(exports).map(([name, symbol]) => ({
      export: name, symbol: `contract_probe_${symbol}`, params: ["u32"], returns: "f64",
    })),
  });
}
writeFileSync(join(out, "COMPATIBILITY.json"), JSON.stringify(diagnostics, null, 2) + "\n");
writeFileSync(join(out, "COMPATIBILITY.md"), "| probe | result |\n|---|---|\n" + diagnostics.map((d) =>
  `| ${d.name} | ${d.accepted ? "accepted" : "rejected: " + (d.diagnostic.match(/SC\d+/)?.[0] ?? "CLI library restriction")} |`).join("\n") + "\n");
writeFileSync(join(out, "FEATURES.txt"), typedArrays ? "Int32[]\n" : "");
const metadata = [`scriptc and runtime pack: ${version}`, `@scriptc/types: ${JSON.parse(readFileSync(join(toolchain, "@scriptc/types/package.json"), "utf8")).version}`];
for (const name of ["contracts", "baseline", "annotations", "codecs", "counter", "token", "legacy/counter", "legacy/token", ...(typedArrays ? ["arrays"] : [])]) {
  const hash = createHash("sha256").update(readFileSync(join(out, `${name}.wasm`))).digest("hex");
  metadata.push(`${name}.wasm SHA-256: ${hash}`);
}
writeFileSync(join(out, "BUILD.txt"), metadata.join("\n") + "\n");
writeFileSync(join(root, "dist/optimization/CURRENT"), version + "\n");
console.log(`Compatibility checks saved to dist/optimization/${version}/COMPATIBILITY.json`);
