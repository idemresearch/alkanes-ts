#!/usr/bin/env node
// Compare production contracts against the preserved SDK or supplied Wasm binaries.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let iterations = 20;
let output;
let baselineDirectory;
const args = process.argv.slice(2);
while (args.length) {
  const arg = args.shift();
  if (arg === "--iterations") iterations = Number(args.shift());
  else if (arg === "--output") { output = args.shift(); if (!output) throw new Error("--output FILE"); }
  else if (arg === "--baseline") { baselineDirectory = args.shift(); if (!baselineDirectory) throw new Error("--baseline DIRECTORY"); }
  else throw new Error(`unknown argument ${arg}`);
}
assert(Number.isSafeInteger(iterations) && iterations > 0, "iterations must be positive");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies.scriptc;
const baselineLabel = baselineDirectory ? "previous checkpoint" : "legacy codecs";
const baselineRoot = baselineDirectory ? resolve(root, baselineDirectory) : join(root, "dist/optimization", version, "legacy");
const build = execFileSync("cargo", ["build", "--quiet", "--release", "--manifest-path", "harness/Cargo.toml",
  "--bin", "wasmi-check", "--message-format=json"], { cwd: root, encoding: "utf8" });
const executable = build.trim().split("\n").map((line) => JSON.parse(line))
  .find((event) => event.reason === "compiler-artifact" && event.target.name === "wasmi-check" && event.executable)?.executable;
assert(executable, "cargo did not report the wasmi-check executable");
const workloads = {
  counter: ["--meta", "0", "1,5", "2", "3", "5,10000", "6,1000"],
  token: ["--meta", "0,1000", "77,50", "99", "100", "101"],
};

function measure(path, inputs) {
  let reference;
  for (let i = 0; i < iterations; i++) {
    const text = execFileSync(executable, [path, ...inputs], { cwd: root, encoding: "utf8" });
    const rows = text.split("\n").flatMap((line) => {
      const match = /^(\S+)\s+fuel=(\d+)\s+(.+)$/.exec(line);
      if (!match) return [];
      const [, call, fuel, result] = match;
      if (call === "[3]") assert.equal(result, 'REVERT "Error: intentional failure"');
      else if (call === "__meta") assert.doesNotThrow(() => JSON.parse(result));
      else assert(result.startsWith("ok "), `${path} ${call}: ${result}`);
      return [{ call, fuel: Number(fuel), result }];
    });
    assert.equal(rows.length, inputs.length, `missing results for ${path}`);
    if (reference) assert.deepEqual(rows, reference, `nondeterministic fuel/results in ${path}`);
    else reference = rows;
  }
  return reference;
}

let report = `# Production SDK codec optimization\n\nscriptc/runtime ${version}; wasmi 0.37.2 with the host's 512-page memory setup. Each contract call sequence is repeated ${iterations} times from a fresh world. All response data, ABI text, expected revert messages and fuel counts are checked. Fuel excludes production host surcharges; no wall-clock claims.\n\n`;
for (const [contract, inputs] of Object.entries(workloads)) {
  const before = join(baselineRoot, `${contract}.wasm`);
  const after = join(root, "dist", `${contract}.wasm`);
  const baseline = measure(before, inputs);
  const production = measure(after, inputs);
  assert.deepEqual(production.map(({ call, result }) => ({ call, result })), baseline.map(({ call, result }) => ({ call, result })), `${contract}: codec results changed`);
  report += `## ${contract}\n\n| call | ${baselineLabel} fuel | production fuel | reduction |\n|---|---:|---:|---:|\n`;
  for (let i = 0; i < baseline.length; i++) {
    const old = baseline[i];
    const current = production[i];
    report += `| ${old.call} | ${old.fuel} | ${current.fuel} | ${((1 - current.fuel / old.fuel) * 100).toFixed(1)}% |\n`;
  }
  for (const [label, path] of [[baselineDirectory ? "reference" : "legacy", before], ["production", after]]) {
    const bytes = readFileSync(path);
    report += `\n${label}: ${bytes.length} bytes, SHA-256 \`${createHash("sha256").update(bytes).digest("hex")}\`.\n`;
  }
  report += "\n";
}
report += "Counter calls: initialize (0), increment by 5 (1,5), read (2), expected write-then-revert (3), sum of squares (5,10000), fill 1,000 storage entries (6,1000). Token calls: initialize supply 1,000 (0,1000), mint 50 (77,50), name (99), symbol (100), supply (101).\n\n";
report += baselineDirectory
  ? "Reference binaries were supplied with `--baseline`; their hashes are recorded above. Use `npm run bench:sdk -- --baseline <directory-with-reference-wasm> --output bench/NEXT_OPTIMIZATION_RESULTS.md`.\n"
  : "Reproduce: `npm run build`, `npm run build:bench:optimize`, then `npm run bench:sdk -- --output bench/SDK_OPTIMIZATION_RESULTS.md`. The legacy fixture preserves the prior algorithms; it is not used by production contracts.\n";
if (output) writeFileSync(resolve(root, output), report);
process.stdout.write(report);
