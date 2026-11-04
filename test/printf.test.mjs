// Differential tests for shim/printf.c against wasi-libc (musl) in Wasm, and
// for the build-time format check in scripts/printf-formats.mjs.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { minimalPrintfObject } from "../scripts/build.mjs";
import { MUSL_PRINTF_INTERNALS, linkedMuslPrintf, printfConversions, printfFormatSites } from "../scripts/printf-formats.mjs";

const root = resolve(import.meta.dirname, "..");
const work = join(root, "build", "printf-test");
mkdirSync(work, { recursive: true });
const zig = (args) => execFileSync("zig", ["cc", "--target=wasm32-wasi", ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });

// The same driver object linked against libc's printf and against the
// production printf object, placed first as scripts/link.mjs places it.
// -fno-builtin keeps clang from rewriting the snprintf calls.
const driver = join(work, "driver.o");
zig(["-O2", "-fno-builtin", "-Wno-format", "-c", join(root, "test/fixtures/printf-driver.c"), "-o", driver]);
const libcWasm = join(work, "libc.wasm");
const minimalWasm = join(work, "minimal.wasm");
zig(["-mexec-model=reactor", driver, "-o", libcWasm]);
zig(["-mexec-model=reactor", minimalPrintfObject(), driver, "-o", minimalWasm]);

function instantiate(bytes) {
  const module = new WebAssembly.Module(bytes);
  const imports = {};
  for (const { module: name, name: field } of WebAssembly.Module.imports(module)) {
    imports[name] ??= {};
    imports[name][field] = () => { throw new Error(`unexpected import ${name}.${field}`); };
  }
  const instance = new WebAssembly.Instance(module, imports);
  instance.exports._initialize?.();
  return instance;
}

const SCRATCH_BASE = 0x4000000, SCRATCH_SIZE = 65536;

class Runner {
  constructor(file) {
    this.bytes = readFileSync(file);
    this.reset();
  }
  // Both modules use the same absolute scratch address, so a directive that
  // reads a pointer argument as an integer prints the same value in each.
  reset() {
    this.instance = instantiate(this.bytes);
    const memory = this.instance.exports.memory;
    const need = Math.ceil((SCRATCH_BASE + SCRATCH_SIZE) / 65536);
    if (memory.buffer.byteLength / 65536 < need) memory.grow(need - memory.buffer.byteLength / 65536);
    this.base = SCRATCH_BASE;
  }
  get memory() {
    return new Uint8Array(this.instance.exports.memory.buffer);
  }
}

// Scratch layout at a fixed address above both modules' static data and stack.
const DST = 0, DST_SIZE = 1024, FMT = 2048, ARGS = 8192, STRINGS = 12288, N_TARGET = 16384, GUARD = 0xa5;
const NULL_PTR = { ptr: 0 };

function writeCase(runner, { format, args }) {
  const memory = runner.memory;
  const base = runner.base;
  memory.fill(GUARD, base + DST, base + DST + DST_SIZE);
  memory.fill(0, base + FMT, base + N_TARGET + 64);
  const fmt = Buffer.from(format, "latin1");
  memory.set(fmt, base + FMT);
  let at = 0, strings = 0;
  const view = new DataView(memory.buffer);
  const align = (n) => { at = (at + n - 1) & -n; };
  for (const arg of args) {
    if (arg.i32 !== undefined) {
      align(4);
      view.setUint32(base + ARGS + at, arg.i32 >>> 0, true);
      at += 4;
    } else if (arg.i64 !== undefined) {
      align(8);
      view.setBigUint64(base + ARGS + at, BigInt.asUintN(64, arg.i64), true);
      at += 8;
    } else if (arg.f64 !== undefined) {
      align(8);
      view.setFloat64(base + ARGS + at, arg.f64, true);
      at += 8;
    } else if (arg.f128 !== undefined) {
      align(16);
      at += 16; // zero is a valid long double
    } else if (arg.str !== undefined) {
      const bytes = Buffer.from(arg.str + "\0", "latin1");
      memory.set(bytes, base + STRINGS + strings);
      align(4);
      view.setUint32(base + ARGS + at, base + STRINGS + strings, true);
      strings += bytes.length;
      at += 4;
    } else if (arg.ptr !== undefined) {
      align(4);
      view.setUint32(base + ARGS + at, arg.ptr >>> 0, true);
      at += 4;
    } else if (arg.nTarget) {
      align(4);
      view.setUint32(base + ARGS + at, base + N_TARGET, true);
      at += 4;
    } else throw new Error(`bad argument ${JSON.stringify(arg)}`);
  }
  if (at > STRINGS - ARGS || strings > N_TARGET - STRINGS) throw new Error("case too large");
}

