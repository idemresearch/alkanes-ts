#!/usr/bin/env node
// SCRIPTC_LINKER wrapper used by scripts/build.mjs to link shim/printf.c.
//
// For a wasm32-wasi library scriptc runs SCRIPTC_LINKER in place of `zig cc`:
//
//   <linker> -target wasm32-wasi -mexec-model=reactor -Wl,--strip-debug
//     -Wl,--export=... program.o <runtime objects> -l... -o out.wasm
//
// This runs `zig cc` with the same arguments, preceded by the object files
// listed in ALKANES_LINK_OBJECTS (separated by the platform path delimiter).
// Their definitions replace libc's (shim/printf.c replaces vsnprintf and
// snprintf). zig cc passes libc.a to wasm-ld before the user inputs, and
// wasm-ld extracts an archive member when a reference reaches the member's
// still-lazy symbol, so the replacements must be defined before scriptc's
// first object refers to them: hence they go first. If libc's member were
// extracted anyway, the link would fail with a duplicate symbol rather than
// silently keep libc's code.
//
// With ALKANES_LINK_REPORT=<file>, the output keeps its name section (the
// build strips custom sections afterwards) and scripts/printf-formats.mjs
// checks that every format reaching vsnprintf/snprintf is a constant that
// shim/printf.c implements. If that cannot be shown, the wrapper links again
// without the extra objects, keeping libc's printf. The report records which
// printf was linked and the formats found or the reason.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter } from "node:path";
import { printfFormatSites } from "./printf-formats.mjs";

function fail(message) {
  process.stderr.write(`scripts/link.mjs: ${message}\n`);
  process.exit(2);
}

const objects = (process.env.ALKANES_LINK_OBJECTS ?? "").split(delimiter).filter(Boolean);
if (objects.length === 0) fail("ALKANES_LINK_OBJECTS names no object files");
for (const object of objects) if (!existsSync(object)) fail(`missing object ${object}`);
const report = process.env.ALKANES_LINK_REPORT;

let args = process.argv.slice(2);
const output = args.lastIndexOf("-o");
if (output < 0 || output === args.length - 1) fail(`expected a link command ending in -o <file>, got: ${args.join(" ")}`);
const target = args.indexOf("-target");
if (target < 0 || !/^wasm32-wasi/.test(args[target + 1] ?? "")) {
  fail(`expected a wasm32-wasi link, got: ${args.join(" ")}`);
}
const outFile = args[output + 1];
if (report) args = args.filter((arg) => arg !== "-Wl,--strip-debug");

const zig = process.env.ALKANES_ZIG || "zig";
function link(inputs) {
  const result = spawnSync(zig, ["cc", ...inputs, ...args], { stdio: "inherit" });
  if (result.error) fail(`could not run ${zig}: ${result.error.message}`);
  if (result.signal) process.kill(process.pid, result.signal);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

link(objects);
if (report) {
  let result;
  try {
    result = { printf: "minimal", ...printfFormatSites(readFileSync(outFile)) };
  } catch (error) {
    link([]);
    result = { printf: "libc", reason: error.message };
  }
  writeFileSync(report, JSON.stringify(result, null, 2) + "\n");
}
