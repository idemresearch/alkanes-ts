import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// Load the SDK without host calls to exercise registrations not in the examples.
const directory = mkdtempSync(join(tmpdir(), "alkanes-dispatch-"));
let sdk;
try {
  for (const file of readdirSync(new URL("../sdk/", import.meta.url)).filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(new URL(`../sdk/${file}`, import.meta.url), "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    });
    writeFileSync(join(directory, file.replace(/\.ts$/, ".mjs")), outputText.replace(/(["']\.\/.+)\.ts(["'])/g, "$1.mjs$2"));
  }
  sdk = await import(pathToFileURL(join(directory, "index.mjs")).href);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
const context = (inputs) => new sdk.Context(new sdk.AlkaneId(2n, 1n), new sdk.AlkaneId(2n, 100n),
  0n, new sdk.AlkaneTransferParcel(), inputs);

test("dispatch keeps duplicate opcode order and last registered handler", () => {
  const contract = new sdk.Contract("Duplicate")
    .method(7, "old", [], "u128", () => new sdk.CallResponse().withU128(1n))
    .method(8, "other", [], "u128", () => new sdk.CallResponse().withU128(8n))
    .method(7, "new", [sdk.param("value")], "u128", (_ctx, args) => new sdk.CallResponse().withU128(args.u128(0)));
  assert.throws(() => contract.dispatch(context([7n])), /new expects 1 inputs/);
  assert.equal(sdk.bytesToU128(contract.dispatch(context([7n, 99n])).data), 99n);
  assert.equal(sdk.bytesToU128(contract.dispatch(context([8n])).data), 8n);
  assert.deepEqual(JSON.parse(contract.abi()).methods.map((method) => method.name), ["old", "other", "new"]);
});

test("dispatch preserves full-width opcode matching, fallback arguments and missing-input errors", () => {
  const opcode = 1n << 53n;
  const contract = new sdk.Contract("LargeOpcode")
    .method(Number(opcode), "large", [], "u128", () => new sdk.CallResponse().withU128(1n))
    .fallback((_ctx, args) => new sdk.CallResponse().withU128(args.u128(0)));
  assert.equal(sdk.bytesToU128(contract.dispatch(context([opcode])).data), 1n);
  assert.equal(sdk.bytesToU128(contract.dispatch(context([opcode + 1n, 42n])).data), 42n);
  assert.throws(() => contract.dispatch(context([])), /No opcode provided/);
  const empty = new sdk.Contract("Empty");
  assert.throws(() => empty.dispatch(context([1n << 127n])), /Unrecognized opcode 170141183460469231731687303715884105728/);
});
