// Contracts run from TypeScript source in Node (test/source.mjs) must behave
// like the modules the build ships. Every example contract replays the same
// call sequences from source and from dist/, and the responses, reverts,
// committed storage, balances and logs must be identical after every call.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { buildLibrary } from "../scripts/build.mjs";
import { sourceProgram } from "./source.mjs";
import { AlkanesVM } from "./vm.mjs";

const root = resolve(import.meta.dirname, "..");
const source = (name) => join(root, "contracts", name, "index.ts");
const built = (name) => readFileSync(join(root, "dist", `${name}.wasm`));

// The authority fixture exports a contract object, not an authoring class.
const authSource = join(root, "test/fixtures/test-auth.ts");
function authWasm() {
  const work = join(root, "build/source-tests/test-auth"), entry = join(work, "entry.ts"), out = join(work, "test-auth.wasm");
  mkdirSync(work, { recursive: true });
  writeFileSync(entry, `import contract from ${JSON.stringify(authSource)};
import {executeContract,contractMeta} from ${JSON.stringify(join(root, "sdk/contract.ts"))};
export function execute(context:Uint8Array):Uint8Array{return executeContract(contract,context);}
export function meta():Uint8Array{return contractMeta(contract);}`);
  buildLibrary({ entry, work, out });
  return readFileSync(out);
}
// name -> [source path, built module]
const code = {
  auth: () => [authSource, authWasm()],
  "amm-pool": () => [source("amm-pool"), built("amm-pool")],
};

// Call sequences in the wasmi-check syntax bench/measure-wasmi.mjs uses: a call
// is comma-separated u128 inputs, optionally followed by @id=amount+id=amount;
// --deploy id=name and --target id set the scene. The contract under test is
// at 2:1 and the height is 900,000.
const AUTH = ["--deploy", "4:9001=auth", "--target", "4:9001", "0,0", "--target", "2:1"];
const AMM = ["0,2,11,2,12", "1,0@2:11=1000000+2:12=4000000"];
const VAULT = [...AUTH, "0,2,5,4,9001,100", "1,0@2:5=1000000"];
const TREASURY = [...AUTH, "0,4,9001,0,100@4:9001=1", "1,2,5@2:5=1000"];
const POOLS = ["--deploy", "2:10=amm-pool", "--deploy", "2:20=amm-pool",
  "--target", "2:10", "0,2,11,2,12", "1,0@2:11=1000000+2:12=4000000",
  "--target", "2:20", "0,2,13,2,12", "1,0@2:13=3000000+2:12=2000000", "--target", "2:1"];
const MAX = (1n << 128n) - 1n;
const SCENARIOS = {
  counter: [["0", "1,5", "1,7", "2", "3", "2", "0", "4", "5,100", "5,300001", "6,10", "2", "9", "1", `1,${MAX}`, "1,1", "2", "2@2:9=5"]],
  token: [["0,1000", "77,5", "99", "100", "101", "0,1", "77", "42"]],
  "capped-token": [
    [...AUTH, "0,4,9001,1000", "101", "102", "103", "77,5@4:9001=1", "101", "77,996@4:9001=1", "77,5", "0,4,9001,1", "55"],
    ["101", "77,1"],
  ],
  "amm-pool": [
    [...AMM, "1,0@2:11=500+2:12=3000+2:13=7", "3,0@2:11=10000", "3,0@2:12=50000", "3,99999999@2:11=10", "20", "21", "10,10000", "2,0,0@2:1=999000", "20"],
    ["1,0@2:11=5", "0,2,11,2,11", "0,2,11,2,12", "0,2,11,2,12", "1,0@2:11=1000+2:12=1000", "1,0"],
  ],
  "share-vault": [
    [...VAULT, "1,0@2:5=500000", "12,1000", "2,0@2:1=400000000", "3@4:9001=1+2:5=5000", "17", "1,0@2:5=1000", "3@2:5=5000", "2,0@2:1=1"],
  ],
  "timelock-treasury": [
    [...TREASURY, "2,2,5,400@4:9001=1", "10", "13,2,5", "3@4:9001=1", "2,2,5,400@4:9001=1", "4@4:9001=1", "2,2,5,400", "3@4:9001=1"],
  ],
  "amm-router": [
    [...POOLS, "0", "2,2,11,2,10,2,12,0,1000000000@2:11=10000", "1,2,11,2,10,2,12,2,20,2,13,0,1000000000@2:11=10000",
      "2,2,11,2,10,2,12,1000000000,1000000000@2:11=10000", "2,2,11,2,10,2,12,0,1@2:11=10000"],
  ],
};

