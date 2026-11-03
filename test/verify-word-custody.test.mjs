// Independent adversarial verification of the word-v1 custody / wide-math
// extension against the bigint backend (fresh probes, seeds and vectors).
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {test} from 'node:test';
import {compileContract} from '../compiler/index.mjs';
import {MAX,inc,ids,buildPair,differential} from './differential.mjs';
import {nearMiss,header} from './fixtures/verify-nearmiss.mjs';

const target={block:2n,tx:50n},t0={block:2n,tx:1n},t1={block:2n,tx:2n},other={block:2n,tx:3n},rich={block:2n,tx:4n};
const setup=vm=>{vm.setBalance(target,t0,1000n);vm.setBalance(target,t1,500n);vm.setBalance(target,rich,MAX);};

// xorshift64* with seeds unrelated to the author's tests.
function rng(seed){let s=BigInt(seed);return ()=>{s^=s>>12n;s^=(s<<25n)&0xffff_ffff_ffff_ffffn;s^=s>>27n;return (s*0x2545_f491_4f6c_dd1dn)&0xffff_ffff_ffff_ffffn;};}

test('verify: custody probe matches bigint (scripted adversarial steps + 400 random steps)',()=>{
 const pair=buildPair('verify-custody','test/fixtures/verify-custody.ts');
 const steps=[
  [{before:setup,inputs:[1,...ids(t0,t1)]},'ok'],
  // duplicates, zero entries and the contract's own ID in the incoming parcel
  [{inputs:[1,...ids(t0,t1)],incoming:inc([t0,3],[target,5],[t0,4],[target,0],[t1,0])},'ok'],
  [{inputs:[1,...ids(target,t1)],incoming:inc([target,2])},/SELF_CUSTODY_UNSUPPORTED/],
  [{inputs:[1,...ids(t0,target)]},/SELF_CUSTODY_UNSUPPORTED/],
  [{inputs:[1,...ids(other,other)]},'ok'],                        // never-set balance: empty bytes -> 0
  [{inputs:[1,...ids(rich,t0)],incoming:inc([rich,0])},'ok'],
  // held after retain / mintSelf / send, ledger order
  [{inputs:[2,...ids(t0,t1),3],incoming:inc([t0,10])},'ok'],
  [{inputs:[2,...ids(t0,t0),5],incoming:inc([t0,10],[t1,1])},'ok'],
  [{inputs:[2,...ids(t1,t0),7],incoming:inc([other,1],[t1,2],[t0,1])},'ok'],
  [{inputs:[2,...ids(t0,target),1],incoming:inc([t0,1])},/SELF_CUSTODY_UNSUPPORTED/],
  [{inputs:[2,...ids(target,t1),4],incoming:inc([target,10])},/SELF_CUSTODY_UNSUPPORTED/],
  [{inputs:[2,...ids(other,t1),MAX],incoming:inc([target,1])},/u128 overflow/],
  [{inputs:[2,...ids(other,t1),0]},'ok'],
  // retaining own incoming tokens
  [{inputs:[3,4],incoming:inc([target,10])},'ok'],[{inputs:[3,11],incoming:inc([target,10])},/INSUFFICIENT_LEDGER/],
  [{inputs:[3,11],incoming:inc([target,5],[target,6])},'ok'],[{inputs:[3,0]},'ok'],
  // first failure wins, nothing after it happens
  [{inputs:[4,...ids(t0),2,3,0]},/u128 division by zero/],[{inputs:[4,...ids(t0),2,3,1]},'ok'],
  [{inputs:[4,...ids(t0),1n<<64n,1n<<64n,1]},/u128 overflow/],[{inputs:[4,...ids(t0),MAX,2,1]},/u128 overflow/],
  [{inputs:[4,...ids(t0),5,1_000_000,1]},/INSUFFICIENT_CUSTODY/],[{inputs:[4,...ids(t0),3,5,5]},/INSUFFICIENT_LEDGER/],
  [{inputs:[4,...ids(target),3,5,5]},/SELF_SEND_USE_MINT_SELF/],
  [{inputs:[5,10,3,7]},/BOOM/],[{inputs:[5,13,3,0]},/THIRTEEN/],[{inputs:[5,5,3,0]},/u128 division by zero/],
  [{inputs:[5,3,3,5]},/u128 underflow/],[{inputs:[5,MAX,2,1]},/u128 overflow/],[{inputs:[5,MAX,1,1]},null],
  [{inputs:[5,100,MAX,3]},null],[{inputs:[5,1n<<100n,1n<<27n,(1n<<64n)+1n]},null],
  // AlkaneId ternaries into send / held
  [{inputs:[6,1,...ids(t0),1]},/SELF_SEND_USE_MINT_SELF/],[{inputs:[6,2,...ids(t0),1]},/SELF_CUSTODY_UNSUPPORTED/],
  [{inputs:[6,0,...ids(t0),1]},'ok'],[{inputs:[6,0,...ids(other),1]},/INSUFFICIENT_CUSTODY/],
  // read-only views
  [{inputs:[7,...ids(t0,t1)]},'ok'],[{inputs:[7,...ids(target,t1)]},/SELF_CUSTODY_UNSUPPORTED/],
  [{inputs:[7,...ids(rich,t1)]},/u128 overflow/],[{inputs:[7,...ids(t0,t1)],incoming:inc([t0,1])},/rejects incoming assets/],
  // short-circuit helpers with custody effects
  [{inputs:[8,...ids(t0,t1),5]},'ok'],[{inputs:[8,...ids(other,t1),5]},'ok'],[{inputs:[8,...ids(other,other),5]},'ok'],
  [{inputs:[9,...ids(t0,t1),5]},'ok'],[{inputs:[9,...ids(other,t1),5]},'ok'],[{inputs:[9,...ids(t0,target),1]},/SELF_CUSTODY_UNSUPPORTED/],
  // arena growth: 1024 helper leaves, each with a host balance query and wide math
  [{inputs:[10,...ids(t0),1n<<40n],incoming:inc([t0,100])},'ok'],[{inputs:[10,...ids(other),3]},'ok'],
  [{inputs:[10,...ids(t0),MAX-20n]},/u128 overflow/],
  // zero-value ledger entries and their positions
  [{inputs:[11,...ids(t0,t1),3],incoming:inc([t1,5],[t0,2])},'ok'],[{inputs:[11,...ids(t1,t0),4],incoming:inc([other,1])},'ok'],
  [{inputs:[11,...ids(other,t1),0]},'ok'],[{inputs:[11,...ids(t0,t0),2],incoming:inc([target,1],[t0,9])},'ok'],
  [{inputs:[12,1,...ids(t0)]},/SELF_CUSTODY_UNSUPPORTED/],[{inputs:[12,0,...ids(t0)]},'ok'],[{inputs:[12,0,...ids(target)]},/SELF_CUSTODY_UNSUPPORTED/],
  [{inputs:[13,...ids(t0),10,0],incoming:inc([t0,5])},/u128 division by zero/],[{inputs:[13,...ids(t0),10,3],incoming:inc([t0,5])},'ok'],
  [{inputs:[13,...ids(t0),10,3]},/INSUFFICIENT_LEDGER/],
  [{inputs:[14,...ids(t0,t1),4,0],incoming:inc([t1,9])},/u128 division by zero/],[{inputs:[14,...ids(t0,t1),14,7],incoming:inc([t1,9])},/BOOM/],
  [{inputs:[14,...ids(t0,t1),13,1],incoming:inc([t1,99])},/THIRTEEN/],[{inputs:[14,...ids(t0,t1),12,4],incoming:inc([t1,9])},'ok'],
  [{inputs:[14,...ids(t0,t1),40,4],incoming:inc([t1,9])},/INSUFFICIENT_LEDGER/],
  [{inputs:[15,...ids(t0,t1)]},'ok'],[{inputs:[15,...ids(t0,t0)]},'ok'],[{inputs:[15,MAX,0,0,MAX]},/u128 overflow/],
 ];
 // Random steps: every opcode, IDs including the contract itself, parcels with duplicates.
 const r=rng(0x5eed_1234_abcd_0001n);
 const pickN=n=>Number(r()%BigInt(n));
 const idPool=[t0,t1,other,rich,target];
 const amounts=()=>{const k=pickN(10);return k<4?BigInt(pickN(12)):k<6?r()%2000n:k===6?MAX:k===7?MAX-r()%3n:k===8?1n<<BigInt(pickN(128)):(r()<<64n|r())&MAX;};
 const id=()=>idPool[pickN(idPool.length)];
 const parcel=()=>{const n=pickN(4),out=[];for(let i=0;i<n;i++)out.push([id(),pickN(5)===0?amounts():BigInt(pickN(50))]);return inc(...out);};
 const arity={1:['id','id'],2:['id','id','u'],3:['u'],4:['id','u','u','u'],5:['u','u','u'],6:['u','id','u'],7:['id','id'],8:['id','id','u'],9:['id','id','u'],11:['id','id','u'],12:['u','id'],13:['id','u','u'],14:['id','id','u','u'],15:['id','id']};
 const views=new Set([5,7,12,15]);
 for(let i=0;i<400;i++){
  const ops=Object.keys(arity).map(Number),op=ops[pickN(ops.length)];
  const inputs=[op,...arity[op].flatMap(t=>t==='id'?ids(id()):[pickN(3)===0?amounts():BigInt(pickN(20))])];
  steps.push([{inputs,incoming:views.has(op)&&pickN(4)?[]:parcel()},null]);
 }
 const results=differential(pair,target,steps);
 const ok=results.filter(x=>!x.error).length;
 {const dist={};for(const x of results){const k=x.error?x.error.replace(/^.*Error: /,'').slice(0,40):'ok';dist[k]=(dist[k]??0)+1;}console.log('custody',JSON.stringify(dist));}
 assert.ok(ok>100&&results.length-ok>100,`coverage ok=${ok} err=${results.length-ok}`);
 // Without host balance movement: held underflow, duplicate-incoming overflow.
 differential(pair,target,[
  [{inputs:[1,...ids(t0,t1)],incoming:inc([t0,5])},/u128 underflow/],
  [{inputs:[1,...ids(t0,t1)],incoming:inc([t0,MAX],[t0,1])},/u128 overflow/],
  [{inputs:[3,1],incoming:inc([target,MAX],[target,1])},/u128 overflow/],
  [{before:vm=>vm.setBalance(target,t0,3n),inputs:[8,...ids(t0,t1),4],incoming:inc([t0,1])},null],
  [{inputs:[7,...ids(t0,t1)]},'ok'],
 ],{balances:false});
});

