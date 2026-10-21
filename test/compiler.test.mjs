import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import ts from "typescript";
import { compileContract } from "../compiler/index.mjs";
import { generateClient } from "../compiler/client.mjs";
import { AlkanesVM, u128 } from "./vm.mjs";

const filename = resolve("test/fixtures/probe.ts");
const header = 'import { Contract, state, init, method, view, assert, type u128, type AlkaneId } from "../../sdk/authoring.ts";\n';
const compile = (body, extra = "") => compileContract({ filename, source: header + extra + '\nexport default class Probe extends Contract {\n' + body + '\n}' });

test("frontend rejects duplicate selectors/keys and unstable declarations at source locations", () => {
  for (const [body, message] of [
    ['@method({opcode:1}) a():void {} @view({opcode:1}) b():void {}', /duplicate opcode 1/],
    ['@state({key:"/x"}) a:u128=0n; @state({key:"/x"}) b:u128=0n; @view({opcode:1}) get():u128{return this.a;}', /duplicate storage key/],
    ['@state({key:"/x"}) a:u128=BigInt(0); @view({opcode:1}) get():u128{return this.a;}', /bigint literal default/],
    ['@method({opcode:9007199254740992}) a():void {}', /bigint literal for large opcodes/],
    ['@view({opcode:1}) a():u128 {return 340282366920938463463374607431768211456n;}', /literal out of range/],
    ['@view({opcode:1}) a():u128 {let x:u128=1n; return x++;}', /standalone statement/],
    ['@view({opcode:1}) a():u128 {return 2n ** 3n;}', /exponentiation/],
    ['@view({opcode:1}) a():u128 {return (this as unknown as {x:bigint}).x;}', /this cannot escape|unsafe casts/],
    ['@view({opcode:1}) a():u128 {const x=this; return 0n;}', /this cannot escape/],
    ['private x:u128=BigInt(0); @view({opcode:1}) a():u128 {return this.x;}', /temporary initializers/],
  ]) assert.throws(() => compile(body), message);
  assert.throws(() => compile('@method({opcode:1}) a():void {} @method({opcode:1}) b():void {}'), /probe.ts:\d+:\d+: ALK1001/);
  assert.throws(() => compileContract({filename, source:header+'class Probe extends Contract {@view({opcode:1}) a():u128{return 0n;}} export default Probe;'}), /default-exported class/);
});

test("views reject direct and transitive effects, mutating opcodes, and SDK aliases", () => {
  const storage = '@state({key:"/x"}) x:u128=0n; ';
  for (const [body, extra, message] of [
    [storage + '@view({opcode:1}) a():void {this.x += 1n;}', '', /persistent write/],
    [storage + '@view({opcode:1}) a():void {this.b();} private b():void{this.c();} private c():void{this.x=1n;}', '', /a -> b -> c: persistent write/],
    ['@view({opcode:1}) a():void {this.b();} @method({opcode:2}) b():void{}', '', /cannot call @method b/],
    ['@view({opcode:1}) a():void {save(new Uint8Array(),new Uint8Array());}', 'import {store as save} from "../../sdk/runtime.ts";', /mutating call save/],
    ['@view({opcode:1}) a():void {const p=new StoragePointer("/x");p.setU128(1n);}', 'import {StoragePointer} from "../../sdk/index.ts";', /mutating call p.setU128/],
    ['@view({opcode:1}) a():void {const p=new StoragePointer("/x");const bytes=p.get();bytes[0]=1;}', 'import {StoragePointer} from "../../sdk/index.ts";', /object\/array alias/],
    ['@view({opcode:1}) a():void {call(new Cellpack(new Id(2n,1n),[]),new AlkaneTransferParcel(),100);}', 'import {call, Cellpack, AlkaneId as Id, AlkaneTransferParcel} from "../../sdk/index.ts";', /mutating call call/],
  ]) assert.throws(() => compile(body, extra), message);
});

