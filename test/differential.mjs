// Shared bigint-vs-word differential harness for the word-v1 extension tests.
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {compileContract} from '../compiler/index.mjs';
import {buildLibrary} from '../scripts/build.mjs';
import {AlkanesVM} from './vm.mjs';

export const MAX=(1n<<128n)-1n;
export const inc=(...pairs)=>pairs.map(([id,value])=>({id,value:BigInt(value)}));
export const ids=(...list)=>list.flatMap(id=>[id.block,id.tx]);

// Builds `filename` with wordLowering false and true: [bigint, word-v1].
export function buildPair(name,filename){
 return [false,true].map(wordLowering=>{
  const compiled=compileContract({filename:resolve(filename),wordLowering});
  assert.equal(compiled.manifest.lowering,wordLowering?'word-v1':'bigint');
  const work=resolve('build/word-custody-tests',`${name}-${wordLowering?'word':'bigint'}`);mkdirSync(work,{recursive:true});
  const entry=join(work,'entry.ts'),out=join(work,'probe.wasm');writeFileSync(entry,compiled.lowered);
  buildLibrary({entry,work,out,word:compiled.word});
  return {binary:readFileSync(out),work};
 });
}

const outcome=(vm,request)=>{
 try{const r=vm.call(request);return {alkanes:r.alkanes,data:Buffer.from(r.data).toString('hex')};}
 catch(e){return {error:e.message};}
};
const show=value=>JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);

// Runs [request, expectation] steps on fresh bigint and word VMs and requires
// identical responses (alkanes + data) or revert messages, and (with state)
// identical committed storage and host balances after every call. An
// expectation is 'ok', a RegExp for the revert message, or null (either).
// A step's optional before(vm) runs on both VMs first (e.g. to corrupt state),
// and setup(vm) prepares each VM once after the target is deployed.
export function differential(pair,target,steps,options={},{state=true,setup}={}){
 const vms=pair.map(({binary})=>{const vm=new AlkanesVM(options);vm.deploy(target,binary);setup?.(vm);return vm;});
 const results=[];
 for(const [i,[step,expected]] of steps.entries()){
  const [reference,word]=vms.map(vm=>{step.before?.(vm);return outcome(vm,{target,...step});});
  assert.deepEqual(word,reference,`step ${i} ${show(step)}`);
  if(expected==='ok')assert.ok(!reference.error,`step ${i} expected success: ${reference.error}`);
  else if(expected)assert.match(reference.error??'',expected,`step ${i} ${show(step)}`);
  if(state){
   assert.deepEqual(vms[1].snapshot(),vms[0].snapshot(),`storage after step ${i}`);
   assert.deepEqual(vms[1].balances,vms[0].balances,`balances after step ${i}`);
  }
  results.push(reference);
 }
 assert.deepEqual(vms[1].snapshot(),vms[0].snapshot());assert.deepEqual(vms[1].balances,vms[0].balances);
 return results;
}

// Deterministic xorshift64; values mix limb-boundary digits, widths and near-power-of-two shapes.
export function generator(seed){
 let s=BigInt(seed);
 const next=()=>{s^=(s<<13n)&0xffff_ffff_ffff_ffffn;s^=s>>7n;s^=(s<<17n)&0xffff_ffff_ffff_ffffn;return s;};
 const special=[0n,1n,2n,0x7fff_ffffn,0x8000_0000n,0xffff_fffen,0xffff_ffffn];
 const limb=()=>{const r=next(),k=Number(r&15n);return k<special.length?special[k]:(r>>8n)&0xffff_ffffn;};
 return ()=>{
  const shape=Number(next()%6n);
  if(shape===5){const bits=next()%129n;const v=(1n<<bits)-1n-(next()%3n);return v<0n?0n:v;}
  let v=0n;for(let i=0;i<=shape&&i<4;i++)v|=limb()<<BigInt(32*i);return v&MAX;
 };
}
