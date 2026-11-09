// Build stamps (scripts/build.mjs): a build is skipped only while everything
// that decides its output is unchanged, and named.wasm is the shipped module
// plus function names.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { buildLibrary } from "../scripts/build.mjs";
import { stripCustomSections } from "../scripts/printf-formats.mjs";
import { functionSizes } from "../scripts/size.mjs";

const work = resolve("build/cache-tests");
const entry = join(work, "entry.ts"), helper = join(work, "helper.ts"), out = join(work, "probe.wasm");
const source = (byte) => `export function payload(): Uint8Array { return new Uint8Array([${byte}]); }\n`;
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
writeFileSync(entry, `import { payload } from "./helper.ts";
export function execute(context: Uint8Array): Uint8Array { return payload(); }
export function meta(): Uint8Array { return payload(); }
`);
writeFileSync(helper, source(7));
const build = (options = {}) => buildLibrary({ entry, work, out, ...options });
const meta = () => {
  const { exports } = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(out)),
    { env: new Proxy({}, { get: () => () => { throw new Error("unexpected host call"); } }) });
  const pointer = exports.__meta(), memory = new Uint8Array(exports.memory.buffer);
  return [...memory.subarray(pointer, pointer + new DataView(exports.memory.buffer).getUint32(pointer - 4, true))];
};

test("an unchanged build is skipped; a changed import, option or output is rebuilt", () => {
  const first = build();
  assert.equal(first.cached, undefined);
  assert.deepEqual(meta(), [7]);
  const bytes = readFileSync(out);

  const second = build();
  assert.equal(second.cached, true);
  assert.deepEqual({ ...second, cached: undefined }, { ...first, cached: undefined });
  assert.ok(readFileSync(out).equals(bytes));

  // A file the entry imports.
  writeFileSync(helper, source(9));
  assert.equal(build().cached, undefined);
  assert.deepEqual(meta(), [9]);
  assert.equal(build().cached, true);

  // An option that changes the output.
  assert.equal(build({ snapshot: false }).cached, undefined);
  assert.equal(build({ snapshot: false }).cached, true);
  assert.equal(build().cached, undefined);

  // An output that is no longer the one the stamp describes.
  writeFileSync(out, Buffer.concat([readFileSync(out), Buffer.from([0])]));
  assert.equal(build().cached, undefined);
  assert.deepEqual(meta(), [9]);

  // cache: false always builds, and leaves a stamp for the next build.
  assert.equal(build().cached, true);
  assert.equal(build({ cache: false }).cached, undefined);
  assert.equal(build().cached, true);
});

test("named.wasm is the shipped module with function names", () => {
  build();
  const named = readFileSync(join(work, "named.wasm"));
  assert.ok(stripCustomSections(named).equals(readFileSync(out)));
  const sizes = functionSizes(named);
  assert.ok(sizes.named);
  assert.ok(sizes.functions.length > 0);
  assert.ok(sizes.functions.some((f) => f.name.startsWith("scr_")), "runtime functions keep their names");
  // Function bodies plus the function count make up the code section.
  const bodies = sizes.functions.reduce((sum, f) => sum + f.bytes, 0);
  assert.ok(sizes.code > bodies && sizes.code - bodies <= 5);
  assert.equal(functionSizes(readFileSync(out)).named, false);
});