const sample=[0n,1n,2n,3n,7n,(1n<<64n)-1n,1n<<64n,(1n<<64n)+1n,1n<<127n,MAX-1n,MAX];
test('verify: near-miss syntax fails closed or compiles identically',()=>{
 const dir=resolve('build/verify-nearmiss');mkdirSync(dir,{recursive:true});
 const summary={error:0,fallback:0,word:0};
 for(const [i,[label,imports,body]] of nearMiss.entries()){
  const filename=join(dir,`case${i}.ts`),source=header(imports,body);writeFileSync(filename,source);
  const compile=w=>{try{return compileContract({filename,source,wordLowering:w});}catch(e){return {error:e};}};
  const big=compile(false),word=compile(true);
  // A source the bigint frontend rejects must also be rejected with word lowering on.
  assert.equal(!!big.error,!!word.error,`${label}: compile errors differ`);
  if(big.error){summary.error++;continue;}
  assert.equal(big.manifest.lowering,'bigint',label);
  if(word.manifest.lowering!=='word-v1'){summary.fallback++;continue;}
  summary.word++;
  const pair=buildPair(`verify-nm${i}`,filename);
  const m=word.manifest.methods[0],r=rng(0x77+i),steps=[];
  for(let k=0;k<60;k++){
   const inputs=[BigInt(m.opcode),...m.params.flatMap(p=>p.type==='AlkaneId'?ids([t0,t1,target,{block:MAX,tx:0n}][Number(r()%4n)]):[k<sample.length?sample[k]:sample[Number(r()%BigInt(sample.length))]])];
   steps.push([{inputs},null]);
  }
  differential(pair,{block:2n,tx:60n+BigInt(i)},steps);
 }
 assert.deepEqual(summary,{error:9,fallback:35,word:9},JSON.stringify(summary));
});