function runCase(runner, testCase) {
  writeCase(runner, testCase);
  const { exports } = runner.instance;
  const base = runner.base;
  exports.set_errno(0x5a5a);
  const dst = testCase.nullDst ? 0 : base + DST;
  let ret;
  try {
    ret = testCase.call === undefined
      ? exports.format(dst, testCase.n, base + FMT, base + ARGS)
      : exports.call(testCase.call, dst, testCase.n, base + STRINGS);
  } catch (error) {
    if (!(error instanceof WebAssembly.RuntimeError)) throw error;
    runner.reset(); // the trap left the C stack pointer behind
    return { trap: error.message };
  }
  return {
    ret,
    errno: exports.get_errno(),
    dst: Buffer.from(runner.memory.subarray(base + DST, base + DST + DST_SIZE)).toString("hex"),
    nTarget: Buffer.from(runner.memory.subarray(base + N_TARGET, base + N_TARGET + 8)).toString("hex"),
  };
}

const libc = new Runner(libcWasm);
const minimal = new Runner(minimalWasm);

// --- corpus ------------------------------------------------------------------

// Deterministic xorshift32.
let seed = 0x9e3779b9;
const rand = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed;
};
const pick = (list) => list[rand() % list.length];

const INT32 = [0, 1, -1, 7, -7, 42, -42, 99, 100, 127, 128, -128, -129, 255, 256, 4095, 32767, 32768, -32768, -32769,
  65535, 65536, 1000000, 2147483647, -2147483648, 0xdeadbeef | 0, 0x80000001 | 0];
const INT64 = [0n, 1n, -1n, 42n, -42n, 255n, 4294967295n, 4294967296n, -4294967296n, 1000000000000n,
  9223372036854775807n, -9223372036854775808n, 18446744073709551615n, 0x8000000000000001n, 12345678901234567890n];
const STRINGS_SAMPLE = ["", "a", "hello", "with %d percent", "x".repeat(300), "\x80\xff\xfe high bytes", "0", "-1",
  "4294967296", "1.5e+300", "Infinity", "NaN", "contract_execute"];
const POINTERS = [0, 1, 0x10, 0x1234, 0xabcdef, 0x7fffffff, 0x80000000, 0xdeadbeef, 0xffffffff];
const SIZES = [0, 1, 2, 3, 5, 8, 16, 33, 80, 512, 1000];

const random32 = () => (rand() & 1 ? pick(INT32) : rand() | 0);
const random64 = () => (rand() & 1 ? pick(INT64) : (BigInt(rand()) << 32n) | BigInt(rand()));

function argumentFor(conversion, length) {
  if ("diouxX".includes(conversion)) return length === "ll" || length === "j" ? { i64: random64() } : { i32: random32() };
  if (conversion === "c") return { i32: random32() };
  if (conversion === "s") return rand() % 16 === 0 ? NULL_PTR : { str: pick(STRINGS_SAMPLE) };
  if (conversion === "p") return { ptr: pick(POINTERS) };
  return null;
}

// One directive and its arguments. Invalid combinations are kept: musl
// rejects them with EINVAL and so must shim/printf.c.
function directive({ conversions = "diouxXcsp", lengths = ["", "", "", "hh", "h", "l", "ll", "z", "t", "j", "L"] } = {}) {
  const args = [];
  let text = "%";
  for (const flag of "-0+ #'") if (rand() % 5 === 0) text += flag;
  switch (rand() % 6) {
    case 0: text += "*"; args.push({ i32: pick([-30, -8, -1, 0, 1, 3, 9, 25, rand() % 64 - 32]) }); break;
    case 1: case 2: text += String(rand() % 30); break;
  }
  switch (rand() % 6) {
    case 0: text += ".*"; args.push({ i32: pick([-5, -1, 0, 1, 2, 3, 7, 12, 40, rand() % 64 - 32]) }); break;
    case 1: text += "."; break;
    case 2: case 3: text += "." + String(rand() % 25); break;
  }
  let length = pick(lengths);
  const conversion = pick([...conversions]);
  if (length === "l" && (conversion === "c" || conversion === "s")) length = ""; // wide: trap tests below
  text += length + conversion;
  const arg = argumentFor(conversion, length);
  if (arg) args.push(arg);
  return { text, args };
}

function literal() {
  const pieces = ["", "abc", " ", "%%", "x%%y", "Hello, world", "\x7f\x80\xff", "\n", "=", "length "];
  let text = "";
  for (let k = rand() % 3; k > 0; k--) text += pick(pieces);
  return text;
}

