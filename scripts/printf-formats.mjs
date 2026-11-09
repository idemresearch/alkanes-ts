// Static check that shim/printf.c never sees a format it does not implement.
//
// shim/printf.c traps on conversions musl supports but it does not (floating
// point, %n, %m, wide characters, positional arguments). This pass takes a
// linked contract with its name section, finds every call to vsnprintf and
// snprintf, and follows format parameters that are passed through unchanged
// (scr_trap_fmt(fmt, ...) forwards its fmt to vsnprintf) back to their
// callers. Every format must be an i32.const address of a string in an active
// data segment, and every conversion in it must be in the supported subset.
// Anything else, including a format that comes from an exported or
// table-reachable function, is an error.
//
// The linked module contains every function the final contract can reach,
// so the formats found here are a superset of those the final module can
// pass to vsnprintf.

import binaryen from "binaryen";

// Format parameter index of the functions shim/printf.c defines.
const PRINTF = new Map([["vsnprintf", 2], ["snprintf", 2]]);

// musl's printf engine. Present only when something other than vsnprintf
// and snprintf pulls in libc's vfprintf.
export const MUSL_PRINTF_INTERNALS = ["vfprintf", "printf_core", "pop_arg", "fmt_fp", "wctomb", "__multf3", "__addtf3", "__lttf2"];

// --- WebAssembly text (binaryen's folded output) -------------------------

function parseSexpr(text) {
  const root = [];
  const stack = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "(" && text[i + 1] === ";") {
      const end = text.indexOf(";)", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === ";" && text[i + 1] === ";") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? n : end + 1;
    } else if (c === "(") {
      const list = [];
      stack.at(-1).push(list);
      stack.push(list);
      i++;
    } else if (c === ")") {
      if (stack.length === 1) throw new Error("unbalanced wasm text");
      stack.pop();
      i++;
    } else if (c === " " || c === "\n" || c === "\t" || c === "\r") {
      i++;
    } else {
      let j = i;
      while (j < n) {
        const d = text[j];
        if (d === '"') {
          j++;
          while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
          j++;
        } else if (d === "(" || d === ")" || d === " " || d === "\n" || d === "\t" || d === "\r") break;
        else j++;
      }
      stack.at(-1).push(text.slice(i, j));
      i = j;
    }
  }
  if (stack.length !== 1) throw new Error("unbalanced wasm text");
  return root;
}

// Every list in the tree, iteratively (expression nesting can be deep).
function* walk(node) {
  const stack = [node];
  while (stack.length > 0) {
    const list = stack.pop();
    if (!Array.isArray(list)) continue;
    yield list;
    for (let k = list.length - 1; k >= 0; k--) stack.push(list[k]);
  }
}

// --- active data segments, read from the binary ---------------------------

