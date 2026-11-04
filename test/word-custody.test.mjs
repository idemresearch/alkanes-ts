import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {test} from 'node:test';
import {compileContract} from '../compiler/index.mjs';
import {MAX,inc,ids,buildPair,differential} from './differential.mjs';

// The word-v1 custody extension must be observably identical to the general
// bigint backend: every response, revert message, committed storage map and
// host balance is compared after every call (see test/differential.mjs).
const t0={block:2n,tx:1n},t1={block:2n,tx:2n},other={block:2n,tx:3n};
const amm=buildPair('amm-pool','contracts/amm-pool/index.ts');
const custody=buildPair('custody','test/fixtures/word-custody.ts');

test('AmmPool word-v1 matches the bigint backend call for call, including every failure path',()=>{
 const pool={block:2n,tx:10n};
 const add=(a0,a1,min=0n,extra=[])=>({inputs:[1,min],incoming:[...inc([t0,a0],[t1,a1]),...extra]});
 const swap=(id,amount,min=0n,extra=[])=>({inputs:[3,min],incoming:[...inc([id,amount]),...extra]});
 const remove=(lp,min0=0n,min1=0n,extra=[])=>({inputs:[2,min0,min1],incoming:[...inc([pool,lp]),...extra]});
 const init=(a,b)=>({inputs:[0,...ids(a,b)]});
 const corrupt=(key,length)=>vm=>vm.storageOf(pool).set(Buffer.from(key).toString('hex'),new Uint8Array(length).fill(1));
 const steps=[
  [add(10n,10n),/NOT_INITIALIZED/],[swap(t0,5n),/NOT_INITIALIZED/],[{inputs:[20]},/NOT_INITIALIZED/],
  [init(t0,t0),/IDENTICAL_TOKENS/],[{...init(t0,t1),incoming:inc([t0,1])},/contract rejects incoming assets/],
  [{inputs:[0,...ids(t0),t1.block]},/initialize expects 4 inputs/],[init(t0,t1),'ok'],[init(t0,t1),/ALREADY_INITIALIZED/],
  [{inputs:[23]},'ok'],[{inputs:[24]},'ok'],[{inputs:[22]},'ok'],[{inputs:[10,1000]},'ok'],
  [swap(t0,1000n),/INSUFFICIENT_LIQUIDITY/],[add(1000n,1000n),/INSUFFICIENT_LIQUIDITY_MINTED/],
  [add(0n,1000n),/INSUFFICIENT_INPUT/],[{inputs:[1,0],incoming:inc([t1,1000])},/INSUFFICIENT_INPUT/],
  [add(1_000_000n,4_000_000n,1_999_001n),/SLIPPAGE/],[add(1_000_000n,4_000_000n),'ok'],
  [{inputs:[20]},'ok'],[{inputs:[21]},'ok'],[{inputs:[22]},'ok'],
  // Excess side and unrelated assets are refunded; duplicate entries are summed.
  [add(500n,3000n,0n,inc([other,7])),'ok'],[add(1000n,2000n),'ok'],
  [{inputs:[1,0],incoming:inc([t0,300],[t1,900],[t0,200],[t1,1100])},'ok'],[add(1000n,4000n,MAX),/SLIPPAGE/],
  [swap(t0,10_000n),'ok'],[swap(t1,50_000n),'ok'],
  [{inputs:[3,0],incoming:inc([t0,5],[t1,5])},/SINGLE_INPUT_REQUIRED/],[swap(other,5n),/SINGLE_INPUT_REQUIRED/],
  [{inputs:[3,0]},/SINGLE_INPUT_REQUIRED/],[swap(t1,1n),/INSUFFICIENT_OUTPUT_AMOUNT/],[swap(t0,1000n,MAX),/SLIPPAGE/],
  // amountIn * 997 overflows at MAX/997 + 1, in a method and in a view.
  [swap(t0,MAX),/balance overflow/],[swap(t0,2500n,0n,inc([other,9])),'ok'],
  [{inputs:[10,1000]},'ok'],[{inputs:[11,1000]},'ok'],[{inputs:[11,1]},'ok'],[{inputs:[10,0]},'ok'],
  [{inputs:[10,MAX]},'ok'],[{inputs:[11,MAX/997n+1n]},'ok'],
  [{inputs:[20],incoming:inc([t0,1])},/contract rejects incoming assets/],[{inputs:[23],incoming:inc([pool,1])},/rejects incoming assets/],
  [remove(999_000n,MAX),/SLIPPAGE/],[remove(999_000n,0n,MAX),/SLIPPAGE/],[remove(999_000n),'ok'],
  [{inputs:[2,0,0]},/INSUFFICIENT_INPUT/],[remove(1n),null],[remove(1000n,0n,0n,inc([t0,77],[other,1])),'ok'],
  [{inputs:[99]},/Unrecognized opcode 99/],[{inputs:[]},/No opcode provided/],[{inputs:[MAX]},/Unrecognized opcode/],
  [{inputs:[2,0]},/removeLiquidity expects 2 inputs/],
  // Multi-limb products and quotients (Knuth division paths) on real reserves.
  [add(1n<<100n,1n<<101n),'ok'],[swap(t1,1n<<99n),'ok'],[swap(t0,(1n<<118n)+12345n),'ok'],
  [{inputs:[10,1n<<117n]},'ok'],[{inputs:[11,1n<<100n]},'ok'],[{inputs:[10,1n<<100n]},'ok'],
  [{inputs:[22]},'ok'],[remove(1n<<90n),'ok'],[add((1n<<126n)+3n,7n),'ok'],[add(7n,1n<<127n),/INSUFFICIENT_LIQUIDITY_MINTED/],
  [remove(1n<<99n),'ok'],[{inputs:[20]},'ok'],[{inputs:[21]},'ok'],[{inputs:[22]},'ok'],
  // Malformed persisted state reports the field reached first, through ternaries and helpers.
  [{before:corrupt('/reserve0',1),inputs:[20]},/invalid u128 storage: \/reserve0/],
  [swap(t0,1000n),/invalid u128 storage: \/reserve0/],[swap(t1,1000n),/invalid u128 storage: \/reserve0/],
  [{inputs:[11,1000]},/invalid u128 storage: \/reserve0/],[remove(1000n),/invalid u128 storage: \/reserve0/],
  [{before:corrupt('/token1',5),inputs:[24]},/uninitialized or invalid AlkaneId state: \/token1/],
  [add(1000n,1000n),/uninitialized or invalid AlkaneId state: \/token1/],[{inputs:[23]},'ok'],
 ];
 const results=differential(amm,pool,steps);
 assert.ok(steps.length>=40);
 assert.ok(results.filter(r=>r.error).length>=20&&results.filter(r=>!r.error).length>=20);
});

