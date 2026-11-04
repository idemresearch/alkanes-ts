import assert from 'node:assert/strict';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {CONTRACT_STACK_SIZE} from '../scripts/build.mjs';

// Initial memory, first global's i32 initializer and lowest active data
// segment offset of a module.
function layout(bytes){
  let p=8,initialPages=null,stackPointer=null,dataStart=Infinity;
  const leb=()=>{let r=0,s=0,b;do{b=bytes[p++];r|=(b&0x7f)<<s;s+=7}while(b&0x80);return r>>>0};
  const sleb=()=>{let r=0,s=0,b;do{b=bytes[p++];r|=(b&0x7f)<<s;s+=7}while(b&0x80);if(s<32&&(b&0x40))r|=-1<<s;return r};
  while(p<bytes.length){
    const id=bytes[p++],size=leb(),end=p+size;
    if(id===5){leb();bytes[p++];initialPages=leb();}
    if(id===6&&leb()>0){p+=2;if(bytes[p++]===0x41)stackPointer=sleb();}
    if(id===11){const count=leb();for(let i=0;i<count;i++){const flags=leb();if(flags===0){p++;dataStart=Math.min(dataStart,sleb()>>>0);p++;}else if(flags===2){leb();p++;dataStart=Math.min(dataStart,sleb()>>>0);p++;}const length=leb();p+=length;}}
    p=end;
  }
  return {initialPages,stackPointer,dataStart};
}

// zig's wasm32 default is a 16 MiB stack, which gave every instance about
// 17 MB of initial memory and made canonical indexing slower. Contracts link
// a 1 MiB stack placed before the data, so an overflow traps below address 0.
test('contracts link a 1 MiB stack before their data and start with small memory',t=>{
  const names=readdirSync('contracts').filter(n=>existsSync(join('build',n,'contract.wasm'))&&existsSync(join('dist',n+'.wasm')));
  if(names.length===0)return t.skip('run npm run build first');
  for(const name of names){
    const linked=layout(readFileSync(join('build',name,'contract.wasm')));
    assert.equal(linked.stackPointer,CONTRACT_STACK_SIZE,`${name}: initial stack pointer`);
    assert.equal(linked.dataStart,CONTRACT_STACK_SIZE,`${name}: the stack precedes the data`);
    const final=layout(readFileSync(join('dist',name+'.wasm')));
    assert.ok(final.initialPages<64,`${name}: ${final.initialPages} initial pages`);
  }
});
