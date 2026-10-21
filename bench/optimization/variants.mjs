// Generate independent copies; keep the legacy codecs as a stable baseline.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`variant target changed: ${before}`);
  return source.replace(before, after);
}

function declaration(source, predicate, required = true) {
  const file = ts.createSourceFile("bytes.ts", source, ts.ScriptTarget.ES2022, true);
  const nodes = file.statements.filter(predicate);
  if (!required && nodes.length === 0) return null;
  if (nodes.length !== 1) throw new Error("codec fixture declaration changed");
  return { start: nodes[0].getStart(file), end: nodes[0].end, text: nodes[0].getText(file) };
}

function legacyCodecs(source, reference) {
  for (const name of ["toHex", "u128ToBytes", "bytesToU128"]) {
    const matches = (node) => ts.isFunctionDeclaration(node) && node.name?.text === name;
    const current = declaration(source, matches);
    source = source.slice(0, current.start) + declaration(reference, matches).text + source.slice(current.end);
  }
  const writer = (node) => ts.isClassDeclaration(node) && node.name?.text === "ByteWriter";
  const currentWriter = declaration(source, writer);
  source = source.slice(0, currentWriter.start) + declaration(reference, writer).text + source.slice(currentWriter.end);
  const variable = (name) => (node) => ts.isVariableStatement(node)
    && node.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name);
  const ascii = declaration(source, variable("HEX_ASCII"), false);
  const hex = declaration(reference, variable("HEX")).text;
  if (ascii) return source.slice(0, ascii.start) + hex + source.slice(ascii.end);
  const max = declaration(source, variable("U128_MAX"));
  return source.slice(0, max.end) + "\n" + hex + source.slice(max.end);
}

export function prepareVariant(root, directory, variant) {
  mkdirSync(directory, { recursive: true });
  cpSync(join(root, "sdk"), join(directory, "sdk"), { recursive: true });
  mkdirSync(join(directory, "bench/isolation"), { recursive: true });
  cpSync(join(root, "bench/isolation/probes.ts"), join(directory, "bench/isolation/probes.ts"));
  if (!["baseline", "annotations", "codecs"].includes(variant)) throw new Error(`unknown variant ${variant}`);

  const bytesPath = join(directory, "sdk/bytes.ts");
  let bytes = readFileSync(bytesPath, "utf8");
  if (variant !== "codecs") {
    bytes = legacyCodecs(bytes, readFileSync(join(root, "bench/optimization/legacy-codecs.ts"), "utf8"));
    writeFileSync(bytesPath, bytes);
  }
  if (variant === "baseline") return;
  bytes = 'import type { NoThrow } from "@scriptc/types";\n' + bytes;
  bytes = replaceOnce(bytes, "export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean",
    "export function bytesEqual(a: Uint8Array, b: Uint8Array): NoThrow<boolean>");
  writeFileSync(bytesPath, bytes);
  const typesPath = join(directory, "sdk/types.ts");
  let types = readFileSync(typesPath, "utf8");
  types = 'import type { Acyclic } from "@scriptc/types";\n' + types;
  types = replaceOnce(types, "export class AlkaneId {", "export class AlkaneId implements Acyclic {");
  writeFileSync(typesPath, types);
  // The codecs variant already has the production algorithms; annotations
  // shares the baseline's restored legacy codecs.
}
