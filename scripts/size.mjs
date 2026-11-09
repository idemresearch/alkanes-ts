#!/usr/bin/env node
// Code size by function, from the named module every build leaves at
// build/<contract>/named.wasm (the shipped module plus its function names).
//
//   node scripts/size.mjs counter                 largest functions
//   node scripts/size.mjs counter --top 50
//   node scripts/size.mjs counter capped-token    what differs between two modules
//   node scripts/size.mjs old/named.wasm counter  ... or between two builds
//
// An argument is a contract name or a path to a .wasm file with a name
// section. Sizes are code-section bytes: each function body with its length
// prefix. The comparison matches functions by name, so it shows which
// functions a compiler upgrade or a source change added, removed or grew.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// { functions: [{ name, bytes }], code, data, total } for a Wasm binary.
export function functionSizes(bytes) {
  let i = 8;
  const leb = () => {
    let result = 0, shift = 0, byte;
    do {
      byte = bytes[i++];
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  };
  const string = () => {
    const length = leb();
    const text = Buffer.from(bytes.subarray(i, i + length)).toString("utf8");
    i += length;
    return text;
  };
  let imported = 0, code = 0, data = 0;
  const bodies = [];
  const names = new Map();
  while (i < bytes.length) {
    const id = bytes[i++];
    const size = leb();
    const end = i + size;
    if (id === 2) {
      for (let count = leb(); count > 0; count--) {
        string();
        string();
        const kind = bytes[i++];
        if (kind === 0) {
          leb();
          imported++;
        } else if (kind === 1) {
          i++; // reference type
          const flags = leb();
          leb();
          if (flags & 1) leb();
        } else if (kind === 2) {
          const flags = leb();
          leb();
          if (flags & 1) leb();
        } else if (kind === 3) {
          i += 2;
        } else throw new Error(`unsupported import kind ${kind}`);
      }
    } else if (id === 10) {
      code = size;
      for (let count = leb(); count > 0; count--) {
        const start = i;
        const body = leb();
        i += body;
        bodies.push(i - start);
      }
    } else if (id === 11) {
      data = size;
    } else if (id === 0 && string() === "name") {
      while (i < end) {
        const kind = bytes[i++];
        const subEnd = leb() + i;
        if (kind === 1) for (let count = leb(); count > 0; count--) {
          const index = leb();
          names.set(index, string());
        }
        i = subEnd;
      }
    }
    i = end;
  }
  const functions = bodies.map((size, index) => ({ name: names.get(imported + index) ?? `#${imported + index}`, bytes: size }));
  return { functions, code, data, total: bytes.length, named: names.size > 0 };
}

function load(argument) {
  const path = argument.endsWith(".wasm") ? resolve(argument) : join(root, "build", argument, "named.wasm");
  if (!existsSync(path)) {
    throw new Error(argument.endsWith(".wasm") ? `no file ${argument}` : `no ${relative(root, path)}; run: npm run build -- ${argument}`);
  }
  const sizes = functionSizes(readFileSync(path));
  if (!sizes.named) throw new Error(`${relative(process.cwd(), path)} has no function names; use build/<contract>/named.wasm`);
  return { label: relative(process.cwd(), path), ...sizes };
}

const pad = (value, width) => String(value).padStart(width);
const signed = (value) => (value > 0 ? `+${value}` : String(value));

function report(module, top) {
  const sorted = [...module.functions].sort((a, b) => b.bytes - a.bytes);
  console.log(`${module.label}: ${module.total} bytes; code ${module.code} in ${module.functions.length} functions, data ${module.data}`);
  let shown = 0;
  for (const f of sorted.slice(0, top)) {
    shown += f.bytes;
    console.log(`${pad(f.bytes, 8)}  ${(100 * f.bytes / module.code).toFixed(1).padStart(5)}%  ${f.name}`);
  }
  if (sorted.length > top) console.log(`${pad(module.code - shown, 8)}          ${sorted.length - top} smaller functions (--top ${sorted.length} lists them)`);
}

function compare(before, after, top) {
  // A name can repeat (static functions from different objects); sum them.
  const total = (module) => {
    const sizes = new Map();
    for (const f of module.functions) sizes.set(f.name, (sizes.get(f.name) ?? 0) + f.bytes);
    return sizes;
  };
  const a = total(before), b = total(after);
  const rows = [];
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    const delta = (b.get(name) ?? 0) - (a.get(name) ?? 0);
    if (delta !== 0) rows.push({ name, delta, state: !a.has(name) ? "added" : !b.has(name) ? "removed" : "" });
  }
  rows.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  console.log(`${before.label} -> ${after.label}`);
  console.log(`  total ${before.total} -> ${after.total} (${signed(after.total - before.total)}), code ${before.code} -> ${after.code} (${signed(after.code - before.code)}), ` +
    `data ${before.data} -> ${after.data} (${signed(after.data - before.data)}), functions ${before.functions.length} -> ${after.functions.length}`);
  for (const row of rows.slice(0, top)) console.log(`${pad(signed(row.delta), 8)}  ${row.name}${row.state ? `  (${row.state})` : ""}`);
  if (rows.length > top) {
    const rest = rows.slice(top).reduce((sum, row) => sum + row.delta, 0);
    console.log(`${pad(signed(rest), 8)}  ${rows.length - top} smaller changes (--top ${rows.length} lists them)`);
  }
  if (rows.length === 0) console.log("  no function changed size");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    let top = 25;
    const at = args.indexOf("--top");
    if (at >= 0) {
      top = Number(args[at + 1]);
      if (!Number.isInteger(top) || top < 1) throw new Error("--top needs a positive number");
      args.splice(at, 2);
    }
    if (args.length < 1 || args.length > 2 || args.some((arg) => arg.startsWith("-"))) {
      throw new Error("usage: node scripts/size.mjs <contract|file.wasm> [<contract|file.wasm>] [--top N]");
    }
    const modules = args.map(load);
    if (modules.length === 1) report(modules[0], top);
    else compare(modules[0], modules[1], top);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
