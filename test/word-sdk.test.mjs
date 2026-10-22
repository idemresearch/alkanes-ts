import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {compileContract} from '../compiler/index.mjs';
import {buildLibrary} from '../scripts/build.mjs';
import {AlkanesVM,u128} from './vm.mjs';
const MAX=(1n<<128n)-1n,target={block:2n,tx:1n};
const binaries=[];
for(const wordLowering of [false,true]){
  const compiled=compileContract({filename:resolve('test/fixtures/word-sdk.ts'),wordLowering});
  assert.equal(compiled.word,wordLowering?'sdk':false);
  const work=resolve('build/word-sdk-tests',wordLowering?'word':'bigint');mkdirSync(work,{recursive:true});
  const entry=join(work,'entry.ts'),out=join(work,'probe.wasm');writeFileSync(entry,compiled.lowered);buildLibrary({entry,work,out,word:compiled.word});binaries.push(readFileSync(out));
}
test('SDK words match bigint Wasm for wide multiplication, IEEE rounding, raw state and logging',()=>{
  const outputs=binaries.map(binary=>{
    const vm=new AlkanesVM({height:900123n});vm.deploy(target,binary);const call=inputs=>vm.call({target,inputs});
    const responses=[];
    let seed=0x123456789n;const next=()=>{seed=(seed*6364136223846793005n+1442695040888963407n)&MAX;return seed;};
    for(const [a,b]of [[0n,MAX],[1n,MAX],[(1n<<64n)-1n,(1n<<64n)-1n],...Array.from({length:50},()=>[next(),next()&0xffn])]){
      const expected=a*b;
      if(expected>MAX)assert.throws(()=>call([0,a,b]),/u128 overflow/);
      else{const response=call([0,a,b]);assert.equal(u128.decode(response.data),expected);responses.push(response);}
    }
    const values=[0n,1n,(1n<<53n)-1n,(1n<<53n)+1n,(1n<<53n)+3n,(1n<<64n)-1n,(1n<<96n)+5n,(1n<<127n)+1n,MAX,...Array.from({length:100},next)];
    for(const a of values){const expected=BigInt(Number(a));if(expected>MAX)assert.throws(()=>call([1,a]),/u128 overflow/);else{const response=call([1,a]);assert.equal(u128.decode(response.data),expected);responses.push(response);}}
    for(const a of [0n,MAX,1n<<96n]){responses.push(call([2,a]));responses.push(call([3]));}
    responses.push(call([4]));assert.deepEqual(vm.logs,['height 900123']);return{responses,storage:vm.snapshot()};
  });assert.deepEqual(outputs[1],outputs[0]);
});
test('production Counter and legacy Token select the word SDK without source-specific templates',()=>{
  for(const name of ['counter','token']){
    const filename=resolve('contracts',name,'index.ts');assert.equal(compileContract({filename,wordLowering:true}).word,'sdk');
    const source=readFileSync(filename,'utf8').replace('class Counter','class RenamedCounter').replace('"TypeScriptToken"','"RenamedToken"').replace('"/count"','"/renamed"').replace('"/totalsupply"','"/renamed"');
    assert.equal(compileContract({filename,source,wordLowering:true}).word,'sdk');
  }
});
test('opaque word/byte values cannot change source truthiness or string semantics',()=>{
  const filename=resolve('test/fixtures/sdk-fallback.ts');
  for(const body of ['@view({opcode:0}) read(a:u128):u128{if(a)return 1n;return 0n;}','@view({opcode:0}) read(a:u128):u128{return a?1n:0n;}','private readonly label="π";@view({opcode:0}) read():u128{return BigInt(this.label.length);}','@view({opcode:0}) read(a:u128):u128{switch(a){case 0n:return 1n;default:return 2n;}}']){
    const source='import {Contract,view,type u128} from "../../sdk/authoring.ts";export default class Probe extends Contract{'+body+'}';
    assert.equal(compileContract({filename,source,wordLowering:true}).word,false);
  }
});
test('static fluent lowering proves input access and rejects module-time host effects',()=>{
  const filename=resolve('test/fixtures/sdk-fallback.ts');
  for(const suffix of ['const h=height();export default new Contract("X").method(0,"read",[],"u128",()=>new CallResponse().withU128(h));','export default new Contract("X").method(0,"read",[param("a")],"u128",(_ctx,args)=>new CallResponse().withU128(args.u128(1)));','export default new Contract("X").method(0,"read",[param("a")],"u128",(_ctx,args)=>new CallResponse().withU128(args.id(0).tx));']){
    const source='import {Contract,CallResponse,param,height} from "../../sdk/index.ts";'+suffix;
    assert.equal(compileContract({filename,source,wordLowering:true}),null);
  }
});
