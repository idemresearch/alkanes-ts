// Reproduce the previous bigint backend without checking out an old worktree.
import {writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {compileContract} from '../compiler/index.mjs';
import {buildLibrary} from '../scripts/build.mjs';
const root=resolve(import.meta.dirname,'..');
process.env.ZIG_GLOBAL_CACHE_DIR??=join(root,'build/zig-global-cache');
process.env.ZIG_LOCAL_CACHE_DIR??=join(root,'build/zig-local-cache');
for(const name of ['counter','token']){
 const filename=join(root,'contracts',name,'index.ts'),work=join(root,'build/examples-before',name);mkdirSync(work,{recursive:true});
 const compiled=compileContract({filename,wordLowering:false});
 const source=compiled?.lowered??`import contract from ${JSON.stringify(filename)};
import {executeContract,contractMeta} from ${JSON.stringify(join(root,'sdk/contract.ts'))};
export function execute(context:Uint8Array):Uint8Array{return executeContract(contract,context);}
export function meta():Uint8Array{return contractMeta(contract);}`;
 const entry=join(work,'entry.ts');writeFileSync(entry,source);
 buildLibrary({entry,work,out:join(root,'dist/examples-before',name+'.wasm')});
}
