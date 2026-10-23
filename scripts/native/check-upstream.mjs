import {execFileSync} from 'node:child_process';
import {copyFileSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'../..'),base=join(root,'build/scriptc-native'),up=join(base,'upstream'),bin=name=>join(base,'toolchain/node_modules/.bin',name);
const files=['library/wasm-intrinsics.ts','library/wasm-intrinsics.test.ts','library/library-profile.ts','library/prepare.ts','backend/llvm/wasm-library.ts','backend/llvm/expr-calls.ts','backend/llvm/emit-module.ts','ir/ir.ts','ir/function-references.test.ts'].map(f=>'packages/compiler/src/'+f);
const run=(cmd,args,cwd=up)=>execFileSync(cmd,args,{cwd,stdio:'inherit',env:{...process.env,ZIG_GLOBAL_CACHE_DIR:join(root,'build/zig-global-cache'),ZIG_LOCAL_CACHE_DIR:join(root,'build/zig-local-cache')}});
run(process.execPath,['packages/compiler/node_modules/typescript/bin/tsc','--noEmit','--incremental','false','--types','node','--typeRoots','../toolchain/node_modules/@types','-p','packages/compiler/tsconfig.json']);
run(bin('oxfmt'),['--check',...files]);run(bin('oxlint'),['--deny-warnings',...files]);
writeFileSync(join(base,'unit.config.mjs'),"export default {test:{include:['packages/compiler/src/library/wasm-intrinsics.test.ts','packages/compiler/src/ir/function-references.test.ts'],maxWorkers:1}};\n");
run(bin('vitest'),['run','--config','../unit.config.mjs']);
// The native release CLI remains unpatched and supplies the ordinary-profile oracle.
run(process.execPath,['scripts/native/build-reference.mjs'],root);
const work=join(base,'c-sdk-0.4.2'),llvm=join(work,'entry.lib.ll'),before=readFileSync(llvm);
copyFileSync(llvm,join(work,'unpatched.lib.ll'));
run(process.execPath,['scripts/native/compile.mjs',join(work,'profile.json'),join(work,'contract.wasm')],root);
assert.deepEqual(readFileSync(llvm),before,'ordinary C-SDK LLVM must remain byte-identical');
console.log('Upstream patch checks pass; ordinary-profile LLVM is byte-identical.');
