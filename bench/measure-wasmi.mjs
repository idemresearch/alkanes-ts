#!/usr/bin/env node
// Instruction-fuel and size comparison of contract builds on the in-repo
// wasmi 0.37.2 host model (harness/), without an alkanes-rs checkout.
//
//   node bench/measure-wasmi.mjs [--output FILE] label=dir [label=dir ...]
//
// Each dir holds <contract>.wasm files. Every scenario runs its calls in order
// on a fresh World (storage and balances persist between calls); the fuel of
// each call is reported. Responses must be identical across variants, so a
// fuel difference never hides a behavior difference. Fuel excludes canonical
// host/storage surcharges; see the actual-runtime reports for those.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const check = join(root, "harness/target/release/wasmi-check");
if (!existsSync(check)) throw new Error("build the harness first: cargo build --release --manifest-path harness/Cargo.toml");

// [contract, scenario name, calls]; calls use wasmi-check syntax.
const AMM = ["0,2,11,2,12", "1,0@2:11=1000000+2:12=4000000"];
// The advanced contracts call other contracts, which are the same binaries for
// every variant: test/fixtures/test-auth.ts (mode 0, approve) as the authority
// at 4:9001, and dist/amm-pool.wasm for the router's pools. The harness height
// is 900,000.
const authWasm = join(root, "build/measure-wasmi/test-auth.wasm");
const AUTH = ["--deploy", `4:9001=${authWasm}`, "--target", "4:9001", "0,0", "--target", "2:1"];
const VAULT = [...AUTH, "0,2,5,4,9001,100", "1,0@2:5=1000000"];
const TREASURY = [...AUTH, "0,4,9001,0,100@4:9001=1", "1,2,5@2:5=1000"];
const POOLS = ["--deploy", `2:10=${join(root, "dist/amm-pool.wasm")}`, "--deploy", `2:20=${join(root, "dist/amm-pool.wasm")}`,
  "--target", "2:10", "0,2,11,2,12", "1,0@2:11=1000000+2:12=4000000",
  "--target", "2:20", "0,2,13,2,12", "1,0@2:13=3000000+2:12=2000000", "--target", "2:1"];
export const SCENARIOS = [
  ["counter", "initialize", ["0"]],
  ["counter", "increment", ["0", "1,5"]],
  ["counter", "get_count", ["0", "1,5", "2"]],
  ["counter", "revert (write, then throw)", ["0", "3"]],
  ["counter", "height + log", ["4"]],
  ["counter", "sum(n=100)", ["5,100"]],
  ["counter", "fill(n=10)", ["6,10"]],
  ["counter", "__meta", ["--meta"]],
  ["token", "initialize", ["0,1000"]],
  ["token", "mint (owner)", ["0,1000", "77,5"]],
  ["token", "name", ["99"]],
  ["token", "total supply", ["0,1000", "101"]],
  ["token", "__meta", ["--meta"]],
  ["capped-token", "initialize", ["0,4,9001,1000"]],
  ["capped-token", "supply view", ["0,4,9001,1000", "101"]],
  ["capped-token", "authority view", ["0,4,9001,1000", "102"]],
  ["capped-token", "cap view", ["0,4,9001,1000", "103"]],
  ["capped-token", "mint (auth)", [...AUTH, "0,4,9001,1000", "77,5@4:9001=1"]],
  ["capped-token", "__meta", ["--meta"]],
  ["amm-pool", "initialize", AMM.slice(0, 1)],
  ["amm-pool", "first addLiquidity", AMM],
  ["amm-pool", "addLiquidity with refund", [...AMM, "1,0@2:11=500+2:12=3000+2:13=7"]],
  ["amm-pool", "swap 0->1", [...AMM, "3,0@2:11=10000"]],
  ["amm-pool", "swap 1->0", [...AMM, "3,0@2:12=50000"]],
  ["amm-pool", "removeLiquidity", [...AMM, "2,0,0@2:1=999000"]],
  ["amm-pool", "reserve view", [...AMM, "20"]],
  ["amm-pool", "quote view", [...AMM, "10,10000"]],
  ["amm-pool", "__meta", ["--meta"]],
  ["share-vault", "initialize", [...AUTH, VAULT[AUTH.length]]],
  ["share-vault", "first deposit", VAULT],
  ["share-vault", "second deposit", [...VAULT, "1,0@2:5=500000"]],
  ["share-vault", "redeem", [...VAULT, "2,0@2:1=400000000"]],
  ["share-vault", "harvest (auth + yield)", [...VAULT, "3@4:9001=1+2:5=5000"]],
  ["share-vault", "deposit while vesting", [...VAULT, "3@4:9001=1+2:5=5000", "1,0@2:5=1000"]],
  ["share-vault", "previewDeposit view", [...VAULT, "12,1000"]],
  ["share-vault", "lockedProfit view", [...VAULT, "3@4:9001=1+2:5=5000", "17"]],
  ["share-vault", "__meta", ["--meta"]],
  ["timelock-treasury", "initialize", [...AUTH, TREASURY[AUTH.length]]],
  ["timelock-treasury", "deposit", TREASURY],
  ["timelock-treasury", "schedule (auth)", [...TREASURY, "2,2,5,400@4:9001=1"]],
  ["timelock-treasury", "execute (auth + payout)", [...TREASURY, "2,2,5,400@4:9001=1", "3@4:9001=1"]],
  ["timelock-treasury", "cancel (auth)", [...TREASURY, "2,2,5,400@4:9001=1", "4@4:9001=1"]],
  ["timelock-treasury", "pending asset view", [...TREASURY, "2,2,5,400@4:9001=1", "10"]],
  ["timelock-treasury", "held view", [...TREASURY, "13,2,5"]],
  ["timelock-treasury", "__meta", ["--meta"]],
  ["amm-router", "version view", ["0"]],
  ["amm-router", "swap1 (one pool)", [...POOLS, "2,2,11,2,10,2,12,0,1000000000@2:11=10000"]],
  ["amm-router", "swap2 (two pools)", [...POOLS, "1,2,11,2,10,2,12,2,20,2,13,0,1000000000@2:11=10000"]],
  ["amm-router", "swap1 slippage revert", [...POOLS, "2,2,11,2,10,2,12,1000000000,1000000000@2:11=10000"]],
  ["amm-router", "__meta", ["--meta"]],
];