test('verify: wide math contract-level differential with new seeds and quotient-boundary vectors',()=>{
 const pair=buildPair('verify-math','test/fixtures/word-math.ts');
 const r=rng(0xfeed_face_0bad_c0den),steps=[];
 const rnd=()=>(r()<<64n|r())>>BigInt(Number(r()%128n));
 for(let i=0;i<120;i++){
  // a*b with d chosen so that the quotient lands on MAX or 2^128 exactly.
  const a=rnd()|1n,b=MAX-(r()%5n),P=a*b,d2=P>>128n,dm=P/MAX;
  for(const d of [d2,d2+1n,dm,dm+1n])if(d>0n&&d<=MAX)for(const op of [1,2])steps.push([{inputs:[op,a,b,d]},null]);
  const k=rnd()%((1n<<64n)-1n)+1n;
  steps.push([{inputs:[3,k-1n,k+1n]},null],[{inputs:[3,k,k+2n]},null],[{inputs:[4,k*k-1n]},null],[{inputs:[4,k*k]},null]);
  steps.push([{inputs:[10,rnd(),rnd(),rnd()%7n]},null],[{inputs:[11,rnd(),rnd(),r()%3n]},null],[{inputs:[12,rnd(),rnd(),rnd()]},null]);
 }
 for(const k of [MAX,MAX-1n,1n<<127n])steps.push([{inputs:[3,k,k]},null],[{inputs:[3,k-1n,k]},null]);
 const results=differential(pair,{block:2n,tx:31n},steps,{},{state:false});
 assert.ok(results.some(x=>x.error)&&results.some(x=>!x.error));
});