test("field renames preserve keys/defaults, ABI names and full-width selectors", () => {
  const body = '@state({key:"/stable"}) count:u128=17n; @view({opcode:170141183460469231731687303715884105728n,abiName:"get_count"}) get():u128{return this.count;}';
  const first = compile(body), renamed = compile(body.replaceAll('count:u128', 'renamed:u128').replaceAll('this.count', 'this.renamed'));
  assert.equal(first.abi, renamed.abi);
  assert.equal(first.manifest.state[0].key, renamed.manifest.state[0].key);
  assert.equal(first.manifest.state[0].default, "17");
  assert.equal(first.manifest.methods[0].opcode, (1n << 127n).toString());
  assert.equal(first.manifest.incomingAssets, "reject");
  assert.match(first.lowered, /if \(opcode === 170141183460469231731687303715884105728n\)/);
  assert.doesNotMatch(first.lowered, /new Contract|\.method\(/);
});

test("initializers prove required ID state and reject lifecycle/accounting bypasses", () => {
  const id = '@state({key:"/authority"}) private authority!:AlkaneId; ';
  for (const [body, extra, error] of [
    [id+'@view({opcode:1}) get():AlkaneId{return this.authority;}', '', /needs @init/],
    [id+'@init({opcode:0}) start(a:AlkaneId):void {}', '', /every successful path/],
    [id+'@init({opcode:0}) start(a:AlkaneId, n:u128):void {if(n>0n)this.authority=a;}', '', /every successful path/],
    [id+'@init({opcode:0}) start(a:AlkaneId):void {return;this.authority=a;}', '', /every successful path/],
    ['@init({opcode:0}) a():void{} @init({opcode:1}) b():void{}', '', /only one @init/],
    ['@init({opcode:0}) start():void{} @method({opcode:1}) reset():void{this.start();}', '', /guarded entrypoint/],
    ['@state({key:"/__alkanes/init"}) x:u128=0n;@init({opcode:0}) start():void{}', '', /reserved/],
    ['@init({opcode:0}) start():void{const p=new StoragePointer("/x");}', 'import {StoragePointer} from "../../sdk/index.ts";', /raw storage/],
    ['@init({opcode:0}) start():void{const b=load(utf8("/__alkanes/init"));b[0]=0;}', 'import {load,utf8} from "../../sdk/index.ts";', /raw runtime calls bypass accounting/],
    ['@view({opcode:1,incomingAssets:"forward"}) get():void{}', '', /views reject/],
    [id+'@init({opcode:0}) start(a:AlkaneId):void{this.authority=a;} @view({opcode:1}) read():void{this.auth.require(this.authority);}', '', /mutating call this.auth.require/],
    ['@view({opcode:1}) read():void{this.assets.mintSelf(1n);}', '', /mutating call this.assets.mintSelf/],
    ['@method({opcode:1}) alter():void{this.assets["reconciliationFailed"]=false;}', '', /computed access/],
  ]) assert.throws(()=>compile(body,extra),error);
  const result=compile(id+'@init({opcode:0}) start(a:AlkaneId,n:u128):void{if(n===0n)throw new Error("bad");this.authority=a;} @view({opcode:2}) read():AlkaneId{return this.authority;}');
  assert.equal(result.manifest.initialized,true);
  assert.equal(result.manifest.state[0].type,'AlkaneId');
  assert.equal(result.manifest.state[0].default,null);
  assert.deepEqual(result.manifest.methods[0].params,[{name:'a',type:'AlkaneId'},{name:'n',type:'u128'}]);
  assert.match(result.lowered,/new __alk_AlkaneId\(__alk_arg0, __alk_arg1\)/);
  assert.match(result.lowered,/context.inputs.length < 4/);
});

test("generated client types reject wrong arguments and keep views out of prepare", () => {
  const manifest = compileContract({ filename: resolve("contracts/counter/index.ts") }).manifest;
  const clientFile = join(directory, "CounterClient.ts");
  writeFileSync(clientFile, generateClient(manifest, resolve("client/runtime.ts")));
  writeFileSync(join(directory, "CappedTokenClient.ts"), generateClient(compileContract({filename:resolve("contracts/capped-token/index.ts")}).manifest, resolve("client/runtime.ts")));
  const consumer = join(directory, "consumer.ts");
  writeFileSync(consumer, `import {CounterClient} from "./CounterClient.ts";
import {CappedTokenClient} from "./CappedTokenClient.ts";
const client = new CounterClient({simulate: async () => ({data:new Uint8Array(16),alkanes:[]})}, {block:2n,tx:1n});
const count: Promise<bigint> = client.read.getCount();
const simulated: Promise<{value:bigint;data:Uint8Array;alkanes:unknown[]}> = client.simulate.increment({by:1n});
client.prepare.increment({by:1n});
// @ts-expect-error this entrypoint rejects incoming assets
client.call.increment({by:1n}).withAssets([]);
// @ts-expect-error u128 client arguments are bigint
client.prepare.increment({by:1});
// @ts-expect-error methods cannot be read as views
client.read.increment({by:1n});
// @ts-expect-error views cannot be prepared for submission
client.prepare.getCount();
const token = new CappedTokenClient({simulate: async () => ({data:new Uint8Array(32),alkanes:[]})}, {block:2n,tx:1n});
const authority: Promise<{block:bigint;tx:bigint}> = token.read.getAuthority();
token.call.mint({amount:1n}).withAssets([{id:{block:4n,tx:9001n},value:1n}]);
const deployment = CappedTokenClient.deploy({simulate: async () => ({data:new Uint8Array(),alkanes:[]})}, new Uint8Array(), {authority:{block:4n,tx:9001n},cap:100n});
// @ts-expect-error initializer rejects incoming assets
deployment.withAssets([]);
// @ts-expect-error AlkaneId requires both u128 limbs
token.call.initialize({authority:{block:4n},cap:100n});
// @ts-expect-error AlkaneId limbs must be bigint
token.call.initialize({authority:{block:4n,tx:9001},cap:100n});
`);
  const program = ts.createProgram([consumer], { target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.ES2022,
    moduleResolution:ts.ModuleResolutionKind.Bundler, strict:true, noEmit:true, allowImportingTsExtensions:true, skipLibCheck:true, types:[] });
  assert.deepEqual(ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
});

// Runtime backstops and clients run their actual emitted TS, not mocks of it.
const directory = mkdtempSync(join(tmpdir(), "alkanes-frontend-"));
after(() => rmSync(directory, { recursive: true, force: true }));
const transpile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
for (const file of readdirSync("sdk").filter((f) => f.endsWith(".ts"))) {
  writeFileSync(join(directory, file.replace(/\.ts$/, ".mjs")), transpile(readFileSync(join("sdk", file), "utf8")).replace(/(["']\.\/.+)\.ts(["'])/g, "$1.mjs$2"));
}
test("self auth requires an original incoming asset, not self issuance or a changed context", async () => {
  const {Assets,Auth} = await import(pathToFileURL(join(directory,"assets.mjs")));
  const {AlkaneId,AlkaneTransferParcel,Context} = await import(pathToFileURL(join(directory,"types.mjs")));
  const self = new AlkaneId(2n,1n);
  const incoming = new AlkaneTransferParcel();
  const assets = new Assets(new Context(self,self,0n,incoming,[]));
  assets.mintSelf(1n);
  incoming.pay(self,1n);
  assert.throws(()=>new Auth(assets).require(self), /AUTH_ASSET_REQUIRED/);
  const valid = new Assets(new Context(self,self,0n,new AlkaneTransferParcel().pay(self,1n),[]));
  valid.mintSelf(1n);
  assert.doesNotThrow(()=>new Auth(valid).require(self));
  assert.equal(valid.finish(new Uint8Array()).alkanes.transfers[0].value,2n);
});
test("runtime guards reject writes and mutating host calls in read-only mode", async () => {
  const effects = await import(pathToFileURL(join(directory, "effects.mjs")));
  const runtime = await import(pathToFileURL(join(directory, "runtime.mjs")));
  const host = await import(pathToFileURL(join(directory, "host.mjs")));
  let calls = 0;
  globalThis.__alk_extcall = () => { calls++; return 0; };
  effects.setReadOnly(true);
  assert.throws(() => runtime.store(new Uint8Array(), new Uint8Array()), /view cannot mutate/);
  for (const kind of [0, 1]) assert.throws(() => host.hostExtcall(kind, new Uint8Array(), new Uint8Array(), new Uint8Array(), 100), /view cannot mutate/);
  assert.equal(calls, 0);
  host.hostExtcall(2, new Uint8Array(), new Uint8Array(), new Uint8Array(), 100);
  assert.equal(calls, 1);
  runtime.resetStorage();
  assert.doesNotThrow(() => runtime.store(new Uint8Array(), new Uint8Array()));
  delete globalThis.__alk_extcall;
});

test("generated Counter client reads, simulates without committing, and prepares exact cellpacks", async () => {
  const counter = compileContract({ filename: resolve("contracts/counter/index.ts") });
  const client = generateClient(counter.manifest, resolve("client/runtime.ts"));
  writeFileSync(join(directory, "client-runtime.mjs"), transpile(readFileSync("client/runtime.ts", "utf8")));
  writeFileSync(join(directory, "CounterClient.mjs"), transpile(client).replace(JSON.stringify(resolve("client/runtime.ts")), '"./client-runtime.mjs"'));
  const { CounterClient } = await import(pathToFileURL(join(directory, "CounterClient.mjs")));
  const vm = new AlkanesVM();
  const target = { block: 2n, tx: 1n };
  vm.deploy(target, readFileSync("dist/counter.wasm"));
  const api = new CounterClient({ simulate: async (request) => vm.simulate(request) }, target);
  assert.equal(await api.read.getCount(), 0n);
  assert.deepEqual(vm.storage, new Map());
  const simulation = await api.simulate.increment({ by: 7n });
  assert.equal(simulation.value, 7n);
  assert.equal(u128.decode(simulation.data), 7n);
  assert.deepEqual(simulation.alkanes, []);
  assert.equal(await api.read.getCount(), 0n);
  const prepared = api.prepare.increment({ by: 7n });
  assert.deepEqual(prepared.inputs, [1n, 7n]);
  assert.deepEqual(prepared.cellpack, u128.list([2n, 1n, 1n, 7n]));
  vm.call(prepared);
  assert.equal(await api.read.getCount(), 7n);
  assert.throws(() => api.prepare.increment({ by: -1n }), /u128/);
  assert.throws(() => api.prepare.increment({ by: 1n << 128n }), /u128/);
  assert.equal(api.read.increment, undefined);
  assert.equal(api.prepare.getCount, undefined);
});
