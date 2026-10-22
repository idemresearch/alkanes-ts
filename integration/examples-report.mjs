import {readFileSync} from 'node:fs';
import {join} from 'node:path';
export function examplesReport({root,rows,metadata,iterations,baseline}){
 const variants=[...(baseline?['typescript-before']:[]),'typescript','rust-o3-lto','rust-o3-lto-wasm-opt'];
 if(rows.length!==15*variants.length)throw new Error('missing example benchmark rows');
 let report='# Counter and Token on the actual Alkanes runtime\n\n';
 report+=`${metadata.machine}; scriptc ${metadata.scriptc}. Three warmups and ${iterations} measured repetitions per variant/scenario, rotating variant order. All implementations execute through the unmodified upstream indexer, canonical hosts, real UTXO balances and wasmi 0.37.2.\n\n`;
 report+='Fuel is the outer entry allocation minus canonical `FuelTank` remainder, including nested execution and host/storage fees. This upstream trace serializer drops exit fuel, so exit-trace zeros are not used. Median time measures local release-built wasm-bindgen/Node `index_block`, including module compilation and instantiation. Deployment rows include fresh-chain bootstrap, not isolated initializer latency. Fixture construction/inspection is excluded. This is local indexing latency, not RPC latency.\n\n';
 report+='Counter Rust uses the same exact-number fast path up to n=300,000 as TS, plus checked u128 multiplication/addition in the fallback. It also rejects incoming assets on all entrypoints, matching Counter. Both Rust variants use O3, fat LTO, one codegen unit and panic=abort; the final column additionally uses wasm-opt O3. Token preserves caller-ID ownership and legacy forwarding, including duplicate/zero entries. Every repetition checks complete responses and resulting storage across all variants; minted balances are checked against actual outgoing UTXOs. The nested-call scenario uses the same optimized TS Counter callee for every Token variant.\n\n';
 report+='Rust build:\n\n```text\n'+readFileSync(join(root,'bench/dist/BUILD.txt'),'utf8')+'```\n\n';
 for(const contract of ['counter','token']){
  report+=`## ${contract==='counter'?'Counter':'Token'}\n\n| scenario | ${variants.map(v=>v+' fuel').join(' | ')} | ${variants.map(v=>v+' µs').join(' | ')} |\n|---${'|---:'.repeat(variants.length*2)}|\n`;
  for(const method of [...new Set(rows.filter(r=>r.method.startsWith(contract+'/')).map(r=>r.method))]){
   const values=variants.map(v=>rows.find(r=>r.variant===v&&r.method===method));
   report+=`| ${method.split('/')[1]} | ${values.map(v=>v.fuel).join(' | ')} | ${values.map(v=>v.median_us.toFixed(1)).join(' | ')} |\n`;
  }report+='\n';
 }
 report+='Build metadata:\n\n```json\n'+JSON.stringify(metadata,null,2)+'\n```\n\n';
 report+='Reproduce: `ALKANES_RS=/path/to/alkanes-rs npm run test:examples`, `npm run build:bench:examples`, then `ALKANES_RS=/path/to/alkanes-rs npm run bench:examples -- --iterations '+iterations+(baseline?' --baseline dist/examples-before':'')+'`. Use the upstream/toolchain versions above.\n';
 return report;
}