// __balance encodings the stock VM never produces: a short value (zero-extended
// by bytesToU128), a zero length over dirty bytes, and an over-long value whose
// first 16 bytes count. Both backends must decode the host buffer identically.
test('verify: __balance short, empty-but-dirty and over-long encodings decode identically',()=>{
 const pair=buildPair('verify-custody','test/fixtures/verify-custody.ts');
 let mode=null;
 const Original=WebAssembly.Instance;
 WebAssembly.Instance=function(module,imports){
  let instance;
  const env=imports?.env;
  if(env?.__balance){
   const inner=env.__balance;
   env.__balance=(who,what,out)=>{
    inner(who,what,out);
    if(!mode)return;
    const dv=new DataView(instance.exports.memory.buffer),bytes=new Uint8Array(instance.exports.memory.buffer);
    if(mode.kind==='short')dv.setUint32(out-4,Math.min(mode.n,dv.getUint32(out-4,true)),true);
    else if(mode.kind==='dirty'){bytes.fill(0xff,out,out+16);dv.setUint32(out-4,0,true);}
    else if(mode.kind==='long'){if(dv.getUint32(out-4,true)===0)bytes.fill(0,out,out+16);bytes.fill(0xee,out+16,out+20);dv.setUint32(out-4,20,true);}
   };
  }
  instance=new Original(module,imports);
  return instance;
 };
 try{
  const at=m=>vm=>{mode=m;};
  const steps=[[{before:vm=>{setup(vm);vm.setBalance(target,other,0x0102_0304_0506_0708_090a_0b0c_0d0e_0f10n);},inputs:[7,...ids(t0,t1)]},'ok']];
  for(const m of [{kind:'short',n:1},{kind:'short',n:5},{kind:'short',n:15},{kind:'dirty'},{kind:'long'},null]){
   steps.push([{before:at(m),inputs:[7,...ids(other,t1)]},null],[{before:at(m),inputs:[7,...ids(rich,t1)]},null],
    [{before:at(m),inputs:[1,...ids(other,t0)],incoming:inc([t0,3])},null],[{before:at(m),inputs:[8,...ids(other,t1),2]},null],
    [{before:at(m),inputs:[12,0,...ids(t1)]},null]);
  }
  const results=differential(pair,target,steps);
  assert.ok(results.filter(x=>!x.error).length>=15);
 }finally{WebAssembly.Instance=Original;mode=null;}
});