function activeData(bytes) {
  const segments = [];
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
  const sleb32 = () => {
    let result = 0, shift = 0, byte;
    do {
      byte = bytes[i++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return shift < 32 && byte & 0x40 ? result | (-1 << shift) : result;
  };
  while (i < bytes.length) {
    const id = bytes[i++];
    const size = leb();
    const end = i + size;
    if (id === 11) {
      for (let count = leb(); count > 0; count--) {
        const flags = leb();
        let offset = null;
        if (flags === 0 || flags === 2) {
          if (flags === 2) leb();
          if (bytes[i] === 0x41 && (i++, true)) {
            offset = sleb32() >>> 0;
            if (bytes[i++] !== 0x0b) offset = null;
          }
          if (offset === null) throw new Error("data segment offset is not an i32.const");
        } else if (flags !== 1) throw new Error(`unknown data segment flags ${flags}`);
        const length = leb();
        if (offset !== null) segments.push({ offset, bytes: bytes.subarray(i, i + length) });
        i += length;
      }
    }
    i = end;
  }
  return segments;
}

function cString(segments, address) {
  for (const segment of segments) {
    const at = address - segment.offset;
    if (at < 0 || at >= segment.bytes.length) continue;
    const end = segment.bytes.indexOf(0, at);
    if (end < 0) throw new Error(`format at ${address} is not NUL-terminated within its data segment`);
    return Buffer.from(segment.bytes.subarray(at, end)).toString("latin1");
  }
  throw new Error(`format at ${address} is outside every active data segment`);
}

// --- format grammar --------------------------------------------------------

const isDigit = (c) => c !== undefined && c >= "0" && c <= "9";

// Splits a format into conversions, mirroring shim/printf.c's parser, and
// reports every directive it would trap on (`traps`: valid in musl but not
// implemented) or reject with EINVAL like musl. `problems` lists both; the
// build accepts only formats without problems.
export function printfConversions(format) {
  const conversions = [];
  const traps = [];
  const problems = [];
  let i = 0;
  while (i < format.length) {
    if (format[i] !== "%") { i++; continue; }
    if (format[i + 1] === "%") { i += 2; continue; }
    const start = i;
    let positional = isDigit(format[i + 1]) && format[i + 2] === "$";
    i++;
    while ("#0- +'".includes(format[i] ?? "x")) i++;
    if (format[i] === "*") {
      positional ||= isDigit(format[i + 1]) && format[i + 2] === "$";
      i++;
    } else while (isDigit(format[i])) i++;
    if (format[i] === "." && format[i + 1] === "*") {
      positional ||= isDigit(format[i + 2]) && format[i + 3] === "$";
      i += 2;
    } else if (format[i] === ".") {
      i++;
      while (isDigit(format[i])) i++;
    }
    let length = "";
    const two = format.slice(i, i + 2);
    if (two === "hh" || two === "ll") length = two;
    else if ("hlztjL".includes(format[i] ?? "x")) length = format[i];
    i += length.length;
    const conversion = format[i] ?? "";
    if (i < format.length) i++;
    const directive = format.slice(start, i);
    conversions.push(directive);
    const is = (set) => conversion !== "" && set.includes(conversion);
    let kind = "invalid";
    if (positional) kind = "trap";
    else if (is("diouxX")) kind = length === "L" ? "invalid" : "ok";
    else if (is("csp") && length === "") kind = "ok";
    else if (is("cs") && length === "l") kind = "trap"; // wide characters
    else if (is("n")) kind = "trap";
    else if (is("mCS") && length === "") kind = "trap";
    else if (is("efgaEFGA") && (length === "" || length === "l" || length === "L")) kind = "trap";
    if (kind === "trap") traps.push(directive);
    if (kind !== "ok") problems.push(`${kind === "trap" ? "unsupported" : "invalid"} conversion ${JSON.stringify(directive)}`);
  }
  return { conversions, traps, problems };
}

// --- call-site analysis ----------------------------------------------------

// Returns every printf call site in a linked module that has a name section:
// [{ caller, callee, address, format, conversions }]. Throws if a format is
// not a constant or uses something shim/printf.c does not implement.
export function printfFormatSites(bytes) {
  const module = binaryen.readBinary(bytes);
  let text;
  try {
    module.setFeatures(binaryen.Features.All);
    text = module.emitText();
  } finally {
    module.dispose();
  }
  const [moduleNode] = parseSexpr(text);
  if (!Array.isArray(moduleNode) || moduleNode[0] !== "module") throw new Error("not a module");

  const functions = new Map();
  const external = new Set(); // exported or in a table: callers unknown
  for (const field of moduleNode.slice(1)) {
    if (!Array.isArray(field)) continue;
    if (field[0] === "func") {
      const name = field[1];
      const params = [];
      let body = 2;
      for (; body < field.length && Array.isArray(field[body]); body++) {
        const item = field[body];
        if (item[0] === "export") external.add(name);
        else if (item[0] === "param") {
          if (typeof item[1] === "string" && item[1].startsWith("$")) params.push(item[1]);
          else for (let k = 1; k < item.length; k++) params.push(`$${params.length}`);
        } else if (item[0] !== "type" && item[0] !== "result" && item[0] !== "local") break;
      }
      functions.set(name, { name, params, body: field.slice(body), imported: false });
    } else if (field[0] === "import") {
      const desc = field.find((item) => Array.isArray(item) && item[0] === "func");
      if (desc) functions.set(desc[1], { name: desc[1], params: [], body: [], imported: true });
    } else if (field[0] === "export") {
      const desc = field.find((item) => Array.isArray(item) && item[0] === "func");
      if (desc) external.add(desc[1]);
    } else if (field[0] === "elem") {
      for (const node of walk(field)) for (const atom of node.slice(1)) {
        if (typeof atom === "string" && atom.startsWith("$")) external.add(atom);
      }
    }
  }
  for (const node of walk(moduleNode)) if (node[0] === "ref.func") external.add(node[1]);

  // Call sites and parameter writes per function.
  for (const fn of functions.values()) {
    fn.calls = [];
    fn.written = new Set();
    for (const node of walk(fn.body)) {
      if ((node[0] === "call" || node[0] === "return_call") && typeof node[1] === "string") {
        fn.calls.push({ callee: node[1], operands: node.slice(2) });
      } else if ((node[0] === "local.set" || node[0] === "local.tee") && typeof node[1] === "string") {
        fn.written.add(node[1]);
      }
    }
  }

  const formatParam = new Map([...PRINTF].map(([name, index]) => [`$${name}`, index])
    .filter(([name]) => functions.has(name)));
  const segments = activeData(bytes);
  const sites = [];
  const done = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of functions.values()) {
      for (const call of fn.calls) {
        const index = formatParam.get(call.callee);
        if (index === undefined) continue;
        const operand = call.operands[index];
        const where = `${fn.name.slice(1)} -> ${call.callee.slice(1)}`;
        if (Array.isArray(operand) && operand[0] === "i32.const" && operand.length === 2) {
          if (done.has(call)) continue;
          done.add(call);
          const address = Number(operand[1]) >>> 0;
          const format = cString(segments, address);
          const { conversions, problems } = printfConversions(format);
          if (problems.length > 0) {
            throw new Error(`${where}: format ${JSON.stringify(format)} at ${address}: ${problems.join(", ")}`);
          }
          sites.push({ caller: fn.name.slice(1), callee: call.callee.slice(1), address, format, conversions });
        } else if (Array.isArray(operand) && operand[0] === "local.get" && fn.params.includes(operand[1]) &&
          !fn.written.has(operand[1])) {
          // The caller forwards one of its own parameters: check its callers.
          if (PRINTF.has(fn.name.slice(1))) continue; // snprintf -> vsnprintf
          if (external.has(fn.name)) throw new Error(`${where}: format comes from outside the module`);
          const param = fn.params.indexOf(operand[1]);
          const known = formatParam.get(fn.name);
          if (known === undefined) {
            formatParam.set(fn.name, param);
            changed = true;
          } else if (known !== param) throw new Error(`${where}: forwards two different format parameters`);
        } else {
          throw new Error(`${where}: format is not a constant string`);
        }
      }
    }
  }
  for (const name of formatParam.keys()) {
    if (external.has(name) && !PRINTF.has(name.slice(1))) throw new Error(`${name.slice(1)} is reachable from outside the module`);
  }
  for (const name of PRINTF.keys()) {
    if (external.has(`$${name}`)) throw new Error(`${name} is exported or in a table`);
  }
  return {
    sites,
    forwarders: [...formatParam.keys()].map((name) => name.slice(1)).filter((name) => !PRINTF.has(name)),
    muslPrintf: linkedMuslPrintf(bytes),
  };
}

