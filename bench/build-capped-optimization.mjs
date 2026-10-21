import {cpSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {compileContract} from '../compiler/index.mjs';
import {buildLibrary} from '../scripts/build.mjs';
import ts from 'typescript';
const root=resolve(import.meta.dirname,'..'),work=join(root,'build/capped-opt'),out=join(root,'dist/capped-opt');
process.env.ZIG_GLOBAL_CACHE_DIR??=join(root,'build/zig-global-cache');process.env.ZIG_LOCAL_CACHE_DIR??=join(root,'build/zig-local-cache');
mkdirSync(out,{recursive:true});
if(!process.env.ALKANES_RS)throw new Error('set ALKANES_RS to the recorded alkanes-rs checkout');
copyFileSync(join(resolve(process.env.ALKANES_RS),'crates/alkanes/src/tests/std/wasm/alkanes_std_auth_token.wasm'),join(out,'auth.wasm'));
for(const variant of process.argv.slice(2).length?process.argv.slice(2).filter(v=>v!=='layers'):['baseline','arrays','arrays-codecs','arrays-plain-codecs','error-only','word']){
 if(!['baseline','arrays','arrays-codecs','arrays-plain-codecs','error-only','word'].includes(variant))throw new Error('unknown variant '+variant);
 const dir=join(work,variant);mkdirSync(dir,{recursive:true});cpSync(join(root,'sdk'),join(dir,'sdk'),{recursive:true});
 cpSync(join(root,'contracts/capped-token'),join(dir,'contracts/capped-token'),{recursive:true});
 if(variant.includes('arrays')){
  cpSync(join(root,'bench/capped/assets-array.ts'),join(dir,'sdk/assets.ts'));
  const file=join(dir,'sdk/runtime.ts');let s=readFileSync(file,'utf8');
  s=s.replace('  toHex,','  bytesEqual,').replaceAll('new Map<string, StorageEntry>()','[]').replace('let cache = [];','let cache: StorageEntry[] = [];');
  s=s.replace('cache.size','cache.length').replace('cache.values()','cache');
  s=s.replace('const entry = cache.get(toHex(key));','const entry = cache.find((entry) => bytesEqual(entry.key,key));');
  s=s.replace('cache.set(toHex(key), new StorageEntry(key, value));','const entry = cache.find((entry) => bytesEqual(entry.key,key));\n  if (entry) entry.value=value; else cache.push(new StorageEntry(key,value));');
  writeFileSync(file,s);
 }
 if(variant.includes('plain-codecs')){
  const file=join(dir,'sdk/bytes.ts');let s=readFileSync(file,'utf8');
  const replacements={
   u128ToBytes:`export function u128ToBytes(value:bigint):Uint8Array {
    if(value<0n||value>U128_MAX)throw new Error("u128 out of range");
    const out=new Uint8Array(16);
    if(value<=0xffff_ffffn){const w=Number(value);out[0]=w&255;out[1]=(w>>>8)&255;out[2]=(w>>>16)&255;out[3]=w>>>24;return out;}
    let part=value;
    for(let i=0;i<16;i+=4){const w=Number(part&0xffff_ffffn);out[i]=w&255;out[i+1]=(w>>>8)&255;out[i+2]=(w>>>16)&255;out[i+3]=w>>>24;part>>=32n;}
    return out;
   }`,
   bytesToU128:`export function bytesToU128(bytes:Uint8Array,offset:number=0):bigint {
    if(Number.isInteger(offset)&&offset>=0&&offset+16<=bytes.length){
     const a=(bytes[offset]|(bytes[offset+1]<<8)|(bytes[offset+2]<<16)|(bytes[offset+3]<<24))>>>0;
     const b=(bytes[offset+4]|(bytes[offset+5]<<8)|(bytes[offset+6]<<16)|(bytes[offset+7]<<24))>>>0;
     const c=(bytes[offset+8]|(bytes[offset+9]<<8)|(bytes[offset+10]<<16)|(bytes[offset+11]<<24))>>>0;
     const d=(bytes[offset+12]|(bytes[offset+13]<<8)|(bytes[offset+14]<<16)|(bytes[offset+15]<<24))>>>0;
     if(b===0&&c===0&&d===0)return BigInt(a);
     return BigInt(a)|(BigInt(b)<<32n)|(BigInt(c)<<64n)|(BigInt(d)<<96n);
    }
    let v=0n;const end=Math.min(offset+16,bytes.length);for(let i=end-1;i>=offset;i--)v=(v<<8n)|BigInt(bytes[i]);return v;
   }`,
  };
  for(const [name,replacement]of Object.entries(replacements)){
   const f=ts.createSourceFile(file,s,ts.ScriptTarget.Latest,true),node=f.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);
   s=s.slice(0,node.getStart(f))+replacement+s.slice(node.end);
  }
  writeFileSync(file,s);
 }
 if(variant.includes('codecs')){
  const file=join(dir,'sdk/bytes.ts');let s=readFileSync(file,'utf8');
  s=s.replace('  view.setBigUint64(0, value & 0xffff_ffff_ffff_ffffn, true);','  if(value<=0xffff_ffffn){view.setUint32(0,Number(value),true);return out;}\n  view.setBigUint64(0, value & 0xffff_ffff_ffff_ffffn, true);');
  s=s.replace('    return view.getBigUint64(0, true) | (view.getBigUint64(8, true) << 64n);','    if(view.getUint32(4,true)===0&&view.getUint32(8,true)===0&&view.getUint32(12,true)===0)return BigInt(view.getUint32(0,true));\n    return view.getBigUint64(0, true) | (view.getBigUint64(8, true) << 64n);');
  writeFileSync(file,s);
 }
 if(variant==='error-only'){
  const file=join(dir,'sdk/contract.ts');writeFileSync(file,readFileSync(file,'utf8').replace('return String(e);','return "non-Error exception";'));
 }
 const compiled=compileContract({filename:join(dir,'contracts/capped-token/index.ts'),sdkDirectory:join(dir,'sdk'),wordLowering:variant==='word'});
 const entry=join(dir,'entry.ts');writeFileSync(entry,compiled.lowered);
 buildLibrary({entry,work:join(dir,'compile'),out:join(out,variant+'.wasm'),benchmark:true,word:compiled.word});
 if(variant==='baseline')buildLibrary({entry,work:join(dir,'compile-production'),out:join(out,'bigint-production.wasm')});
}
if(process.argv.includes('layers')){
 const sdk=join(root,'sdk');
 const layers={
  bigint:`export function execute(c:Uint8Array):Uint8Array{if(new DataView(c.buffer,c.byteOffset+96,16).getBigUint64(0,true)!==0n)throw new Error("bad");return new Uint8Array(20);}`,
  context:`import {Context} from ${JSON.stringify(join(sdk,'types.ts'))};export function execute(c:Uint8Array):Uint8Array{if(Context.parse(c).inputs[0]!==0n)throw new Error("bad");return new Uint8Array(20);}`,
  storage:`import {resetStorage,serializeStorage} from ${JSON.stringify(join(sdk,'runtime.ts'))};export function execute(c:Uint8Array):Uint8Array{resetStorage();const out=new Uint8Array(20);out.set(serializeStorage(),16);return out;}`,
  response:`import {AlkaneTransferParcel} from ${JSON.stringify(join(sdk,'types.ts'))};export function execute(c:Uint8Array):Uint8Array{const out=new Uint8Array(20);out.set(new AlkaneTransferParcel().serialize(),0);return out;}`,
  errors:`export function execute(c:Uint8Array):Uint8Array{try{if(c[0]!==2)throw new Error("bad");return new Uint8Array(20);}catch(e){if(e instanceof Error){if(e.message.length>0)throw e;}return new Uint8Array(20);}}`,
 };
 for(const [name,source]of Object.entries(layers)){
  const dir=join(work,'layer-'+name);mkdirSync(dir,{recursive:true});const entry=join(dir,'entry.ts');writeFileSync(entry,source+'\nexport function meta():Uint8Array{return new Uint8Array();}\n');
  buildLibrary({entry,work:dir,out:join(out,'layer-'+name+'.wasm'),benchmark:true});
 }
}
buildLibrary({entry:join(root,'bench/isolation/minimal.ts'),work:join(work,'floor'),out:join(out,'floor.wasm'),benchmark:true});
buildLibrary({entry:join(root,'bench/capped/empty.ts'),work:join(work,'empty'),out:join(out,'empty.wasm'),benchmark:true});
const features=['--mvp-features','--enable-bulk-memory','--enable-sign-ext','--enable-nontrapping-float-to-int','--enable-mutable-globals'];
if(existsSync(join(work,'baseline/compile/reduced.wasm')))execFileSync(join(root,'node_modules/.bin/wasm-opt'),[...features,'-O3','--strip-debug','--strip-producers',join(work,'baseline/compile/reduced.wasm'),'-o',join(out,'binaryen-o3.wasm')],{stdio:'inherit'});