const corpus = [];
// Every single-directive shape.
for (const conversion of "diouxXcsp") {
  for (const length of ["", "hh", "h", "l", "ll", "z", "t", "j", "L"]) {
    if (length === "l" && (conversion === "c" || conversion === "s")) continue;
    for (const flags of ["", "-", "0", "+", " ", "#", "'", "-0", "+ ", "#0", "-#", "0+", "-+ #0'"]) {
      for (const width of ["", "1", "6", "25", "*"]) {
        for (const precision of ["", ".", ".0", ".1", ".4", ".12", ".*"]) {
          const args = [];
          if (width === "*") args.push({ i32: pick([-12, -1, 0, 4, 17]) });
          if (precision === ".*") args.push({ i32: pick([-3, -1, 0, 2, 9]) });
          const arg = argumentFor(conversion, length);
          args.push(arg);
          corpus.push({ format: `%${flags}${width}${precision}${length}${conversion}`, args, n: pick(SIZES) });
        }
      }
    }
  }
}
// Mixed formats with literal text, truncation and occasional invalid
// directives. A stray piece can join the following literal into a directive
// shim/printf.c traps on ("%." + "length" reads as "%.le"); those are
// regenerated here and covered by the trap tests.
for (let k = 0; k < 20000; k++) {
  let format = literal();
  const args = [];
  for (let d = rand() % 5; d >= 0; d--) {
    const piece = rand() % 40 === 0
      ? { text: pick(["%", "%y", "%hhs", "%Ld", "%lp", "%5%", "%12$d", "%-", "%.", "%h", "%llh", "%q", "%D"]), args: [] }
      : directive();
    format += piece.text + literal();
    args.push(...piece.args);
  }
  if (printfConversions(format).traps.length > 0) { k--; continue; }
  const nullDst = rand() % 50 === 0;
  corpus.push({ format, args, n: nullDst ? 0 : pick(SIZES), nullDst });
}
// Every value through the plain conversions.
for (const value of INT32) for (const format of ["%d", "%i", "%u", "%o", "%x", "%X", "%c", "%hd", "%hhu", "%+.3d", "%#o", "%#x"]) {
  corpus.push({ format, args: [{ i32: value }], n: 64 });
}
for (const value of INT64) for (const format of ["%lld", "%llu", "%llo", "%llx", "%jd", "%ju", "%#llX", "% 30lld"]) {
  corpus.push({ format, args: [{ i64: value }], n: 64 });
}
// The formats the contracts pass, with realistic arguments and the callers' buffers.
const reachable = [
  "Invalid typed array length: %.*s",
  "scriptc: library entry '%s' invoked from a host callback\n",
  "scriptc: RangeError: array index %s is a hole (length %zu)\n",
  "scriptc: RangeError: array index %s is undefined (length %zu)\n",
  "scriptc: RangeError: array index %s holds a value outside its element type (length %zu)\n",
  "scriptc: RangeError: array index %s out of bounds (length %zu)\n",
  "scriptc: RangeError: numeric property %s is undefined\n",
  "scriptc: RangeError: numeric property %s is absent\n",
];
for (const format of reachable) {
  for (const n of [512, 80, 60, 40, 1, 0]) {
    for (const str of STRINGS_SAMPLE) {
      const args = format.includes("%.*s") ? [{ i32: pick([0, 3, 8, 32, 400]) }, { str }]
        : [{ str }, ...(format.includes("%zu") ? [{ i32: pick([0, 1, 7, 4294967295]) }] : [])];
      corpus.push({ format, args, n });
    }
  }
}
// Errors and limits: invalid specifications, width/precision overflow (no
// output when the first directive fails), output counts at INT_MAX.
const INT_MAX = 2147483647, INT_MIN = -2147483648;
for (const format of ["%", "abc%", "%%%", "%5%", "%12$d", "%-", "% ", "%0", "%.", "%h", "%hh", "%l", "%ll", "%L",
  "%z", "%j", "%t", "%{", "%@", "%Lx", "%hhc", "%zs", "%jp", "%hp", "%llc", "%Ls", "%hS", "%lC", "%lm",
  "%2147483648d", "abc%2147483648d", "%d%2147483648d", "%.2147483648d", "%.2147483648s", "%99999999999999s"]) {
  for (const n of [0, 4, 64]) corpus.push({ format, args: [{ i32: 5 }, { i32: 6 }, { str: "s" }], n });
}
for (const [format, args] of [
  ["%*d|", [{ i32: INT_MIN }, { i32: 5 }]],
  ["%-*d|", [{ i32: INT_MIN }, { i32: 5 }]],
  ["%*s|", [{ i32: INT_MIN }, { str: "abc" }]],
  ["%.*d|", [{ i32: INT_MIN }, { i32: 5 }]],
  ["%.*s|", [{ i32: INT_MIN }, { str: "abc" }]],
  ["%.*d|", [{ i32: INT_MAX }, { i32: 5 }]],
  ["%2147483647d", [{ i32: 1 }]],
  ["%2147483647d%d", [{ i32: 1 }, { i32: 2 }]],
  ["%2147483646d%s", [{ i32: 1 }, { str: "" }]],
  ["%2147483646dx%s", [{ i32: 1 }, { str: "" }]],
  ["%*d%c", [{ i32: INT_MAX }, { i32: 1 }, { i32: 65 }]],
]) corpus.push({ format, args, n: 16 });
// Real variadic calls through snprintf.
for (let call = 0; call <= 14; call++) {
  for (const n of [0, 1, 7, 32, 200]) corpus.push({ call, format: "", args: [{ str: "array\x80name" }], n });
  corpus.push({ call, format: "", args: [{ str: "" }], n: 0, nullDst: true });
}