// Function names from the name section.
export function functionNames(bytes) {
  const names = new Set();
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
  while (i < bytes.length) {
    const id = bytes[i++];
    const end = leb() + i;
    if (id === 0 && string() === "name") {
      while (i < end) {
        const kind = bytes[i++];
        const subEnd = leb() + i;
        if (kind === 1) for (let count = leb(); count > 0; count--) {
          leb();
          names.add(string());
        }
        i = subEnd;
      }
    }
    i = end;
  }
  return names;
}

// The parts of musl's printf engine present in a module with a name section.
export function linkedMuslPrintf(bytes) {
  const names = functionNames(bytes);
  if (names.size === 0) throw new Error("module has no function names");
  return MUSL_PRINTF_INTERNALS.filter((name) => names.has(name));
}

// Removes custom sections (names, DWARF, producers): the pipeline input is
// then the module wasm-ld writes with --strip-debug.
export function stripCustomSections(bytes) {
  const parts = [bytes.subarray(0, 8)];
  let i = 8;
  while (i < bytes.length) {
    const start = i++;
    let size = 0, shift = 0, byte;
    do {
      byte = bytes[i++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    const end = i + size;
    if (bytes[start] !== 0) parts.push(bytes.subarray(start, end));
    i = end;
  }
  return Buffer.concat(parts);
}

// The module with a name section holding function names only, and no other
// custom section. Binaryen addresses data segments and globals by name once
// they have one, which scripts/snapshot.mjs does not expect.
export function functionNamesOnly(bytes) {
  const parts = [bytes.subarray(0, 8)];
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
  const encode = (value) => {
    const out = [];
    do {
      const byte = value & 0x7f;
      value >>>= 7;
      out.push(value ? byte | 0x80 : byte);
    } while (value);
    return Buffer.from(out);
  };
  while (i < bytes.length) {
    const start = i++;
    const end = leb() + i;
    if (bytes[start] !== 0) {
      parts.push(bytes.subarray(start, end));
    } else {
      const length = leb();
      const name = Buffer.from(bytes.subarray(i, i + length)).toString("utf8");
      i += length;
      while (name === "name" && i < end) {
        const subsection = i;
        const kind = bytes[i++];
        const subEnd = leb() + i;
        if (kind === 1) {
          const payload = Buffer.concat([Buffer.from([4]), Buffer.from("name"), bytes.subarray(subsection, subEnd)]);
          parts.push(Buffer.from([0]), encode(payload.length), payload);
        }
        i = subEnd;
      }
    }
    i = end;
  }
  return Buffer.concat(parts);
}
