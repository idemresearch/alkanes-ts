// Qualify the stock C-SDK backend with paired canonical-runtime benchmarks.
import {execFileSync} from 'node:child_process';
import {copyFileSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {stockToolchain} from './toolchain.mjs';
const root=resolve(import.meta.dirname,'..'),toolchain=stockToolchain(root);
if(!process.env.ALKANES_RS)throw new Error('set ALKANES_RS to the recorded upstream checkout');
const version=toolchain.packages.scriptc,stem='STOCK_'+version.replaceAll('.','_'),work=join(root,'build','stock-'+version);
let iterations=30,baseline;const args=process.argv.slice(2);
while(args.length){const arg=args.shift();if(arg==='--iterations')iterations=Number(args.shift());else if(arg==='--baseline')baseline=resolve(args.shift());else throw new Error('unknown option '+arg);}
if(!Number.isSafeInteger(iterations)||iterations<1)throw new Error('iterations must be positive');
mkdirSync(work,{recursive:true});
const results={};
for(const [name,extra] of [['examples',['--examples']],['capped',[]]]){
 const output=`bench/${stem}_${name==='examples'?'EXAMPLES':'CAPPED_TOKEN'}_RESULTS.md`;
 console.log(`Benchmarking ${name==='examples'?'Counter and Token':'CappedToken'} with stock scriptc ${version}; ${iterations} measured repetitions.`);
 execFileSync(process.execPath,[join(root,'integration/run.mjs'),...extra,'--bench','--iterations',String(iterations),'--output',output,...(baseline?['--baseline',name==='examples'?baseline:join(baseline,'capped-token.wasm')]:[])],{cwd:root,stdio:'inherit',env:{...process.env,ALKANES_NATIVE_TESTS:'0',SCRIPTC_RUNTIME_PACK:join(root,'node_modules/@scriptc/runtime-wasm32-wasi')}});
 const runtime=join(root,'build/alkanes-runtime-test');
 for(const [file,destination] of [['benchmark.log',`${name}-benchmark.log`],['BUILD.json',`${name}-BUILD.json`]])copyFileSync(join(runtime,file),join(work,destination));
 const rows=readFileSync(join(runtime,'benchmark.log'),'utf8').split('\n').filter(line=>line.startsWith('ALKANES_TS_BENCH ')).map(line=>JSON.parse(line.slice(17)));
 const metadata=JSON.parse(readFileSync(join(runtime,'BUILD.json'),'utf8'));
 results[name]={rows,metadata,output};
}
const variants=[...(baseline?['typescript-before']:[]),'typescript','rust-o3-lto','rust-o3-lto-wasm-opt'];
const rows=[...results.examples.rows,...results.capped.rows.map(row=>({...row,method:'capped-token/'+row.method}))];
if(rows.length!==21*variants.length)throw new Error('expected every scenario/variant in the benchmark');
for(const row of rows)if(row.iterations!==iterations||row.fuel<=0||!Number.isFinite(row.median_us))throw new Error('invalid sample '+JSON.stringify(row));
const value=(method,variant)=>{const matches=rows.filter(row=>row.method===method&&row.variant===variant);if(matches.length!==1)throw new Error('missing or duplicate benchmark '+method+'/'+variant);return matches[0];};
const methods=[...new Set(rows.map(row=>row.method))];
const beforeVersion=results.examples.metadata.baselineBuild?.scriptc;
let report=`# Stock scriptc ${version} with the C SDK\n\nCounter, Token and CappedToken use the unchanged C-SDK build path. The installed compiler binary matches its official npm native package. Compiler, runtime and types are pinned together at ${version}; no compiler patches are applied or executed for this qualification. Authored contracts, SDK C sources and Rust fixtures are unchanged by the upgrade.\n\n`;
report+=`${iterations} measured repetitions after three warmups per variant/scenario, rotating variant order, on ${results.examples.metadata.machine}. Every invocation runs through the unmodified Alkanes indexer, canonical hosts and wasmi 0.37.2. Complete responses and resulting storage must match across variants; Token/CappedToken mint scenarios also verify actual UTXO balances.\n\n`;
report+='Fuel includes contract instructions, host/storage charges and nested execution. Time is local release-built wasm-bindgen/Node index_block latency, including Wasm compilation and instantiation. Transaction construction and inspection are excluded. Deployment includes fresh-chain bootstrap and standard-contract setup, so its time is not isolated initializer/deployment latency. No other builds/tests ran concurrently with timed benchmarks.\n\n';
report+='Both Rust variants use O3, fat LTO, one codegen unit and panic=abort. The stronger reference below also uses wasm-opt O3. Counter Rust has the same exact numeric sum fast path as TypeScript. TypeScript uses final wasm-opt Oz. CappedToken uses the same standard auth binary for every variant; nested Token calls use the same stock TypeScript Counter callee. Full per-variant tables and build provenance are in the linked reports.\n\n';
for(const contract of ['counter','token','capped-token']){
 report+=`## ${contract}\n\n| Call | Stock TS fuel | Rust + wasm-opt fuel | Stock TS median ms | Rust + wasm-opt median ms |\n|---|---:|---:|---:|---:|\n`;
 for(const method of methods.filter(method=>method.startsWith(contract+'/'))){const ts=value(method,'typescript'),rust=value(method,'rust-o3-lto-wasm-opt');report+=`| ${method.split('/')[1]} | ${ts.fuel} | ${rust.fuel} | ${(ts.median_us/1000).toFixed(3)} | ${(rust.median_us/1000).toFixed(3)} |\n`;}
 report+='\n';
}
if(baseline){
 report+=`## Paired upgrade from stock scriptc ${beforeVersion??'the saved baseline'}\n\nThe baseline uses the same C SDK and contract sources, not the older bigint backend. These percentages compare variants within this run. Positive values mean the ${version} build consumes more fuel or takes more time; local timing differences do not establish a universal performance change.\n\n| Scenario | Before fuel | ${version} fuel | Fuel change | Median time change |\n|---|---:|---:|---:|---:|\n`;
 for(const method of methods){const before=value(method,'typescript-before'),after=value(method,'typescript'),delta=(a,b)=>((a/b-1)*100).toFixed(2)+'%';report+=`| ${method} | ${before.fuel} | ${after.fuel} | ${delta(after.fuel,before.fuel)} | ${delta(after.median_us,before.median_us)} |\n`;}
 report+='\nBaseline build provenance:\n\n```json\n'+JSON.stringify(results.examples.metadata.baselineBuild??{note:'No BUILD.json was supplied with the optional baseline.'},null,2)+'\n```\n\n';
}
report+='## Reproduction and evidence\n\n`npm ci`, `npm run typecheck`, `npm test`, `ALKANES_RS=/path/to/alkanes-rs npm run test:examples`, then `ALKANES_RS=/path/to/alkanes-rs npm run bench:stock -- --iterations '+iterations+(baseline?' --baseline /path/to/saved-0.4.0-dist':'')+'`.\n\n';
report+='The optional version baseline can be reproduced by building revision aa4baa1d3dcf6c060a5ed7a381c8e9a261572456 in a separate checkout with its stock 0.4.0 lockfile. Copy its counter/token/capped-token Wasm files into the baseline directory. This run saved the pre-upgrade files directly; their hashes appear above and in both detailed reports.\n\n';
report+=`- [Counter and Token: all variants](${stem}_EXAMPLES_RESULTS.md)\n- [CappedToken: all variants](${stem}_CAPPED_TOKEN_RESULTS.md)\n- [Actual-runtime correctness](../integration/EXAMPLES_RESULTS.md)\n\n`;
report+='Stock toolchain provenance:\n\n```json\n'+JSON.stringify(results.examples.metadata.toolchain,null,2)+'\n```\n';
const destination=join(root,'bench',stem+'_RESULTS.md');writeFileSync(destination,report);console.log('Combined stock qualification report:',destination);