test('custody leaves match the bigint SDK: held/received/retain/send/myself, errors and ledger order',()=>{
 const target={block:2n,tx:20n};
 const steps=[
  [{inputs:[1,...ids(t0)]},'ok'],[{inputs:[2]},/SELF_CUSTODY_UNSUPPORTED/],[{inputs:[11]},'ok'],
  [{inputs:[12,1,...ids(t0,t1)]},'ok'],[{inputs:[12,0,...ids(t0,t1)]},'ok'],
  [{inputs:[3,...ids(t0),5],incoming:inc([t0,10])},'ok'],[{inputs:[1,...ids(t0)]},'ok'],
  [{inputs:[3,...ids(t0),11],incoming:inc([t0,10])},/INSUFFICIENT_LEDGER/],
  [{inputs:[3,...ids(t1),0]},'ok'],[{inputs:[3,...ids(t1),1]},/INSUFFICIENT_LEDGER/],
  [{inputs:[4,...ids(t0),3]},'ok'],[{inputs:[4,...ids(t0),3]},/INSUFFICIENT_CUSTODY/],
  // Incoming assets are ledger, not custody.
  [{inputs:[4,...ids(t0),2],incoming:inc([t0,4])},'ok'],[{inputs:[4,...ids(t0),1],incoming:inc([t0,4])},/INSUFFICIENT_CUSTODY/],
  [{inputs:[4,...ids(other),0]},'ok'],[{inputs:[5,1]},/SELF_SEND_USE_MINT_SELF/],[{inputs:[5,0]},/SELF_SEND_USE_MINT_SELF/],
  [{inputs:[6,7]},'ok'],[{inputs:[6,7],incoming:inc([target,3])},'ok'],
  [{inputs:[3,...ids(t1),4],incoming:inc([t1,9])},'ok'],
  [{inputs:[7,...ids(t0,t1),3],incoming:inc([t0,1])},'ok'],[{inputs:[7,...ids(t0,other),2],incoming:inc([t0,1],[other,0])},'ok'],
  [{inputs:[7,...ids(t1,t0),5],incoming:inc([other,2])},'ok'],
  [{inputs:[8,...ids(t0),5,0],incoming:inc([t0,5])},/u128 division by zero/],
  [{inputs:[8,...ids(t0),12,2],incoming:inc([t0,5])},/INSUFFICIENT_LEDGER/],[{inputs:[8,...ids(t0),10,2],incoming:inc([t0,5])},'ok'],
  [{inputs:[9,...ids(t0),2],incoming:inc([t0,2])},/AFTER/],[{inputs:[9,...ids(t0),0]},'ok'],
  [{inputs:[10,...ids(t0,t1)],incoming:inc([t0,3])},'ok'],[{inputs:[10,...ids(t0,t1)],incoming:inc([t1,4],[other,1])},'ok'],
  [{inputs:[10,...ids(t0,t1)]},'ok'],[{inputs:[1,...ids(t0)],incoming:inc([t0,1])},/rejects incoming assets/],
  [{inputs:[1,...ids(t1)]},'ok'],[{inputs:[4,...ids(t1),MAX]},/INSUFFICIENT_CUSTODY/],
  [{inputs:[99]},/Unrecognized opcode 99/],[{inputs:[3,...ids(t0)]},/keep expects 3 inputs/],
 ];
 const results=differential(custody,target,steps);
 // The ledger keeps first-insertion order: incoming, the zero retain of t1, then self issuance.
 assert.deepEqual(results[20].alkanes,inc([t0,1],[t1,3],[target,3]));
 // Without host balance movement, held() underflows and duplicate incoming amounts overflow.
 differential(custody,target,[
  [{inputs:[4,...ids(t0),0],incoming:inc([t0,5])},/u128 underflow/],
  [{inputs:[3,...ids(t0),1],incoming:inc([t0,MAX],[t0,1])},/u128 overflow/],
  [{inputs:[1,...ids(t0)]},'ok'],
 ],{balances:false});
});