// Conversions that shim/printf.c deliberately does not implement.
const TRAPS = [
  ["%f", [{ f64: 1.5 }]], ["%e", [{ f64: 1.5 }]], ["%g", [{ f64: 1.5 }]], ["%a", [{ f64: 1.5 }]],
  ["%E", [{ f64: 1.5 }]], ["%F", [{ f64: 1.5 }]], ["%G", [{ f64: 1.5 }]], ["%A", [{ f64: 1.5 }]],
  ["%.17g", [{ f64: 0.1 }]], ["%lf", [{ f64: 1.5 }]], ["%Lf", [{ f128: 0 }]], ["x%5.2Le", [{ f128: 0 }]],
  ["%n", [{ nTarget: true }]], ["%hhn", [{ nTarget: true }]], ["%lln", [{ nTarget: true }]], ["%Ln", [{ nTarget: true }]],
  ["%m", []], ["%C", [{ i32: 65 }]], ["%S", [{ str: "" }]], ["%lc", [{ i32: 65 }]], ["%ls", [{ str: "" }]],
  ["%1$d", [{ i32: 1 }]], ["%2$s%1$d", [{ i32: 1 }, { str: "a" }]], ["%d %f", [{ i32: 1 }, { f64: 2 }]],
  // musl reads an uninitialized positional slot for these, so only ours runs.
  ["%*1$d", [{ i32: 1 }], false], ["%.*1$d", [{ i32: 1 }], false],
];

// --- tests -------------------------------------------------------------------

test("libc's printf engine is gone from the minimal link", () => {
  assert.ok(linkedMuslPrintf(readFileSync(libcWasm)).includes("printf_core"), "the detector sees musl's engine");
  assert.deepEqual(linkedMuslPrintf(readFileSync(minimalWasm)), []);
});

