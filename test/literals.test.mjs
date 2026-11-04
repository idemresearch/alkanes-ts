import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {compileContract} from '../compiler/index.mjs';
import {buildLibrary} from '../scripts/build.mjs';
import {AlkanesVM} from './vm.mjs';

// Selectors at and around 2^53, where the word paths switch from numeric to
// full-width selector tests, and a value that only matches modulo 2^64.
const S=1n<<53n,MAX=(1n<<128n)-1n,target={block:2n,tx:1n};
const methods=`
  @view({opcode:1n}) one():u128{return 11n;}
  @view({opcode:${S-1n}n}) below():u128{return 12n;}
  @view({opcode:${S}n}) at():u128{return 13n;}
  @view({opcode:${(1n<<64n)+1n}n}) wide():u128{return 14n;}
  @method({opcode:2n}) fails():void{throw new Error("same text");}
  @method({opcode:3n}) failsToo():void{throw new Error("same text");}`;
const probes={
  'word-v1':`import {Contract,view,method,type u128} from "../../sdk/authoring.ts";
export default class Selectors extends Contract{${methods}}`,
  // Importing the general SDK selects word-sdk-v1 instead of word-v1.
  'word-sdk-v1':`import {Contract,view,method,type u128} from "../../sdk/authoring.ts";
import {height} from "../../sdk/index.ts";
export default class Selectors extends Contract{${methods}
  @view({opcode:4n}) h():u128{return height();}}`,
};
const calls=[[1n],[S-1n],[S],[S+1n],[S-2n],[(1n<<64n)+1n],[1n<<64n],[1n+(1n<<64n)+(1n<<96n)],[1n+S],[2n],[3n],[5n],[MAX],[0n],[]];

function build(name,source,wordLowering){
  const filename=resolve('test/fixtures/selectors.ts');
  const compiled=compileContract({filename,source,wordLowering});
  const work=resolve('build/literal-tests',name,wordLowering?'word':'bigint');mkdirSync(work,{recursive:true});
  const entry=join(work,'entry.ts'),out=join(work,'probe.wasm');
  writeFileSync(entry,compiled.lowered);buildLibrary({entry,work,out,word:compiled.word});
  return {compiled,binary:readFileSync(out)};
}
function run(binary){
  const vm=new AlkanesVM();vm.deploy(target,binary);
  return calls.map(inputs=>{try{return vm.call({target,inputs});}catch(e){return e.message;}});
}

for(const [lowering,source] of Object.entries(probes)){
  test(`${lowering} hoisted literals and numeric selectors match the bigint backend`,()=>{
    const word=build(lowering,source,true),bigint=build(lowering,source,false);
    assert.equal(word.compiled.manifest.lowering,lowering);
    assert.equal(bigint.compiled.manifest.lowering,'bigint');
    // Literals are module constants: no u128 literal or byte array is built
    // inside a function, and each distinct message is emitted once.
    const lowered=word.compiled.lowered;
    for(const line of lowered.split('\n'))if(/literal\(/.test(line)&&!/^export function literal/.test(line))assert.match(line,/^const __alk_lit_\d+ ?= ?__alk_(sdk|word)\.literal\(/);
    assert.doesNotMatch(lowered,/new Uint8Array\(\[\d/);
    assert.doesNotMatch(lowered,/finally/);
    const constants=new Map();
    for(const line of lowered.split('\n')){
      let m=line.match(/^const (__alk_lit_\d+(?:_data)?) ?= ?new Uint8Array\((\d+)\);$/);
      if(m)constants.set(m[1],new Uint8Array(+m[2]));
      m=line.match(/^(__alk_lit_\d+(?:_data)?)\[(\d+)\] ?= ?(\d+);$/);
      if(m)constants.get(m[1])[+m[2]]=+m[3];
    }
    const message=Buffer.from((lowering==='word-v1'?'Error: ':'')+'same text');
    assert.equal([...constants.values()].filter(c=>Buffer.from(c).equals(message)).length,1);
    assert.equal([...constants.values()].filter(c=>c.length>0&&c[0]===123).length,1,'one meta buffer');
    const results=run(word.binary);
    assert.deepEqual(results,run(bigint.binary));
    assert.deepEqual(results.slice(0,3).map(r=>r.data?.[0]),[11,12,13]);
    assert.match(results[3],/Unrecognized opcode 9007199254740993/);
    assert.equal(results[5].data[0],14);
    assert.match(results[6],/Unrecognized opcode 18446744073709551616/);
    assert.match(results[9],/same text/);assert.match(results[10],/same text/);
  });
}