const id = (text) => {
  const [block, tx] = text.split(":").map(BigInt);
  return { block, tx };
};
function request(target, call) {
  const [inputs, parcel] = call.split("@");
  return {
    target,
    inputs: inputs.split(",").map(BigInt),
    incoming: parcel ? parcel.split("+").map((entry) => ({ id: id(entry.split("=")[0]), value: BigInt(entry.split("=")[1]) })) : [],
  };
}
const outcome = (vm, call) => {
  try {
    const response = vm.call(call);
    return { alkanes: response.alkanes, data: Buffer.from(response.data).toString("hex") };
  } catch (error) {
    return { error: error.message };
  }
};

// Runs `steps` on a VM whose contracts come from source (0) or dist/ (1) and
// returns what a test can observe after every call.
function replay(contract, steps, which, modules) {
  const vm = new AlkanesVM({ height: 900000n });
  let target = id("2:1");
  vm.deploy(target, modules[contract][which]);
  const trace = [];
  for (let i = 0; i < steps.length; i++) {
    if (steps[i] === "--deploy") {
      const [at, name] = steps[++i].split("=");
      vm.deploy(id(at), modules[name][which]);
    } else if (steps[i] === "--target") {
      target = id(steps[++i]);
    } else {
      trace.push({ call: steps[i], outcome: outcome(vm, request(target, steps[i])), storage: vm.snapshot(), balances: new Map(vm.balances), logs: vm.logs.slice() });
    }
  }
  return { trace, meta: vm.meta(id("2:1")) };
}

test("every example contract behaves the same from source as from the built module", () => {
  const modules = Object.fromEntries(Object.entries(code).map(([name, load]) => [name, load()]));
  let calls = 0, reverts = 0;
  for (const [contract, scenarios] of Object.entries(SCENARIOS)) {
    modules[contract] ??= [source(contract), built(contract)];
    for (const steps of scenarios) {
      const fromSource = replay(contract, steps, 0, modules), fromWasm = replay(contract, steps, 1, modules);
      assert.deepEqual(fromSource.meta, fromWasm.meta, `${contract} ABI`);
      assert.equal(fromSource.trace.length, fromWasm.trace.length);
      fromWasm.trace.forEach((expected, i) => {
        assert.deepEqual(fromSource.trace[i], expected, `${contract} call ${i}: ${expected.call}`);
        calls++;
        if (expected.outcome.error) reverts++;
      });
    }
  }
  // The sequences exercise both outcomes, so agreement is not vacuous.
  assert.ok(reverts >= 20 && calls - reverts >= 55, `${calls} calls, ${reverts} reverts`);
});

test("the Counter/Token, AmmPool and semantics suites pass unchanged from source", () => {
  // node --test refuses to nest unless the parent's marker is removed.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  let output;
  try {
    output = execFileSync(process.execPath, ["--test", "test/contracts.test.mjs", "test/amm-pool.test.mjs", "test/semantics.test.mjs"],
      { cwd: root, env: { ...env, ALKANES_SOURCE: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    assert.fail(`suites failed from source:\n${error.stdout}\n${error.stderr}`);
  }
  assert.match(output, /ℹ fail 0\n/);
  assert.match(output, /ℹ pass (\d+)\n/);
  assert.ok(Number(/ℹ pass (\d+)\n/.exec(output)[1]) >= 24);
});

test("source execution starts every call from fresh module state and reports frontend diagnostics", () => {
  const vm = new AlkanesVM();
  const first = id("2:1"), second = id("2:2");
  // Two deployments of one program share compiled code but no state.
  vm.deploy(first, source("counter"));
  vm.deploy(second, source("counter"));
  assert.equal(sourceProgram(source("counter")), sourceProgram(source("counter")));
  vm.call({ target: first, inputs: [0] });
  vm.call({ target: first, inputs: [1, 41] });
  assert.throws(() => vm.call({ target: first, inputs: [3] }), /intentional failure/);
  vm.call({ target: second, inputs: [0] });
  assert.equal(vm.call({ target: second, inputs: [2] }).data[0], 0);
  assert.equal(vm.call({ target: first, inputs: [2] }).data[0], 41);

  const work = join(root, "build/source-tests");
  mkdirSync(work, { recursive: true });
  const broken = join(work, "broken.ts");
  writeFileSync(broken, `import { Contract, method, view, type u128 } from ${JSON.stringify(join(root, "sdk/authoring.ts"))};
export default class Broken extends Contract {
  @method({ opcode: 1 }) a(): void {}
  @view({ opcode: 1 }) b(): u128 { return 0n; }
}
`);
  assert.throws(() => new AlkanesVM().deploy(first, broken), /broken\.ts:4:\d+: ALK1001 duplicate opcode 1/);
});