test('word-v1 extensions stay fail-closed and leave other contracts on their lowering',()=>{
 const filename=resolve('test/fixtures/word-choice.ts');
 const source=(imports,body)=>`import {Contract,view,method,type u128,type AlkaneId} from "../../sdk/authoring.ts";${imports}export default class c extends Contract {${body}}`;
 for(const [imports,body] of [
  ['import {mulDiv as md} from "../../sdk/u128.ts";','@view({opcode:0}) read(a:u128):u128{return md(a,a,1n);}'],
  ['import {wrappingAdd} from "../../sdk/u128.ts";','@view({opcode:0}) read(a:u128):u128{return wrappingAdd(a,1n);}'],
  ['','private f(a:u128):u128{if(a===0n)return 0n;return this.f(a-1n);}@view({opcode:0}) read(a:u128):u128{return this.f(a);}'],
  ['','private f(a:u128):u128{return this.g(a);}private g(a:u128):u128{if(a===0n)return 0n;return this.f(a-1n);}@view({opcode:0}) read(a:u128):u128{return this.f(a);}'],
  ['','private f(a:bigint):bigint{return a;}@view({opcode:0}) read(a:u128):u128{return this.f(a);}'],
  ['','@view({opcode:0}) read(a:u128):u128{a=a+1n;return a;}'],
  ['','@view({opcode:0}) read(a:u128):u128{let b=a;b<<=1n;return b;}'],
  ['','@view({opcode:0}) read(a:u128):u128{return this.get(a);}@view({opcode:1}) get(a:u128):u128{return a;}'],
  // Chain-query and external-call forms outside the subset: aliased or
  // shadowed imports, a non-literal fuel limit, and a call whose response is used.
  ['import {height as h} from "../../sdk/index.ts";','@view({opcode:0}) read():u128{return h();}'],
  ['import {height} from "../../sdk/index.ts";','@view({opcode:0}) read(height:u128):u128{return height;}'],
  ['import {height} from "../../sdk/runtime.ts";','@view({opcode:0}) read():u128{const height=1n;return height;}'],
  ['import {AlkaneId as Id} from "../../sdk/types.ts";','@view({opcode:0}) read():AlkaneId{return new Id(1n,2n);}'],
  ['import {Cellpack,AlkaneTransferParcel} from "../../sdk/types.ts";','@method({opcode:0,incomingAssets:"forward"}) m(id:AlkaneId,f:u128):void{this.assets.call(new Cellpack(id,[1n]),new AlkaneTransferParcel(),Number(f));}'],
  ['import {Cellpack,AlkaneTransferParcel} from "../../sdk/types.ts";','@method({opcode:0,incomingAssets:"forward"}) m(id:AlkaneId):u128{const r=this.assets.call(new Cellpack(id,[1n]),new AlkaneTransferParcel(),1000);return 0n;}'],
  ['import {Cellpack,AlkaneTransferParcel} from "../../sdk/types.ts";','@method({opcode:0,incomingAssets:"forward"}) m(id:AlkaneId):void{this.assets.call(new Cellpack(id,[1n]),new AlkaneTransferParcel(),1.5);}'],
 ])assert.notEqual(compileContract({filename,source:source(imports,body),wordLowering:true}).manifest.lowering,'word-v1',body);
 // AmmPool's and the vault, treasury and router's word-v1 selection is asserted by buildPair; Counter/Token by word-sdk.test.mjs.
 assert.equal(compileContract({filename:resolve('contracts/capped-token/index.ts'),wordLowering:true}).manifest.lowering,'word-v1');
});
