#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLibrary } from "../scripts/build.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
import { symbols } from "./isolation/exports.mjs";
for (const name of ["minimal", "probes"]) {
  buildLibrary({
    entry: join(root, "bench/isolation", `${name}.ts`),
    work: join(root, "build/isolation", name),
    out: join(root, "dist/isolation", `${name}.wasm`),
    benchmark: true,
    extraExports: Object.entries(symbols).filter(([key]) => name !== "minimal" || key === "noop")
      .map(([key, symbol]) => ({ export: key, symbol: `contract_probe_${symbol}`, params: ["u32"], returns: "f64" })),
  });
}
mkdirSync(join(root, "dist/isolation"), { recursive: true });
execFileSync("rustc", [
  "--edition=2021", "--crate-type=cdylib", "--target=wasm32-unknown-unknown",
  "-C", "opt-level=z", "-C", "lto=fat", "-C", "panic=abort", "-C", "strip=symbols",
  join(root, "bench/isolation/native.rs"), "-o", join(root, "dist/isolation/native.wasm"),
], { cwd: root, stdio: "inherit" });
console.log("dist/isolation/native.wasm (standalone rustc, no alkanes-rs checkout required)");
const version = (command, args) => execFileSync(command, args, { encoding: "utf8" }).trim();
const versions = [
  `scriptc: ${version(join(root, "node_modules/.bin/scriptc"), ["--version"])}`,
  `native baseline: ${version("rustc", ["--version"])}`,
  `Zig: ${version("zig", ["version"])}`,
  `Binaryen: ${version(join(root, "node_modules/.bin/wasm-opt"), ["--version"])}`,
];
for (const name of ["minimal", "probes", "native"]) {
  const hash = createHash("sha256").update(readFileSync(join(root, "dist/isolation", `${name}.wasm`))).digest("hex");
  versions.push(`${name}.wasm SHA-256: ${hash}`);
}
writeFileSync(join(root, "dist/isolation/BUILD.txt"), versions.join("\n") + "\n");