// The production contract that changes backend: long random AMM sessions
// (fresh seeds), including near-MAX reserves, duplicate/unrelated parcels,
// random slippage bounds and occasional storage corruption/repair.
test('verify: AmmPool random sessions match bigint call for call',()=>{
 const amm=buildPair('verify-amm','contracts/amm-pool/index.ts');
 const pool={block:2n,tx:70n},a={block:2n,tx:71n},b={block:2n,tx:72n},junk={block:2n,tx:73n};
 for(const [seed,scale] of [[0xa11ce_0001n,40n],[0xa11ce_0002n,100n],[0xa11ce_0003n,126n],[0xa11ce_0004n,64n]]){
  const r=rng(seed),n=k=>Number(r()%BigInt(k));
  const amt=()=>{const k=n(8);return k===0?0n:k===1?BigInt(n(3000)):k===2?MAX-r()%4n:k===3?1n<<BigInt(n(128)):((r()<<64n)|r())>>(128n-scale+BigInt(n(8)));};
  const steps=[[{inputs:[0,...ids(a,b)]},'ok']];
  for(let i=0;i<225;i++){
   const k=n(20);
   if(k<6){const parts=[[a,amt()],[b,amt()]];if(n(4)===0)parts.push([junk,BigInt(n(9))]);if(n(5)===0)parts.push([a,BigInt(n(100))]);steps.push([{inputs:[1,n(3)===0?amt():0n],incoming:inc(...parts)},null]);}
   else if(k<11){const parts=[[n(2)?a:b,amt()]];if(n(6)===0)parts.push([n(2)?a:junk,BigInt(n(50))]);steps.push([{inputs:[3,n(4)===0?amt():0n],incoming:inc(...parts)},null]);}
   else if(k<14){const parts=[[pool,n(3)?amt()>>BigInt(n(64)):BigInt(n(5000))]];if(n(5)===0)parts.push([a,BigInt(n(10))]);steps.push([{inputs:[2,n(5)===0?amt():0n,n(5)===0?amt():0n],incoming:inc(...parts)},null]);}
   else if(k<17)steps.push([{inputs:[[10,11,20,21,22,23,24][n(7)],amt()]},null]);
   else if(k===17&&scale===64n){const len=1+n(20),key=Buffer.from(['/reserve0','/supply','/reserve1'][i%3]).toString('hex');steps.push([{before:vm=>vm.storageOf(pool).set(key,new Uint8Array(len)),inputs:[3,0],incoming:inc([a,5])},null]);}
   else if(k===18&&scale===64n)steps.push([{before:vm=>vm.storageOf(pool).set(Buffer.from('/supply').toString('hex'),new Uint8Array(16).fill(0x11)),inputs:[22]},null]);
   else steps.push([{inputs:[n(2)?99:1,0]},null]);
  }
  const results=differential(amm,pool,steps);
  const ok=results.filter(x=>!x.error).length;
  assert.ok(ok>=20,`seed ${seed}: only ${ok} successful calls`);
  const dist={};for(const x of results){const k=x.error?x.error.replace(/^.*Error: /,'').slice(0,40):'ok';dist[k]=(dist[k]??0)+1;}console.log('AMM seed',seed.toString(16),JSON.stringify(dist));
 }
});
