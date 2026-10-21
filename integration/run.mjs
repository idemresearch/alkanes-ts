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
const root=resolve(import.meta.dirname,'..');
if(!process.env.ALKANES_RS)throw new Error('set ALKANES_RS to an alkanes-rs checkout');
const upstream=resolve(process.env.ALKANES_RS),work=join(root,'build/alkanes-runtime-test'),src=join(work,'src');
const args=process.argv.slice(2);let benchmark=false,iterations=30,output,baseline;
while(args.length){const arg=args.shift();if(arg==='--bench')benchmark=true;else if(arg==='--iterations')iterations=Number(args.shift());else if(arg==='--output')output=args.shift();else if(arg==='--baseline')baseline=resolve(args.shift());else throw new Error('unknown option '+arg);}
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
for(const name of ['init-probe','cache-caller','cache-callee','word'])fixture(name);
for(const [from,to] of [[join(root,'dist/capped-token.wasm'),'capped-token.wasm'],[join(root,'bench/dist/capped/rust-capped-token.wasm'),'rust-capped-token.wasm'],[join(root,'bench/dist/capped/rust-capped-token-opt.wasm'),'rust-capped-token-opt.wasm'],[join(root,'bench/dist/capped/rust-test-auth.wasm'),'test-auth.wasm'],[join(upstream,'crates/alkanes/src/tests/std/wasm/alkanes_std_auth_token.wasm'),'auth.wasm']])copyFileSync(from,join(src,to));
if(baseline)copyFileSync(baseline,join(src,'capped-token-before.wasm'));
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
writeFileSync(join(work,'Cargo.toml'),`[package]\nname="alkanes-ts-runtime-test"\nversion="0.0.0"\nedition="2021"\n[workspace]\n[features]\nbenchmark=[]\nbaseline=[]\n[lib]\ncrate-type=["cdylib","rlib"]\n[dependencies]\n${['alkanes','alkanes-support','metashrew-core','metashrew-support','protorune','protorune-support'].map(d=>`${d}={path=${JSON.stringify(join(upstream,'crates',d))},features=${JSON.stringify(features[d]??[])}}`).join('\n')}\nwasm-bindgen="=0.2.127"\nwasm-bindgen-test="=0.3.77"\nanyhow="1"\nbitcoin="0.32.4"\nserde_json="1"\nhex="0.4.3"\n`);
const pinned=join(root,'integration/Cargo.lock');
if(existsSync(pinned))copyFileSync(pinned,join(work,'Cargo.lock'));
const log=join(work,benchmark?'benchmark.log':'tests.log');
let text;
try{text=execFileSync('cargo',['+stable','test','--release',...(existsSync(pinned)?['--locked']:[]),'--manifest-path',join(work,'Cargo.toml'),'--target','wasm32-unknown-unknown','--lib',...((benchmark||baseline)?['--features',[...(benchmark?['benchmark']:[]),...(baseline?['baseline']:[])].join(',')]:[]),'--',...(benchmark?['benchmark_capped_token']:[]),'--nocapture'],{cwd:root,encoding:'utf8',maxBuffer:100*1024*1024,env:{...process.env,CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER:'wasm-bindgen-test-runner'},stdio:['ignore','pipe','pipe']});}
catch(error){writeFileSync(log,(error.stdout??'')+'\n'+(error.stderr??''));process.stderr.write((error.stdout??'').split('\n').slice(-50).join('\n')+'\n'+(error.stderr??'').split('\n').slice(-35).join('\n'));throw new Error('Alkanes runtime verification failed; full log: '+log);}
writeFileSync(log,text);
if(!existsSync(pinned))copyFileSync(join(work,'Cargo.lock'),pinned);
const command=(bin,args,cwd=root)=>execFileSync(bin,args,{cwd,encoding:'utf8'}).trim();
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const metadata={zig:command('zig',['version']),binaryen:command(join(root,'node_modules/.bin/wasm-opt'),['--version']),lowering:JSON.parse(readFileSync(join(root,'dist/capped-token.manifest.json'),'utf8')).lowering,nativeSDKSourceSHA256:sha(join(root,'shim/word.c')),upstream:command('git',['rev-parse','HEAD'],upstream),upstreamTrackedDirty:!!command('git',['status','--porcelain','--untracked-files=no'],upstream),hostRust:command('rustc',['+stable','--version']),runner:command('wasm-bindgen-test-runner',['--version']),scriptc:JSON.parse(readFileSync(join(root,'package.json'),'utf8')).devDependencies.scriptc,machine:`${cpus()[0].model}, ${platform()} ${arch()}`,lockSHA256:sha(pinned),artifacts:Object.fromEntries(['capped-token','rust-capped-token','rust-capped-token-opt','test-auth','auth','init-probe','cache-caller','cache-callee','word',...(baseline?['capped-token-before']:[])].map(n=>[n+'.wasm',{bytes:readFileSync(join(src,n+'.wasm')).length,sha256:sha(join(src,n+'.wasm'))}]))};
writeFileSync(join(work,'BUILD.json'),JSON.stringify(metadata,null,2)+'\n');
for(const line of text.split('\n'))if(/^running |^test .* (ok|FAILED)|^test result:/.test(line))console.log(line);
console.log('Actual runtime log: '+log);
if(benchmark){
 const rows=text.split('\n').filter(l=>l.startsWith('ALKANES_TS_BENCH ')).map(l=>JSON.parse(l.slice('ALKANES_TS_BENCH '.length)));
 if(rows.length!==6*(baseline?4:3))throw new Error('missing benchmark rows');
 let report='# CappedToken on the actual Alkanes runtime\n\n'+`Machine: ${metadata.machine}. ${iterations} measured repetitions per variant/scenario after 3 warmups each, with rotating variant order. Both TS and Rust run through the unmodified indexer, canonical host functions, asset accounting, and wasmi 0.37.2.\n\n`;
 report+='Fuel is the outer entry allocation minus the canonical `FuelTank` transaction remainder after indexing our single-invocation block. It includes nested auth execution plus runtime storage/host charges. This upstream revision drops exit fuel when serializing traces, so the zero exit-trace field is not used. All benchmark invocations succeed and are required to consume nonzero fuel. Median time measures `index_block`, including module compilation, instantiation and indexer work; transaction/envelope construction and inspection are excluded. This is a local wasm-bindgen/Node execution of the release-built indexer, not production RPC latency or isolated export timing. Every repetition checks the complete response and resulting contract/auth storage against the same reference.\n\n';
 report+='Deployment timing includes fresh-chain bootstrap and standard-contract setup, which dominate that row; it is not isolated deployment/initializer latency. Mint and views run after chain setup.\n\n';
 report+='The wide mint uses a separate MAX-u128 cap deployment and amount `(1 << 96) + 5`; setup is excluded from its timing. Every variant also verifies the actual outgoing UTXO balances for that call.\n\n';
 report+='Rust contract: '+readFileSync(join(root,'bench/dist/capped/BUILD.txt'),'utf8')+'\n';
 report+='Both implementations use the same auth binary and one-unit opcode-1 auth flow. The upstream auth binary returns two units; both account for its actual response.\n\n| scenario | TS fuel | Rust O3/LTO fuel | Rust + wasm-opt O3 fuel | TS median µs | Rust median µs | Rust + wasm-opt median µs |\n|---|---:|---:|---:|---:|---:|---:|\n';
 if(baseline)report=report.replace('| scenario | TS fuel | Rust O3/LTO fuel | Rust + wasm-opt O3 fuel | TS median µs | Rust median µs | Rust + wasm-opt median µs |\n|---|---:|---:|---:|---:|---:|---:|','| scenario | TS before fuel | TS fuel | Rust O3/LTO fuel | Rust + wasm-opt O3 fuel | TS before µs | TS median µs | Rust median µs | Rust + wasm-opt median µs |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|');
 for(const method of ['deploy+init','mint+auth','mint+auth-wide','supply','authority','cap']){const values=[...(baseline?['typescript-before']:[]),'typescript','rust-o3-lto','rust-o3-lto-wasm-opt'].map(v=>rows.find(r=>r.variant===v&&r.method===method));report+=`| ${method} | ${values.map(v=>v.fuel).join(' | ')} | ${values.map(v=>v.median_us.toFixed(1)).join(' | ')} |\n`;}
 const reportPath=output??'bench/CAPPED_TOKEN_RESULTS.md';
 report+='\nBuild metadata:\n\n```json\n'+JSON.stringify(metadata,null,2)+'\n```\n\nReproduce with the recorded alkanes-rs revision: `ALKANES_RS=/path/to/alkanes-rs npm run test:runtime`, '+(baseline?'`ALKANES_RS=/path/to/alkanes-rs npm run build:bench:capped-opt`, ':'')+'then `ALKANES_RS=/path/to/alkanes-rs npm run bench:capped -- --iterations '+iterations+(baseline?' --baseline dist/capped-opt/bigint-production.wasm':'')+' --output '+reportPath+'`.\n';
 writeFileSync(resolve(root,output??'bench/CAPPED_TOKEN_RESULTS.md'),report);console.log(report.split('Build metadata:')[0]);
}else{
 const report='# CappedToken integration verification\n\nThe tests use the upstream Alkanes indexer and its actual transaction, balance, nested-call, rollback and wasmi implementations. No upstream source is modified.\n\n```text\n'+text.split('\n').filter(l=>/^running |^test .* (ok|FAILED)|^test result:/.test(l)).join('\n')+'\n```\n\nCovered: generated-client CREATE+init bytes; typed ID state; initialization gates and atomic deployment failure; actual upstream auth verification and returned assets; cap/max-u128 boundaries; failed-auth and post-auth rollback; auth and initializer reentry; callback cache invalidation; outgoing Bitcoin UTXO balances; complete TS/Rust response and storage parity.\n\n```json\n'+JSON.stringify(metadata,null,2)+'\n```\n';
 writeFileSync(join(root,'integration/RESULTS.md'),report);
}
