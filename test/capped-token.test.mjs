import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {test,after} from 'node:test';
import ts from 'typescript';
import {AlkanesVM,u128} from './vm.mjs';
import {buildLibrary} from '../scripts/build.mjs';

const fixtureWork=resolve('build/test-auth');mkdirSync(fixtureWork,{recursive:true});
writeFileSync(join(fixtureWork,'entry.ts'),`import contract from ${JSON.stringify(resolve('test/fixtures/test-auth.ts'))};
import {executeContract,contractMeta} from ${JSON.stringify(resolve('sdk/contract.ts'))};
export function execute(context:Uint8Array):Uint8Array{return executeContract(contract,context);}
export function meta():Uint8Array{return contractMeta(contract);}`);
buildLibrary({entry:join(fixtureWork,'entry.ts'),work:fixtureWork,out:join(fixtureWork,'auth.wasm')});

const target={block:2n,tx:1n},authority={block:4n,tx:9001n};
const incoming=[{id:authority,value:1n}];
const MAX=(1n<<128n)-1n;
const setup=(mode=0)=>{
 const vm=new AlkanesVM();
 vm.deploy(target,readFileSync('dist/capped-token.wasm'));
 vm.deploy(authority,readFileSync(join(fixtureWork,'auth.wasm')));
 vm.call({target:authority,inputs:[0,mode]});return vm;
};
const initialize=(vm,cap=100n)=>vm.call({target,inputs:[0,authority.block,authority.tx,cap]});
const supply=vm=>u128.decode(vm.call({target,inputs:[101]}).data);

test('CappedToken initialization gates every method/view, preserves typed IDs and rolls back failed init',()=>{
 const vm=setup();
 for(const inputs of [[77,1],[101],[102],[103]])assert.throws(()=>vm.call({target,inputs}),/NOT_INITIALIZED/);
 assert.throws(()=>initialize(vm,0n),/INVALID_CAP/);
 initialize(vm);
 assert.throws(()=>initialize(vm),/ALREADY_INITIALIZED/);
 assert.deepEqual(vm.call({target,inputs:[102]}).data,u128.list([authority.block,authority.tx]));
 assert.equal(u128.decode(vm.call({target,inputs:[103]}).data),100n);
 assert.equal(supply(vm),0n);
});

test('CappedToken invokes auth Wasm, forwards remaining balances and merges self issuance',()=>{
 const vm=setup();initialize(vm);
 assert.throws(()=>vm.call({target,inputs:[77,5]}),/AUTH_ASSET_REQUIRED/);
 assert.throws(()=>vm.call({target,inputs:[77,5],incoming:[{id:authority,value:0n}]}),/AUTH_ASSET_REQUIRED/);
 const extra={id:{block:2n,tx:99n},value:7n};
 const result=vm.call({target,inputs:[77,5],incoming:[...incoming,extra,{id:authority,value:2n},{id:target,value:3n}]});
 assert.equal(u128.decode(result.data),5n);
 assert.deepEqual(result.alkanes,[{id:authority,value:3n},extra,{id:target,value:8n}]);
 assert.equal(u128.decode(vm.call({target:authority,inputs:[2]}).data),1n);
 assert.equal(supply(vm),5n);
});

test('CappedToken rolls back successful auth effects on cap/amount failures and failed authentication',()=>{
 for(const mode of [0,1,2]){
  const vm=setup(mode);initialize(vm);
  const expected=mode===1?/AUTH_REJECTED/:mode===2?/AUTH_FAILURE/:/CAP_EXCEEDED/;
  assert.throws(()=>vm.call({target,inputs:[77,101],incoming}),expected);
  assert.equal(supply(vm),0n);
  assert.equal(u128.decode(vm.call({target:authority,inputs:[2]}).data),0n);
 }
 const vm=setup();initialize(vm,MAX);
 assert.throws(()=>vm.call({target,inputs:[77,0],incoming}),/INVALID_AMOUNT/);
 assert.equal(supply(vm),0n);
 vm.call({target,inputs:[77,MAX],incoming});
 assert.throws(()=>vm.call({target,inputs:[77,1],incoming}),/CAP_EXCEEDED/);
 assert.equal(supply(vm),MAX);
});

test('CappedToken blocks auth-contract reentry and rejects assets on views and initialization',()=>{
 const vm=setup(3);initialize(vm);
 assert.throws(()=>vm.call({target,inputs:[77,5],incoming}),/Extcall failed.*ALKANES: revert/);
 assert.equal(supply(vm),0n);
 assert.equal(u128.decode(vm.call({target:authority,inputs:[2]}).data),0n);
 assert.throws(()=>vm.call({target,inputs:[101],incoming}),/rejects incoming assets/);
 assert.throws(()=>vm.call({target,inputs:[0,4,9001,100],incoming}),/rejects incoming assets/);
});

const directory=mkdtempSync(join(tmpdir(),'alkanes-capped-client-'));
after(()=>rmSync(directory,{recursive:true,force:true}));
const transpile=s=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
writeFileSync(join(directory,'runtime.mjs'),transpile(readFileSync('client/runtime.ts','utf8')));
writeFileSync(join(directory,'client.mjs'),transpile(readFileSync('dist/CappedTokenClient.ts','utf8')).replace(JSON.stringify(resolve('client/runtime.ts')),'"./runtime.mjs"'));
const {CappedTokenClient}=await import(pathToFileURL(join(directory,'client.mjs')));

test('generated CappedToken plans encode IDs, retain assets and simulate without committing',async()=>{
 const vm=setup();initialize(vm);
 const transport={simulate:async request=>vm.simulate(request)};
 const client=new CappedTokenClient(transport,target);
 assert.deepEqual(await client.read.getAuthority(),authority);
 const assets=[{id:{...authority},value:1n}];
 const bare=client.call.mint({amount:5n});
 const plan=bare.withAssets(assets);assets[0].value=99n;
 assert.equal(bare.prepare().incoming,undefined);
 assert.equal(plan.prepare().incoming[0].value,1n);
 assert.deepEqual(plan.prepare().cellpack,u128.list([2n,1n,77n,5n]));
 const preview=await plan.simulate();assert.equal(preview.value,5n);assert.equal(preview.alkanes[1].value,5n);
 assert.equal(await client.read.totalSupply(),0n);
 const built=await plan.build({wallet:'wallet',builder:{build:async(request,wallet)=>({request,wallet})}});
 assert.equal(built.wallet,'wallet');assert.equal(built.request.incoming[0].value,1n);
 const wasm=Buffer.from([0,97,115,109]);
 const deployPlan=CappedTokenClient.deploy(transport,wasm,{authority,cap:100n});
 wasm[0]=99;
 const deployment=deployPlan.prepare();
 assert.equal(deployment.wasm[0],0);
 deployment.wasm[0]=88;
 assert.equal(deployPlan.prepare().wasm[0],0);
 assert.throws(()=>deployPlan.withAssets([]),/rejects incoming assets/);
 assert.throws(()=>deployPlan.withAssets(incoming),/rejects incoming assets/);
 assert.deepEqual(deployment.target,{block:1n,tx:0n});
 assert.deepEqual(deployment.inputs,[0n,4n,9001n,100n]);assert.ok(deployment.wasm.length>0);
 assert.equal(client.call.totalSupply,undefined);
});
