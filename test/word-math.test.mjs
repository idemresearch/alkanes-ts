import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {AlkanesVM,u128} from './vm.mjs';
import {MAX,buildPair,differential,generator} from './differential.mjs';

// Wide word-v1 arithmetic (mulDiv, mulDivUp, mulSqrt, sqrt, min, max, *, /, %)
// against the bigint backend, plus the C leaves directly against BigInt.
const math=buildPair('math','test/fixtures/word-math.ts');
const boundary=[0n,1n,3n,0xffff_ffffn,1n<<32n,(1n<<64n)-1n,(1n<<64n)+1n,(1n<<96n)-1n,1n<<127n,MAX];

test('wide arithmetic word-v1 matches bigint on full-width, limb-boundary and 320 random operand triples',()=>{
 const target={block:2n,tx:30n};
 const steps=[];
 for(const a of boundary){
  steps.push([{inputs:[4,a]},'ok']);
  for(const b of boundary){
   for(const op of [3,5,6,7,8,9])steps.push([{inputs:[op,a,b]},null]);
   for(const [op,d] of [[1,0n],[1,(1n<<64n)+1n],[2,MAX],[10,3n],[11,(1n<<64n)+1n],[12,MAX]])steps.push([{inputs:[op,a,b,d]},null]);
  }
 }
 const random=generator(0x9e37_79b9_7f4a_7c15n);
 for(let i=0;i<320;i++){
  const a=random(),b=random(),d=random();
  for(let op=1;op<=12;op++)steps.push([{inputs:[op,a,b,d]},null]);
 }
 const results=differential(math,target,steps,{},{state:false});
 const errors=new Set(results.filter(r=>r.error).map(r=>r.error.replace(/^.*Error: /,'')));
 assert.deepEqual([...errors].sort(),['u128 division by zero','u128 overflow']);
 assert.ok(results.filter(r=>!r.error).length>results.length/2);
 // Spot-check exact values, including the first failing operation winning.
 const vm=new AlkanesVM();vm.deploy(target,math[1].binary);
 const call=(...inputs)=>u128.decode(vm.call({target,inputs}).data);
 assert.equal(call(1,MAX,MAX,MAX),MAX);assert.equal(call(2,MAX,MAX-1n,MAX),MAX-1n);
 assert.equal(call(3,MAX,MAX),MAX);assert.equal(call(3,MAX,MAX-1n),MAX-1n);assert.equal(call(4,MAX),(1n<<64n)-1n);
 assert.throws(()=>call(2,MAX,MAX,MAX-1n),/u128 overflow/);
 assert.throws(()=>call(10,MAX,2n,0n),/u128 overflow/);
 assert.throws(()=>call(10,1n,2n,0n),/u128 division by zero/);
});

test('word.c wide arithmetic leaves match BigInt directly on 20,000 random operand triples',()=>{
 const memory=new WebAssembly.Memory({initial:256});
 let next=1<<20;
 const reserve=n=>{const p=next;next+=(n+23)&~15;new DataView(memory.buffer).setUint32(p,n,true);return p+4;};
 const module=new WebAssembly.Module(readFileSync(join(math[1].work,'word.wasm')));
 const imports={scriptc:{__adapter_reserve:reserve},env:{}};
 for(const i of WebAssembly.Module.imports(module)){
  if(i.kind==='memory')(imports[i.module]??={}).memory=memory;
  else if(i.module==='env')imports.env[i.name]=()=>0;
 }
 const w=new WebAssembly.Instance(module,imports).exports;
 const lit=v=>w.w_literal(...[0n,32n,64n,96n].map(s=>Number((v>>s)&0xffff_ffffn)));
 const read=p=>{const d=new DataView(memory.buffer);return d.getBigUint64(p,true)|(d.getBigUint64(p+8,true)<<64n);};
 const isqrt=n=>{if(n<2n)return n;let x=n,y=(x+1n)/2n;while(y<x){x=y;y=(x+n/x)/2n;}return x;};
 const checked=v=>v>MAX?'E2':v;
 const ops=[
  [0,(a,b,d)=>d?checked(a*b/d):'E13'],[1,(a,b,d)=>d?checked(a*b/d+(a*b%d?1n:0n)):'E13'],[2,(a,b)=>isqrt(a*b)],[3,a=>isqrt(a)],
  [4,(a,b)=>checked(a*b)],[5,(a,b)=>b?a/b:'E13'],[6,(a,b)=>b?a%b:'E13'],[7,(a,b)=>a<b?a:b],[8,(a,b)=>a>b?a:b],
 ];
 const random=generator(0x2545_f491_4f6c_dd1dn);
 for(let i=0;i<20_000;i++){
  const a=random(),b=random(),d=random();
  for(const [kind,ref] of ops){
   next=1<<20;const ctx=reserve(96);new Uint8Array(memory.buffer,ctx,96).fill(0);
   const c=w.w_begin(ctx,96,0),p=w.w_op3(c,kind,lit(a),lit(b),lit(d)),code=w.w_status(c);
   const got=code?'E'+code:read(p),want=ref(a,b,d);
   if(got!==want)assert.equal(got,want,`kind ${kind} ${a} ${b} ${d}`);
  }
 }
});
