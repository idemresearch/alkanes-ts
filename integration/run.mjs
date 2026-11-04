// Build and run the actual upstream indexer as a wasm-bindgen test module.
// Source/fixtures are copied into build/; the upstream checkout stays unchanged.
import {execFileSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {cpus,platform,arch} from 'node:os';
import ts from 'typescript';
import {compileContract} from '../compiler/index.mjs';
import {buildLibrary} from '../scripts/build.mjs';
import {examplesReport} from './examples-report.mjs';
const root=resolve(import.meta.dirname,'..');
if(!process.env.ALKANES_RS)throw new Error('set ALKANES_RS to an alkanes-rs checkout');
const upstream=resolve(process.env.ALKANES_RS),work=join(root,'build/alkanes-runtime-test'),src=join(work,'src');
// alkanes-rs v3 moved the alkanes crate to the repository root and takes
// metashrew from a git tag; earlier revisions keep every crate in crates/.
const upstreamManifest=readFileSync(join(upstream,'Cargo.toml'),'utf8');
const rootAlkanes=!existsSync(join(upstream,'crates/alkanes/Cargo.toml'))&&/^\[package\]\s*\nname\s*=\s*"alkanes"/m.test(upstreamManifest);
const metashrewGit=rootAlkanes?/^metashrew-core\s*=\s*\{\s*git\s*=\s*"([^"]+)",\s*tag\s*=\s*"([^"]+)"/m.exec(upstreamManifest):null;
if(rootAlkanes&&!metashrewGit)throw new Error('cannot find the metashrew git tag in '+join(upstream,'Cargo.toml'));
const args=process.argv.slice(2);let benchmark=false,examples=false,iterations=30,output,baseline,nativeCounter=false,custody=false;
while(args.length){const arg=args.shift();if(arg==='--bench')benchmark=true;else if(arg==='--examples')examples=true;else if(arg==='--native-counter'){examples=true;nativeCounter=true;}else if(arg==='--custody'){examples=true;custody=true;}else if(arg==='--iterations')iterations=Number(args.shift());else if(arg==='--output')output=args.shift();else if(arg==='--baseline')baseline=resolve(args.shift());else throw new Error('unknown option '+arg);}
if(!Number.isSafeInteger(iterations)||iterations<1)throw new Error('iterations must be positive');
mkdirSync(src,{recursive:true});
process.env.ZIG_GLOBAL_CACHE_DIR??=join(root,'build/zig-global-cache');
process.env.ZIG_LOCAL_CACHE_DIR??=join(root,'build/zig-local-cache');
function fixture(name){
 const filename=join(root,'test/fixtures',name+'.ts'),directory=join(root,'build/runtime-fixtures',name);mkdirSync(directory,{recursive:true});
 const compiled=compileContract({filename,wordLowering:true});
 const entry=join(directory,'entry.ts');
 writeFileSync(entry,compiled?.lowered??`import contract from ${JSON.stringify(filename)};\nimport {executeContract,contractMeta} from ${JSON.stringify(join(root,'sdk/contract.ts'))};\nexport function execute(context:Uint8Array):Uint8Array{return executeContract(contract,context);}\nexport function meta():Uint8Array{return contractMeta(contract);}`);
 buildLibrary({entry,work:directory,out:join(src,name+'.wasm'),word:compiled?.word});
}
for(const name of ['init-probe','cache-caller','cache-callee','word',...(examples?['word-relay']:[])])fixture(name);
for(const [from,to] of [[join(root,'dist/capped-token.wasm'),'capped-token.wasm'],[join(root,'bench/dist/capped/rust-capped-token.wasm'),'rust-capped-token.wasm'],[join(root,'bench/dist/capped/rust-capped-token-opt.wasm'),'rust-capped-token-opt.wasm'],[join(root,'bench/dist/capped/rust-test-auth.wasm'),'test-auth.wasm'],[rootAlkanes?join(upstream,'ts-sdk/build/contracts/alkanes_std_auth_token.wasm'):join(upstream,'crates/alkanes/src/tests/std/wasm/alkanes_std_auth_token.wasm'),'auth.wasm']])copyFileSync(from,join(src,to));
if(nativeCounter){for(const name of ['counter-native','counter-c-sdk-0.4.2','counter-native-generic-coercion','native-word-probe'])copyFileSync(join(root,name==='counter-native'?'dist':'build/scriptc-native/reference',name+'.wasm'),join(src,name+'.wasm'));}
if(examples){
 copyFileSync(join(root,'integration/examples.rs'),join(src,'examples.rs'));
 for(const name of ['counter','token']){
  copyFileSync(join(root,'dist',name+'.wasm'),join(src,name+'.wasm'));
  const rust=join(root,'bench/dist',...(name==='counter'?['numeric-fast-path']:[]));
  copyFileSync(join(rust,'rust-'+name+'.wasm'),join(src,name+'-rust.wasm'));
  copyFileSync(join(rust,'rust-'+name+'-opt.wasm'),join(src,name+'-rust-opt.wasm'));
  if(baseline)copyFileSync(join(baseline,name+'.wasm'),join(src,name+'-before.wasm'));
 }
}else if(baseline)copyFileSync(baseline,join(src,'capped-token-before.wasm'));
if(custody){for(const name of ['amm-pool','amm-router'])copyFileSync(join(root,'dist',name+'.wasm'),join(src,name+'.wasm'));copyFileSync(join(root,'integration/custody.rs'),join(src,'custody.rs'));}
copyFileSync(join(root,'integration/runtime.rs'),join(src,'lib.rs'));
writeFileSync(join(src,'iterations.txt'),String(iterations)+'\n');
// Prepare real client wire bytes, including the atomic CREATE+init request.
const transpile=s=>ts.transpileModule(s,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
writeFileSync(join(work,'client-runtime.mjs'),transpile(readFileSync(join(root,'client/runtime.ts'),'utf8')));
writeFileSync(join(work,'CappedTokenClient.mjs'),transpile(readFileSync(join(root,'dist/CappedTokenClient.ts'),'utf8')).replace(JSON.stringify(join(root,'client/runtime.ts')),'"./client-runtime.mjs"'));
const {CappedTokenClient}=await import(pathToFileURL(join(work,'CappedTokenClient.mjs')));
let captured;
const transport={simulate:async request=>{captured=request;return{data:new Uint8Array(request.inputs[0]===102n?32:16),alkanes:[]};}};
const client=new CappedTokenClient(transport,{block:2n,tx:1n});
const authority={block:4n,tx:9001n},vectors={};
const save=(name,request)=>vectors[name]=Buffer.from(request.cellpack).toString('hex');
save('deploy',CappedTokenClient.deploy(transport,readFileSync(join(root,'dist/capped-token.wasm')),{authority,cap:1000n}).prepare());
save('initialize',client.call.initialize({authority,cap:1000n}).prepare());
save('mint',client.call.mint({amount:5n}).withAssets([{id:authority,value:1n}]).prepare());
for(const [name,method] of [['supply','totalSupply'],['authority','getAuthority'],['cap','getCap']]){await client.read[method]();save(name,captured);}
writeFileSync(join(src,'client-vectors.json'),JSON.stringify(vectors,null,2)+'\n');
const features={alkanes:['test-utils','regtest'],'metashrew-core':['test-utils'],protorune:['test-utils']};
const wasmBindgen=rootAlkanes?(/^wasm-bindgen\s*=\s*"(=[^"]+)"/m.exec(upstreamManifest)?.[1]??'=0.2.100'):'=0.2.127';
const wasmBindgenTest=rootAlkanes?(/^wasm-bindgen-test\s*=\s*"(=[^"]+)"/m.exec(upstreamManifest)?.[1]??'=0.3.50'):'=0.3.77';
const dependency=d=>{
 const f=JSON.stringify(features[d]??[]);
 if(rootAlkanes&&d==='alkanes')return `${d}={path=${JSON.stringify(upstream)},features=${f}}`;
 if(rootAlkanes&&d.startsWith('metashrew-'))return `${d}={git=${JSON.stringify(metashrewGit[1])},tag=${JSON.stringify(metashrewGit[2])},features=${f}}`;
 return `${d}={path=${JSON.stringify(join(upstream,'crates',d))},features=${f}}`;
};
writeFileSync(join(work,'Cargo.toml'),`[package]\nname="alkanes-ts-runtime-test"\nversion="0.0.0"\nedition="2021"\n[workspace]\n[features]\nbenchmark=[]\nbaseline=[]\nexamples=[]\nexamples-baseline=["examples"]\nnative-counter=["examples"]\ncustody=["examples"]\nv3=[]\n[lib]\ncrate-type=["cdylib","rlib"]\n[dependencies]\n${['alkanes','alkanes-support','metashrew-core','metashrew-support','protorune','protorune-support'].map(dependency).join('\n')}\nwasm-bindgen="${wasmBindgen}"\nwasm-bindgen-test="${wasmBindgenTest}"\nanyhow="1"\nbitcoin="0.32.4"\nserde_json="1"\nhex="0.4.3"\n`);
// Each layout has its own committed lock. The first v3 run resolves from
// the upstream lock and records the result; later runs use it --locked.
const pinned=join(root,rootAlkanes?'integration/Cargo.v3.lock':'integration/Cargo.lock');
if(existsSync(pinned))copyFileSync(pinned,join(work,'Cargo.lock'));
else if(rootAlkanes)copyFileSync(join(upstream,'Cargo.lock'),join(work,'Cargo.lock'));
const log=join(work,benchmark?'benchmark.log':'tests.log');
let text;
// Path dependencies from different alkanes-rs checkouts can share crate names
// and versions, and cargo then reuses one checkout's artifacts for another.
// Each upstream revision therefore gets its own target directory.
const upstreamRevision=execFileSync('git',['rev-parse','HEAD'],{cwd:upstream,encoding:'utf8'}).trim();
try{text=execFileSync('cargo',['+stable','test','--release',...(existsSync(pinned)?['--locked']:[]),'--manifest-path',join(work,'Cargo.toml'),'--target-dir',join(work,'target',upstreamRevision.slice(0,12)),'--target','wasm32-unknown-unknown','--lib',...((benchmark||baseline||examples||rootAlkanes)?['--features',[...(benchmark?['benchmark']:[]),...(examples?['examples']:[]),...(nativeCounter?['native-counter']:[]),...(custody?['custody']:[]),...(rootAlkanes?['v3']:[]),...(baseline?[examples?'examples-baseline':'baseline']:[])].join(',')]:[]),'--',...(benchmark?[examples?'examples::benchmark_examples':'benchmark_capped_token']:[]),'--nocapture'],{cwd:root,encoding:'utf8',maxBuffer:100*1024*1024,env:{...process.env,CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER:'wasm-bindgen-test-runner'},stdio:['ignore','pipe','pipe']});}
catch(error){writeFileSync(log,(error.stdout??'')+'\n'+(error.stderr??''));process.stderr.write((error.stdout??'').split('\n').slice(-50).join('\n')+'\n'+(error.stderr??'').split('\n').slice(-35).join('\n'));throw new Error('Alkanes runtime verification failed; full log: '+log);}
writeFileSync(log,text);
if(!existsSync(pinned))copyFileSync(join(work,'Cargo.lock'),pinned);
const command=(bin,args,cwd=root)=>execFileSync(bin,args,{cwd,encoding:'utf8'}).trim();
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const metadata={zig:command('zig',['version']),binaryen:command(join(root,'node_modules/.bin/wasm-opt'),['--version']),lowering:examples?Object.fromEntries(['counter','token'].map(n=>[n,JSON.parse(readFileSync(join(root,'dist',n+'.manifest.json'),'utf8')).lowering])):JSON.parse(readFileSync(join(root,'dist/capped-token.manifest.json'),'utf8')).lowering,nativeSDKSourceSHA256:sha(join(root,'shim/word.c')),extendedSDKSourceSHA256:sha(join(root,'shim/word-sdk.c')),upstream:command('git',['rev-parse','HEAD'],upstream),upstreamTrackedDirty:!!command('git',['status','--porcelain','--untracked-files=no'],upstream),hostRust:command('rustc',['+stable','--version']),runner:command('wasm-bindgen-test-runner',['--version']),scriptc:JSON.parse(readFileSync(join(root,'package.json'),'utf8')).devDependencies.scriptc,machine:`${cpus()[0].model}, ${platform()} ${arch()}`,lockSHA256:sha(pinned),artifacts:Object.fromEntries(['capped-token','rust-capped-token','rust-capped-token-opt','test-auth','auth','init-probe','cache-caller','cache-callee','word',...(!examples&&baseline?['capped-token-before']:[]),...(nativeCounter?['counter-native','counter-c-sdk-0.4.2','counter-native-generic-coercion','native-word-probe']:[]),...(examples?['counter','token','counter-rust','counter-rust-opt','token-rust','token-rust-opt','word-relay',...(baseline?['counter-before','token-before']:[])]:[]),...(custody?['amm-pool','amm-router']:[])].map(n=>[n+'.wasm',{bytes:readFileSync(join(src,n+'.wasm')).length,sha256:sha(join(src,n+'.wasm'))}]))};
writeFileSync(join(work,'BUILD.json'),JSON.stringify(metadata,null,2)+'\n');
for(const line of text.split('\n'))if(/^running |^test .* (ok|FAILED)|^test result:/.test(line))console.log(line);
console.log('Actual runtime log: '+log);
if(benchmark){
 const rows=text.split('\n').filter(l=>l.startsWith('ALKANES_TS_BENCH ')).map(l=>JSON.parse(l.slice('ALKANES_TS_BENCH '.length)));
 if(!examples&&rows.length!==6*(baseline?4:3))throw new Error('missing benchmark rows');
 let report='# CappedToken on the actual Alkanes runtime\n\n'+`Machine: ${metadata.machine}. ${iterations} measured repetitions per variant/scenario after 3 warmups each, with rotating variant order. Both TS and Rust run through the unmodified indexer, canonical host functions, asset accounting, and wasmi 0.37.2.\n\n`;
 report+='Fuel is the outer entry allocation minus the canonical `FuelTank` transaction remainder after indexing our single-invocation block. It includes nested auth execution plus runtime storage/host charges. This upstream revision drops exit fuel when serializing traces, so the zero exit-trace field is not used. All benchmark invocations succeed and are required to consume nonzero fuel. Median time measures `index_block`, including module compilation, instantiation and indexer work; transaction/envelope construction and inspection are excluded. This is a local wasm-bindgen/Node execution of the release-built indexer, not production RPC latency or isolated export timing. Every repetition checks the complete response and resulting contract/auth storage against the same reference.\n\n';
 report+='Deployment timing includes fresh-chain bootstrap and standard-contract setup, which dominate that row; it is not isolated deployment/initializer latency. Mint and views run after chain setup.\n\n';
 report+='The wide mint uses a separate MAX-u128 cap deployment and amount `(1 << 96) + 5`; setup is excluded from its timing. Every variant also verifies the actual outgoing UTXO balances for that call.\n\n';
 report+='Rust contract: '+readFileSync(join(root,'bench/dist/capped/BUILD.txt'),'utf8')+'\n';
 report+='Both implementations use the same auth binary and one-unit opcode-1 auth flow. The upstream auth binary returns two units; both account for its actual response.\n\n| scenario | TS fuel | Rust O3/LTO fuel | Rust + wasm-opt O3 fuel | TS median µs | Rust median µs | Rust + wasm-opt median µs |\n|---|---:|---:|---:|---:|---:|---:|\n';
 if(baseline)report=report.replace('| scenario | TS fuel | Rust O3/LTO fuel | Rust + wasm-opt O3 fuel | TS median µs | Rust median µs | Rust + wasm-opt median µs |\n|---|---:|---:|---:|---:|---:|---:|','| scenario | TS before fuel | TS fuel | Rust O3/LTO fuel | Rust + wasm-opt O3 fuel | TS before µs | TS median µs | Rust median µs | Rust + wasm-opt median µs |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|');
 for(const method of examples?[]:['deploy+init','mint+auth','mint+auth-wide','supply','authority','cap']){const values=[...(baseline?['typescript-before']:[]),'typescript','rust-o3-lto','rust-o3-lto-wasm-opt'].map(v=>rows.find(r=>r.variant===v&&r.method===method));report+=`| ${method} | ${values.map(v=>v.fuel).join(' | ')} | ${values.map(v=>v.median_us.toFixed(1)).join(' | ')} |\n`;}
 const reportPath=output??'bench/CAPPED_TOKEN_RESULTS.md';
 report+='\nBuild metadata:\n\n```json\n'+JSON.stringify(metadata,null,2)+'\n```\n\nReproduce with the recorded alkanes-rs revision: `ALKANES_RS=/path/to/alkanes-rs npm run test:runtime`, '+(baseline?'`ALKANES_RS=/path/to/alkanes-rs npm run build:bench:capped-opt`, ':'')+'then `ALKANES_RS=/path/to/alkanes-rs npm run bench:capped -- --iterations '+iterations+(baseline?' --baseline dist/capped-opt/bigint-production.wasm':'')+' --output '+reportPath+'`.\n';
 if(examples&&!nativeCounter)report=examplesReport({root,rows,metadata,iterations,baseline});
 if(nativeCounter){const {nativeCounterReport}=await import('./native-counter-report.mjs');report=nativeCounterReport({root,rows,metadata,iterations});}
 writeFileSync(resolve(root,output??(nativeCounter?'bench/NATIVE_COUNTER_RESULTS.md':examples?'bench/EXAMPLES_RUNTIME_RESULTS.md':'bench/CAPPED_TOKEN_RESULTS.md')),report);console.log(report.split('Build metadata:')[0]);
}else{
 const report='# '+(examples?'Counter, Token and CappedToken':'CappedToken')+' integration verification\n\nThe tests use the upstream Alkanes indexer and its actual transaction, balance, nested-call, rollback and wasmi implementations. No upstream source is modified.\n\n```text\n'+text.split('\n').filter(l=>/^running |^test .* (ok|FAILED)|^test result:/.test(l)).join('\n')+'\n```\n\nCovered: generated-client CREATE+init bytes; typed ID state; initialization gates and atomic deployment failure; actual upstream auth verification and returned assets; cap/max-u128 boundaries; failed-auth and post-auth rollback; auth and initializer reentry; callback cache invalidation; outgoing Bitcoin UTXO balances; complete TS/Rust response and storage parity.'+(examples?' Additional Counter/Token coverage: checked wide increments/mints, numeric loops, storage fill, height, metadata responses, caller ownership, real UTXO balances and nested-call rollback.':'')+'\n\n```json\n'+JSON.stringify(metadata,null,2)+'\n```\n';
 writeFileSync(resolve(root,output??(nativeCounter?'integration/NATIVE_COUNTER_RESULTS.md':examples?'integration/EXAMPLES_RESULTS.md':'integration/RESULTS.md')),report);
}
