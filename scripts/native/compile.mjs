import {cpSync,mkdirSync,readFileSync,writeFileSync,existsSync,symlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
const root=resolve(import.meta.dirname,'../..'),base=join(root,'build/scriptc-native'),up=join(base,'upstream');
const pkg=join(up,'packages/compiler');
if(!existsSync(join(up,'node_modules')))symlinkSync(join(base,'toolchain/node_modules'),join(up,'node_modules'),'dir');
if(!existsSync(join(pkg,'node_modules')))symlinkSync(join(base,'toolchain/node_modules/@scriptc/compiler/node_modules'),join(pkg,'node_modules'),'dir');
if(!existsSync(join(pkg,'dist/index.js')))cpSync(join(base,'toolchain/node_modules/@scriptc/compiler/dist'),join(pkg,'dist'),{recursive:true});
// Recompile the patch's source modules over the exact matching release package.
for(const file of ['library/library-profile','library/wasm-intrinsics','library/prepare','backend/llvm/expr-calls','backend/llvm/emit-module','backend/llvm/wasm-library']){
 const dest=join(pkg,'dist',file+'.js');mkdirSync(resolve(dest,'..'),{recursive:true});
 let source=readFileSync(join(pkg,'src',file+'.ts'),'utf8');
 if(process.env.ALKANES_NATIVE_ABLATE_COERCION==='1'&&file==='backend/llvm/expr-calls')source=source.replace(/libCb\.wasm === undefined(?=\s*\?)/, 'true');
 writeFileSync(dest,ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022,verbatimModuleSyntax:true}}).outputText);
}
const profilePath=resolve(process.argv[2]),outPath=resolve(process.argv[3]);
process.env.SCRIPTC_TARGET='wasm32-wasi';
process.env.SCRIPTC_RUNTIME_PACK=join(base,'toolchain/node_modules/@scriptc/runtime-wasm32-wasi');
const {compileLibrary}=await import(pathToFileURL(join(pkg,'dist/index.js')));
const result=await compileLibrary({profilePath,outDir:resolve(outPath,'..'),outPath,emitIr:true});
if(!result.ok){console.error(JSON.stringify(result.diagnostics,null,2));process.exit(1);}
console.log('scriptc native compiler:',outPath);
