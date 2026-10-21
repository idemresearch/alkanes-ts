#!/usr/bin/env node
// Compare the unchanged Rust u128 implementation, then match the numeric path.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, arch } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let iterations = 200;
let output;
let grow = false;
const args = process.argv.slice(2);
while (args.length) {
  const arg = args.shift();
  if (arg === "--iterations") iterations = Number(args.shift());
  else if (arg === "--output") { output = args.shift(); if (!output) throw new Error("--output FILE"); }
  else if (arg === "--grow") grow = true;
  else throw new Error(`unknown argument ${arg}`);
}
if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error("iterations must be positive");
const build = execFileSync("cargo", ["build", "--quiet", "--release", "--manifest-path", "harness/Cargo.toml",
  "--bin", "bench", "--message-format=json"], { cwd: root, encoding: "utf8" });
const executable = build.trim().split("\n").map((line) => JSON.parse(line))
  .find((event) => event.reason === "compiler-artifact" && event.target.name === "bench" && event.executable)?.executable;
if (!executable) throw new Error("cargo did not report the bench executable");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies.scriptc;
let report = `# Rust speed comparison\n\nMachine: ${cpus()[0].model}, ${platform()} ${arch()}. scriptc/runtime ${version}; wasmi 0.37.2.\n\n`;
report += "Instruction fuel and median export execution time are separate metrics. Instantiation is shown separately. Every repetition checks fuel, full response (including transfers), and resulting storage. Cross-language checks allow ABI formatting/schema text differences and the documented unknown-opcode message difference. Production host surcharges and alkane balance enforcement are not modeled.\n\n";
report += "```text\n" + readFileSync(join(root, "bench/dist/BUILD.txt"), "utf8");
for (const name of ["counter", "token"]) {
  const bytes = readFileSync(join(root, "dist", `${name}.wasm`));
  report += `${name}.wasm SHA-256: ${createHash("sha256").update(bytes).digest("hex")}\n`;
}
report += "```\n\n";
for (const matched of [false, true]) {
  report += matched
    ? "# Rust given the same numeric fast path\n\nBoth use exact numeric squares and accumulation for n ≤ 300,000, convert once at the boundary, and retain the u128/bigint loop above that bound. Only arithmetic scenarios are repeated here.\n\n"
    : "# Original Rust u128 loop versus optimized TypeScript\n\nThe TS sum uses exact numeric arithmetic up to n=300,000; Rust here retains its original checked u128 loop. This compares the contract implementations, not equally optimized numeric representations.\n\n";
  report += execFileSync(executable, ["--root", root, "--iterations", String(iterations),
    ...(grow ? [] : ["--no-grow"]),
    ...(matched ? ["--rust-dir", join(root, "bench/dist/numeric-fast-path"), "--filter", "sum("] : [])],
  { cwd: root, encoding: "utf8" });
}
report += "\nReproduce: set `ALKANES_RS` to the recorded alkanes-rs revision, run `npm run build:bench:rust`, `npm run build`, then `npm run bench:speed -- --output bench/SPEED_RESULTS.md`. Use `--grow` for the host's 512-page setup. Timings are local measurements, not production indexer latency.\n";
if (output) writeFileSync(resolve(root, output), report);
process.stdout.write(report);
