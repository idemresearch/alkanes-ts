import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {buildNativeContract} from '../scripts/build-native-counter.mjs';
import {AlkanesVM,u128} from './vm.mjs';
const enabled=process.env.ALKANES_NATIVE_TESTS==='1';
const target={block:2n,tx:1n},MAX=(1n<<128n)-1n;

test('native Counter matches the C SDK: ABI, errors, wide arithmetic, default state, fill and fallback loop',{skip:!enabled},()=>{
 const binaries=[readFileSync('build/scriptc-native/reference/counter-c-sdk-0.4.2.wasm'),readFileSync('dist/counter-native.wasm')];
 const outputs=binaries.map(binary=>{
  const vm=new AlkanesVM({height:900123n});vm.deploy(target,binary);const call=inputs=>vm.call({target,inputs});
  const results=[vm.meta(target),call([2]),call([0]),call([1,(1n<<96n)+5n]),call([4]),call([6,10])];
  for(const n of [0n,100n,300000n,300001n]){const r=call([5,n]);assert.equal(u128.decode(r.data),n*(n-1n)*(2n*n-1n)/6n);results.push(r);}
  for(const inputs of [[],[1],[42],[0],[3]]){const saved=vm.snapshot();assert.throws(()=>call(inputs),e=>{results.push(e.message);return true;});assert.deepEqual(vm.snapshot(),saved);}
  results.push(call([1,MAX-((1n<<96n)+5n)]));assert.throws(()=>call([1,1n]),/u128 overflow/);results.push(call([2]));
  return{results,storage:vm.snapshot(),logs:vm.logs};
 });assert.deepEqual(outputs[1],outputs[0]);
 const imports=WebAssembly.Module.imports(new WebAssembly.Module(binaries[1]));assert.ok(imports.every(i=>i.module==='env'&&i.kind==='function'));
});

test('native checked u128 intrinsics match bigint boundaries and IEEE rounding',{skip:!enabled},()=>{
 const filename=resolve('test/fixtures/word-sdk.ts');
 let source=readFileSync(filename,'utf8').replace('extends Contract {','extends Contract {\nstatic readonly incomingAssets="reject";');
 source=source.replace('@view({opcode:4})','@view({opcode:5}) difference(a:u128,b:u128):u128{return a-b;}\n  @view({opcode:4})');
 const work=resolve('build/scriptc-native/word-probe'),out=join(work,'probe.wasm');buildNativeContract({filename,source,work,out});
 const vm=new AlkanesVM();vm.deploy(target,readFileSync(out));const call=inputs=>vm.call({target,inputs});
 let seed=0x123456789n;const next=()=>{seed=(seed*6364136223846793005n+1442695040888963407n)&MAX;return seed;};
 for(const [a,b] of [[0n,MAX],[1n,MAX],[(1n<<64n)-1n,(1n<<64n)-1n],[1n<<64n,1n<<64n],...Array.from({length:80},()=>[next(),next()&255n])]){
  const expected=a*b;if(expected>MAX)assert.throws(()=>call([0,a,b]),/u128 overflow/);else assert.equal(u128.decode(call([0,a,b]).data),expected);
  if(a<b)assert.throws(()=>call([5,a,b]),/u128 underflow/);else assert.equal(u128.decode(call([5,a,b]).data),a-b);
 }
 for(const a of [0n,1n,(1n<<53n)+1n,(1n<<53n)+3n,(1n<<64n)-1n,(1n<<127n)+1n,MAX,...Array.from({length:100},next)]){
  const expected=BigInt(Number(a));if(expected>MAX)assert.throws(()=>call([1,a]),/u128 overflow/);else assert.equal(u128.decode(call([1,a]).data),expected);
 }
 // Retain this fixture for the actual-runtime intrinsic checks.
 mkdirSync(resolve('build/scriptc-native/reference'),{recursive:true});
 writeFileSync(resolve('build/scriptc-native/reference/native-word-probe.wasm'),readFileSync(out));
});

test('native u32 marshalling preserves JS coercion outside the fast path',{skip:!enabled},async()=>{
 const {execFileSync}=await import('node:child_process');const {WASI}=await import('node:wasi');const {nativeCallbacks}=await import('../scripts/native/profile.mjs');
 const work=resolve('build/scriptc-native/coercion-probe');mkdirSync(work,{recursive:true});
 writeFileSync(join(work,'entry.ts'),'declare function __native_alloc(n:number):number;declare function __native_store32(p:number,v:number):void;declare function __native_load32(p:number):number;export function roundtrip(n:number):number{const p=__native_alloc(4);__native_store32(p,n);return __native_load32(p);}');
 writeFileSync(join(work,'profile.json'),JSON.stringify({profile_format:1,name:'coercion',entry:'entry.ts',emission:'llvm',abi:{prefix:'test_',init_symbol:'test_init',sink_register_symbol:'test_sink',callback_register_symbol:'test_callback'},callbacks:nativeCallbacks,exports:[{export:'roundtrip',symbol:'test_roundtrip',params:['f64'],returns:'f64'}]}));
 execFileSync(process.execPath,['scripts/native/compile.mjs',join(work,'profile.json'),join(work,'probe.wasm')],{stdio:'pipe',env:{...process.env,ZIG_GLOBAL_CACHE_DIR:resolve('build/zig-global-cache'),ZIG_LOCAL_CACHE_DIR:resolve('build/zig-local-cache')}});
 const wasi=new WASI({version:'preview1',args:[],env:{},preopens:{}});
 const module=new WebAssembly.Module(readFileSync(join(work,'probe.wasm'))),instance=new WebAssembly.Instance(module,{wasi_snapshot_preview1:wasi.wasiImport,scriptc:{panic:()=>{throw new Error('unexpected panic');}}});
 wasi.initialize(instance);instance.exports.test_init();
 for(const n of [0,-0,1.9,-1.9,NaN,Infinity,-Infinity,4294967295,4294967296,4294967297,2**40+3,-(2**40)-3,Number.MAX_VALUE])assert.equal(instance.exports.test_roundtrip(n),n>>>0,String(n));
});