test("shim/printf.c matches musl byte for byte on supported formats", () => {
  let compared = 0;
  for (const testCase of corpus) {
    const expected = runCase(libc, testCase);
    const actual = runCase(minimal, testCase);
    // A generated format that musl itself rejects must also stop the shim.
    if (expected.trap) {
      assert.ok(actual.trap, `libc trapped on ${JSON.stringify(testCase.format)} but shim/printf.c did not`);
      continue;
    }
    assert.ok(!actual.trap, `shim/printf.c trapped on ${JSON.stringify(testCase.format)} (call ${testCase.call})`);
    assert.deepEqual(actual, expected, `format ${JSON.stringify(testCase.format)} call ${testCase.call} n ${testCase.n} ` +
      `args ${JSON.stringify(testCase.args, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    compared++;
  }
  assert.ok(compared > 50000, `compared ${compared} cases`);
});

test("unsupported conversions trap instead of printing something else", () => {
  for (const [format, args, compare = true] of TRAPS) {
    for (const n of [0, 64]) {
      if (compare) assert.ok(!runCase(libc, { format, args, n }).trap, `libc handles ${format}`);
      const actual = runCase(minimal, { format, args, n });
      assert.ok(actual.trap, `${format} should trap, got ${JSON.stringify(actual)}`);
      assert.ok(printfConversions(format).problems.length > 0, `the build check rejects ${format}`);
    }
  }
});

test("the format grammar accepts exactly the implemented subset", () => {
  for (const format of reachable) assert.deepEqual(printfConversions(format).problems, [], format);
  for (const format of ["%d", "%-+ #0'25.*lld", "%hhx", "%zu", "%tX", "%jo", "%c", "%-10.3s", "%p", "%%", "a%%b%s"]) {
    assert.deepEqual(printfConversions(format).problems, [], format);
  }
  for (const format of [...TRAPS.map(([format]) => format), "%y", "%Ld", "%hhs", "%lp", "%", "%5%", "%12$d"]) {
    assert.ok(printfConversions(format).problems.length > 0, format);
  }
  // The grammar's trap classification is exactly where shim/printf.c traps,
  // and every other rejected directive fails with EINVAL as in musl.
  const characters = [..."%$*.#0- +'"].concat(Array.from({ length: 58 }, (_, k) => String.fromCharCode(65 + k)));
  for (const length of ["", "hh", "h", "l", "ll", "z", "t", "j", "L"]) {
    for (const conversion of characters) {
      for (const format of ["%" + length + conversion, "%1$" + length + conversion]) {
        const { traps, problems } = printfConversions(format);
        const args = [{ i64: 0n }, { i64: 0n }, { i64: 0n }];
        const actual = runCase(minimal, { format, args, n: 64 });
        assert.equal(Boolean(actual.trap), traps.length > 0, format);
        if (actual.trap) continue;
        assert.deepEqual(actual, runCase(libc, { format, args, n: 64 }), format);
        if (problems.length > 0) assert.deepEqual([actual.ret, actual.errno], [-1, 28 /* EINVAL */], format);
      }
    }
  }
});

test("the build check follows forwarded formats and rejects unsupported or dynamic ones", () => {
  const link = (name, source) => {
    const c = join(work, `${name}.c`), wasm = join(work, `${name}.wasm`);
    writeFileSync(c, `#include <stdarg.h>\n#include <stdio.h>\n${source}`);
    zig(["-O2", "-fno-builtin", "-Wno-format", "-mexec-model=reactor", minimalPrintfObject(), c, "-o", wasm]);
    return readFileSync(wasm);
  };
  const forward = `
static char buf[64];
__attribute__((noinline)) static void report(const char *fmt, ...) {
  va_list ap; va_start(ap, fmt); vsnprintf(buf, sizeof buf, fmt, ap); va_end(ap);
}
__attribute__((export_name("go"))) void go(int k, const char *s) {`;
  const ok = printfFormatSites(link("check-ok", `${forward}
  if (k) report("value %d of %s", k, s); else report("plain %zu", (size_t)k);
  snprintf(buf, sizeof buf, "%c", 'x');
}`));
  assert.deepEqual(ok.forwarders, ["report"]);
  assert.deepEqual(ok.sites.map((site) => site.format).sort(), ["%c", "plain %zu", "value %d of %s"]);
  assert.throws(() => printfFormatSites(link("check-float", `${forward}
  if (k) report("value %d", k); else report("ratio %f", 0.5);
}`)), /unsupported conversion "%f"/);
  assert.throws(() => printfFormatSites(link("check-dynamic", `${forward}
  snprintf(buf, sizeof buf, s, k);
}`)), /not a constant string|outside the module/);
  assert.throws(() => printfFormatSites(link("check-exported", `
static char buf[64];
__attribute__((export_name("go"))) void go(const char *fmt, int k) { snprintf(buf, sizeof buf, fmt, k); }`)),
  /outside the module|not a constant/);
});

test("built contracts link shim/printf.c and pass only supported formats", (t) => {
  const contracts = readdirSync(join(root, "contracts")).filter((name) => existsSync(join(root, "build", name, "printf-formats.json")));
  if (contracts.length === 0) return t.skip("run npm run build first");
  for (const name of contracts) {
    const report = JSON.parse(readFileSync(join(root, "build", name, "printf-formats.json"), "utf8"));
    // Word-lowered contracts never format floats. The general bigint runtime
    // reaches "%.17g" (scr_bigint_from_f64), so those contracts keep libc.
    const lowering = JSON.parse(readFileSync(join(root, "dist", `${name}.manifest.json`), "utf8")).lowering;
    if (lowering === "bigint") {
      assert.equal(report.printf, "libc", name);
      assert.match(report.reason, /unsupported conversion "%\.17g"/, name);
      continue;
    }
    assert.equal(report.printf, "minimal", `${name}: ${report.reason}`);
    assert.deepEqual(report.muslPrintf, [], `${name} links musl's printf engine`);
    assert.ok(report.sites.length > 0, name);
    for (const site of report.sites) assert.deepEqual(printfConversions(site.format).problems, [], `${name}: ${site.format}`);
    assert.ok(MUSL_PRINTF_INTERNALS.every((fn) => !report.muslPrintf.includes(fn)));
  }
});
