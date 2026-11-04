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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const check = join(root, "harness/target/release/wasmi-check");
if (!existsSync(check)) throw new Error("build the harness first: cargo build --release --manifest-path harness/Cargo.toml");

// [contract, scenario name, calls]; calls use wasmi-check syntax.
const AMM = ["0,2,11,2,12", "1,0@2:11=1000000+2:12=4000000"];
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
];

function codeBytes(bytes) {
  let p = 8, code = 0;
  const leb = () => { let r = 0, s = 0, b; do { b = bytes[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return r >>> 0; };
  while (p < bytes.length) { const id = bytes[p++], size = leb(); if (id === 10) code = size; p += size; }
  return code;
}

function run(wasm, calls) {
  const out = execFileSync(check, [wasm, ...calls], { encoding: "utf8" }).trim().split("\n").slice(1);
  if (out.length !== calls.length) throw new Error(`${wasm}: expected ${calls.length} results`);
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
  const md = report(measure(variants), variants);
  if (output) writeFileSync(output, md); else process.stdout.write(md);
}