// Builds the authority fixture the vault and treasury scenarios deploy.
async function ensureFixtures() {
  if (existsSync(authWasm)) return;
  const { buildLibrary } = await import("../scripts/build.mjs");
  const work = dirname(authWasm), source = join(root, "test/fixtures/test-auth.ts"), entry = join(work, "entry.ts");
  mkdirSync(work, { recursive: true });
  writeFileSync(entry, `import contract from ${JSON.stringify(source)};
import {executeContract,contractMeta} from ${JSON.stringify(join(root, "sdk/contract.ts"))};
export function execute(context:Uint8Array):Uint8Array{return executeContract(contract,context);}
export function meta():Uint8Array{return contractMeta(contract);}`);
  buildLibrary({ entry, work, out: authWasm });
}

function codeBytes(bytes) {
  let p = 8, code = 0;
  const leb = () => { let r = 0, s = 0, b; do { b = bytes[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return r >>> 0; };
  while (p < bytes.length) { const id = bytes[p++], size = leb(); if (id === 10) code = size; p += size; }
  return code;
}

function run(wasm, calls) {
  // One result line per call or --meta; --deploy/--target and their values are setup.
  const count = calls.filter((c, i) => c !== "--deploy" && c !== "--target" && !["--deploy", "--target"].includes(calls[i - 1])).length;
  const out = execFileSync(check, [wasm, ...calls], { encoding: "utf8" }).trim().split("\n").filter((l) => /fuel=\d+/.test(l));
  if (out.length !== count) throw new Error(`${wasm}: expected ${count} results`);
  const last = out.at(-1);
  const fuel = Number(/fuel=(\d+)/.exec(last)[1]);
  // Strip fuel so the remaining text is the observable result.
  return { fuel, result: out.map((l) => l.replace(/fuel=\d+\s*/, "")).join("\n") };
}

export function measure(variants) {
  const contracts = [...new Set(SCENARIOS.map(([c]) => c))];
  const rows = [], sizes = [];
  for (const contract of contracts) {
    const present = variants.filter((v) => existsSync(join(v.dir, contract + ".wasm")));
    if (!present.length) continue;
    for (const v of present) {
      const bytes = readFileSync(join(v.dir, contract + ".wasm"));
      sizes.push({ contract, label: v.label, bytes: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length, code: codeBytes(bytes),
        sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    for (const [c, name, calls] of SCENARIOS) {
      if (c !== contract) continue;
      const results = present.map((v) => run(join(v.dir, contract + ".wasm"), calls));
      const reference = results[0].result;
      results.forEach((r, i) => { if (r.result !== reference) throw new Error(`${contract} ${name}: ${present[i].label} differs from ${present[0].label}:\n${r.result}\n---\n${reference}`); });
      rows.push({ contract, name, labels: present.map((v) => v.label), fuel: results.map((r) => r.fuel) });
    }
  }
  return { rows, sizes };
}

export function report({ rows, sizes }, variants) {
  const labels = variants.map((v) => v.label);
  const pct = (a, b) => (b === a ? "0%" : `${b > a ? "+" : ""}${(((b - a) / a) * 100).toFixed(1)}%`);
  let md = `| contract | scenario | ${labels.join(" | ")} | ${labels.slice(1).map((l) => `${l} vs ${labels[0]}`).join(" | ")} |\n`;
  md += `|---|---|${labels.map(() => "---:").join("|")}|${labels.slice(1).map(() => "---:").join("|")}|\n`;
  for (const r of rows) {
    const cell = (l) => { const i = r.labels.indexOf(l); return i < 0 ? "—" : String(r.fuel[i]); };
    const base = r.labels.indexOf(labels[0]);
    md += `| ${r.contract} | ${r.name} | ${labels.map(cell).join(" | ")} | ${labels.slice(1).map((l) => { const i = r.labels.indexOf(l); return i < 0 || base < 0 ? "—" : pct(r.fuel[base], r.fuel[i]); }).join(" | ")} |\n`;
  }
  md += `\n| contract | variant | bytes | gzip | code section | SHA-256 |\n|---|---|---:|---:|---:|---|\n`;
  for (const s of sizes) md += `| ${s.contract} | ${s.label} | ${s.bytes} | ${s.gzip} | ${s.code} | \`${s.sha256}\` |\n`;
  return md;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  let output;
  const variants = [];
  while (args.length) {
    const a = args.shift();
    if (a === "--output") output = args.shift();
    else { const [label, dir] = a.split("="); variants.push({ label, dir: resolve(dir) }); }
  }
  if (!variants.length) throw new Error("usage: measure-wasmi.mjs [--output FILE] label=dir ...");
  await ensureFixtures();
  const md = report(measure(variants), variants);
  if (output) writeFileSync(output, md); else process.stdout.write(md);
}
