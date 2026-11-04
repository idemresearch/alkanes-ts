import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {compileContract} from '../compiler/index.mjs';
import {buildLibrary} from '../scripts/build.mjs';
import {AlkanesVM,u128} from './vm.mjs';

// word-sdk-v1 represents u128 values as word handles and strings as Bytes
// objects. Comparing values typed as unions (u128 | undefined, optional
// strings) would compare those handles by identity, which differs from the
// bigint backend and, with hoisted literals, from earlier builds. Such
// contracts must select the bigint backend.
const source=`import {Contract,view,type u128} from "../../sdk/authoring.ts";
import {height} from "../../sdk/index.ts";
export default class Ident extends Contract{
  private same(a: u128 | undefined, b: u128 | undefined): boolean { return a === b; }
  private sameText(a: string | undefined, b: string | undefined): boolean { return a === b; }
  private pick(): u128 | undefined { return 7n; }
  @view({opcode:1n}) num():u128{ return this.same(5n, 5n) ? 1n : 0n; }
  @view({opcode:2n}) text():u128{ return this.sameText("x", "x") ? 1n : 0n; }
  @view({opcode:3n}) computed():u128{ return this.same(5n, 4n + 1n) ? 1n : 0n; }
  @view({opcode:5n}) sw():u128{ const v = this.pick(); switch (v) { case 7n: return 1n; } return 0n; }
  private present(a: u128 | undefined): boolean { return a ? true : false; }
  @view({opcode:6n}) truthy():u128{ return this.present(0n) ? 1n : 0n; }
  @view({opcode:4n}) h():u128{ return height(); }
}`;
const target={block:2n,tx:1n};
function build(wordLowering){
  const filename=resolve('test/fixtures/ident.ts');
  const compiled=compileContract({filename,source,wordLowering});
  const work=resolve('build/identity-tests',wordLowering?'word':'bigint');mkdirSync(work,{recursive:true});
  const entry=join(work,'entry.ts'),out=join(work,'probe.wasm');
  writeFileSync(entry,compiled.lowered);buildLibrary({entry,work,out,word:compiled.word});
  return {compiled,binary:readFileSync(out)};
}
const run=binary=>{const vm=new AlkanesVM();vm.deploy(target,binary);return [1n,2n,3n,5n,6n].map(op=>u128.decode(vm.call({target,inputs:[op]}).data));};
test('equality, switch and truthiness on union-typed u128/string values match the bigint backend',()=>{
  const word=build(true),bigint=build(false);
  assert.ok(['word-sdk-v1','bigint'].includes(word.compiled.manifest.lowering));
  assert.equal(bigint.compiled.manifest.lowering,'bigint');
  assert.deepEqual(run(word.binary),run(bigint.binary));
  assert.deepEqual(run(bigint.binary),[1n,1n,1n,1n,0n]);
});
