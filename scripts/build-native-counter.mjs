import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {compileContract} from '../compiler/index.mjs';
import {nativeCallbacks} from './native/profile.mjs';
const root=resolve(import.meta.dirname,'..');
export function buildNativeContract({filename=join(root,'contracts/counter/index.ts'),source,work=join(root,'build/scriptc-native/counter'),out=join(root,'dist/counter-native.wasm')}={}){
mkdirSync(work,{recursive:true});
const compiled=compileContract({filename,source,wordLowering:true});
if(compiled?.word!=='sdk'||compiled.manifest.incomingAssets!=='reject'||compiled.manifest.initialized||compiled.manifest.trackedAssets)throw new Error('native prototype requires the checked word SDK, rejected incoming assets, and no init/tracked-asset runtime');
writeFileSync(join(work,'entry.ts'),compiled.lowered.replaceAll(join(root,'sdk/word-runtime.ts'),join(root,'sdk/native-counter.ts')));
writeFileSync(join(work,'profile.json'),JSON.stringify({profile_format:1,name:'alkanes-counter-native',entry:'entry.ts',emission:'llvm',wasm_abi:'alkanes-v1',abi:{prefix:'contract_',init_symbol:'contract_init',sink_register_symbol:'contract_sink',callback_register_symbol:'contract_callback'},callbacks:nativeCallbacks,exports:[{export:'execute',symbol:'contract_execute',params:['bytes'],returns:'f64'},{export:'meta',symbol:'contract_meta',params:[],returns:'bytes'}]},null,2));
process.env.ZIG_GLOBAL_CACHE_DIR??=join(root,'build/zig-global-cache');process.env.ZIG_LOCAL_CACHE_DIR??=join(root,'build/zig-local-cache');
const run=(name,args,env=process.env)=>execFileSync(name,args,{cwd:root,env,stdio:'inherit'});
run(process.execPath,[join(root,'scripts/native/compile.mjs'),join(work,'profile.json'),join(work,'contract.wasm')]);
const bin=n=>join(root,'node_modules/.bin',n),features=['--mvp-features','--enable-bulk-memory','--enable-sign-ext','--enable-nontrapping-float-to-int','--enable-mutable-globals'];
// Only deterministic WASI stand-ins remain. The compiler emits the Alkanes ABI;
// neither word.c/word-sdk.c nor an ABI adapter module enters this pipeline.
writeFileSync(join(work,'wasi.wat'),readFileSync(join(root,'shim/wasi.wat'),'utf8').replaceAll('(import "contract"','(import "scriptc"'));
run(bin('wasm-as'),[...features,join(work,'wasi.wat'),'-o',join(work,'wasi.wasm')]);
run(bin('wasm-merge'),[...features,join(work,'contract.wasm'),'scriptc',join(work,'wasi.wasm'),'wasi_snapshot_preview1','-o',join(work,'merged.wasm')]);
writeFileSync(join(work,'graph.json'),JSON.stringify(['memory','__execute','__meta'].map(e=>({name:e,root:true,export:e}))));
run(bin('wasm-metadce'),[...features,join(work,'merged.wasm'),'--graph-file',join(work,'graph.json'),'-o',join(work,'reduced.wasm')]);
mkdirSync(resolve(out,'..'),{recursive:true});
run(bin('wasm-opt'),[...features,'-Oz','--strip-debug','--strip-producers',join(work,'reduced.wasm'),'-o',out]);
const bytes=readFileSync(out),module=new WebAssembly.Module(bytes);
const imports=WebAssembly.Module.imports(module);if(imports.some(i=>i.module!=='env'||i.kind!=='function'))throw new Error('unresolved imports: '+JSON.stringify(imports));
if(WebAssembly.Module.exports(module).map(e=>e.name).sort().join(',')!=='__execute,__meta,memory')throw new Error('unexpected exports');
writeFileSync(out+'.gz',gzipSync(bytes,{level:9}));console.log(relative(root,out),bytes.length,'bytes');

return compiled;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)buildNativeContract();
