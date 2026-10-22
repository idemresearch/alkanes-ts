import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {test} from 'node:test';
import {compileContract} from '../compiler/index.mjs';
import {buildLibrary} from '../scripts/build.mjs';
import {AlkanesVM,u128} from './vm.mjs';
const target={block:2n,tx:1n},id={block:(1n<<127n)+0x1122334455667788n,tx:(1n<<96n)+123n},MAX=(1n<<128n)-1n;
const binaries=[];
for(const wordLowering of [false,true]){
 const compiled=compileContract({filename:resolve('test/fixtures/word.ts'),wordLowering});
 assert.equal(compiled.word,wordLowering);
 const work=resolve('build/word-tests',wordLowering?'word':'bigint');mkdirSync(work,{recursive:true});
 const entry=join(work,'entry.ts'),out=join(work,'probe.wasm');writeFileSync(entry,compiled.lowered);
 buildLibrary({entry,work,out,word:compiled.word});binaries.push(readFileSync(out));
}
test('word lowering matches bigint Wasm for full-width arithmetic, defaults, IDs, selectors and rollback',()=>{
 const outputs=binaries.map(binary=>{
  const vm=new AlkanesVM();vm.deploy(target,binary);
  const call=inputs=>vm.call({target,inputs});
  assert.throws(()=>call([3]),/NOT_INITIALIZED/);
  call([0,id.block,id.tx]);const before=vm.snapshot();
  assert.equal(u128.decode(call([3]).data),17n);assert.deepEqual(vm.snapshot(),before);
  assert.deepEqual(call([4]).data,u128.list([id.block,id.tx]));
  const responses=[];
  for(const inputs of [[1,MAX-17n],[3],[2,MAX],[3],[1,1n<<64n],[1,1n<<96n],[7,MAX,MAX],[7,0,MAX],[7,MAX,0],[10,1n<<127n],[1n<<127n]])responses.push(call(inputs));
  for(const [inputs,error]of [[[1,MAX],/u128 overflow/],[[2,MAX],/u128 underflow/],[[5],/word rollback/],[[6],/u128 overflow/],[[11,2,1],/AUTH_ASSET_REQUIRED/],[[MAX],new RegExp('Unrecognized opcode '+MAX)]]){
   const saved=vm.snapshot();assert.throws(()=>call(inputs),error);assert.deepEqual(vm.snapshot(),saved);
  }
  // Exercise carries/borrows and immutable stored words across fresh instances.
  for(const value of [1n,255n,1n<<32n,1n<<53n,1n<<64n,1n<<96n,(1n<<127n)-1n]){
   const saved=u128.decode(call([3]).data);call([2,saved]);responses.push(call([1,value]));responses.push(call([2,value]));
  }
  for(const inputs of [[12,0],[12,1],[13,1n<<64n],[3]])responses.push(call(inputs));
  for(const [key,inputs,expected]of [['/value',[3],/invalid u128 storage: \/value/],['/identity',[4],/uninitialized or invalid AlkaneId state: \/identity/]]){
   const saved=vm.snapshot();vm.storageOf(target).set(Buffer.from(key).toString('hex'),new Uint8Array([1]));assert.throws(()=>call(inputs),expected);vm.storage=saved;
  }
  return {responses,storage:vm.snapshot()};
 });
 assert.deepEqual(outputs[1],outputs[0]);
});
test('untracked forwarding preserves duplicate and zero transfers exactly',()=>{
 const outputs=[];
 for(const wordLowering of [false,true]){
  const compiled=compileContract({filename:resolve('test/fixtures/word-forward.ts'),wordLowering});assert.equal(compiled.word,wordLowering);
  const work=resolve('build/word-tests',wordLowering?'forward-word':'forward-bigint');mkdirSync(work,{recursive:true});
  const entry=join(work,'entry.ts'),out=join(work,'probe.wasm');writeFileSync(entry,compiled.lowered);buildLibrary({entry,work,out,word:compiled.word});
  const vm=new AlkanesVM();vm.deploy(target,readFileSync(out));
  const incoming=[{id,value:MAX},{id,value:1n},{id:target,value:0n}];
  const response=vm.call({target,inputs:[0,MAX],incoming});assert.deepEqual(response.alkanes,incoming);outputs.push(response);
  assert.throws(()=>vm.call({target,inputs:[1],incoming}),/view rejects incoming assets/);
 }
 assert.deepEqual(outputs[1],outputs[0]);
});
test('word lowering is optional and rejects syntax requiring general exceptions or arithmetic',()=>{
 const filename=resolve('test/fixtures/word-choice.ts');
 const source=body=>'import {Contract,view,type u128} from "../../sdk/authoring.ts";export default class c extends Contract {'+body+'}';
 for(const body of ['@view({opcode:0}) read(a:u128):u128{return a/2n;}','@view({opcode:0}) read():u128{try{return 1n;}catch{return 0n;}}']){
  assert.equal(compileContract({filename,source:source(body),wordLowering:true}).word,false);
 }
 const compiled=compileContract({filename,source:source('@view({opcode:0}) read(w:u128):u128{const id=w+1n;return id;}'),wordLowering:true});
 assert.equal(compiled.word,true);assert.match(compiled.lowered,/__alk_word\.op/);
 assert.doesNotMatch(compiled.lowered,/\d+n\b/);
});
