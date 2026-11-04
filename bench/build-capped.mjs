import {execFileSync} from 'node:child_process';
import {copyFileSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..');
if(!process.env.ALKANES_RS)throw new Error('set ALKANES_RS to an alkanes-rs checkout');
const upstream=resolve(process.env.ALKANES_RS),work=join(root,'build/rust-capped'),out=join(root,'bench/dist/capped');
mkdirSync(out,{recursive:true});
// alkanes-rs v3 takes metashrew from a git tag instead of crates/.
const upstreamDependency = (dep) => {
  if (existsSync(join(upstream, "crates", dep, "Cargo.toml"))) return `${dep} = { path = ${JSON.stringify(join(upstream, "crates", dep))} }`;
  const git = new RegExp(`^${dep}\\s*=\\s*\\{\\s*git\\s*=\\s*"([^"]+)",\\s*tag\\s*=\\s*"([^"]+)"`, "m").exec(readFileSync(join(upstream, "Cargo.toml"), "utf8"));
  if (!git) throw new Error(`alkanes-rs has no ${dep} crate or git dependency`);
  return `${dep} = { git = ${JSON.stringify(git[1])}, tag = ${JSON.stringify(git[2])} }`;
};
const toolchain=/channel\s*=\s*"([^"]+)"/.exec(readFileSync(join(upstream,'rust-toolchain.toml'),'utf8'))[1];
for(const name of ['capped-token','test-auth']){
 const crate=join(work,name);mkdirSync(join(crate,'src'),{recursive:true});
 copyFileSync(join(root,'bench/rust',name,'src/lib.rs'),join(crate,'src/lib.rs'));
 writeFileSync(join(crate,'Cargo.toml'),`[package]\nname="alkanes-bench-${name}"\nversion="0.0.0"\nedition="2021"\n[lib]\ncrate-type=["cdylib"]\n[dependencies]\n${['alkanes-runtime','alkanes-support','metashrew-support'].map(upstreamDependency).join('\n')}\nanyhow="1.0.90"\n`);
}
writeFileSync(join(work,'Cargo.toml'),'[workspace]\nmembers=["capped-token","test-auth"]\nresolver="2"\n[profile.release]\nopt-level=3\nlto="fat"\ncodegen-units=1\npanic="abort"\n');
copyFileSync(join(upstream,'Cargo.lock'),join(work,'Cargo.lock'));
// Each upstream revision builds in its own target directory (see build-rust.mjs).
const targetDir=join(root,'build/rust-comparison/target',execFileSync('git',['rev-parse','HEAD'],{cwd:upstream,encoding:'utf8'}).trim().slice(0,12));
execFileSync('cargo',[`+${toolchain}`,'build','--release','--target','wasm32-unknown-unknown','--manifest-path',join(work,'Cargo.toml')],{stdio:'inherit',env:{...process.env,CARGO_TARGET_DIR:targetDir}});
for(const name of ['capped-token','test-auth'])copyFileSync(join(targetDir,'wasm32-unknown-unknown/release',`alkanes_bench_${name.replaceAll('-','_')}.wasm`),join(out,`rust-${name}.wasm`));
const features=['--mvp-features','--enable-bulk-memory','--enable-sign-ext','--enable-nontrapping-float-to-int','--enable-mutable-globals'];
execFileSync(join(root,'node_modules/.bin/wasm-opt'),[...features,'-O3',join(out,'rust-capped-token.wasm'),'-o',join(out,'rust-capped-token-opt.wasm')],{stdio:'inherit'});
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
writeFileSync(join(out,'BUILD.txt'),`alkanes-rs: ${execFileSync('git',['rev-parse','HEAD'],{cwd:upstream,encoding:'utf8'}).trim()}\nupstream tracked changes: ${!!execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:upstream,encoding:'utf8'}).trim()}\nRust: ${execFileSync('rustc',[`+${toolchain}`,'--version'],{encoding:'utf8'}).trim()}\nprofile: opt-level=3, lto=fat, codegen-units=1, panic=abort\nwasm-opt: ${execFileSync(join(root,'node_modules/.bin/wasm-opt'),['--version'],{encoding:'utf8'}).trim()}\nupstream Cargo.lock SHA-256: ${sha(join(upstream,'Cargo.lock'))}\ncomparison Cargo.lock SHA-256: ${sha(join(work,'Cargo.lock'))}\n${['rust-capped-token','rust-capped-token-opt','rust-test-auth'].map(n=>`${n}.wasm SHA-256: ${sha(join(out,n+'.wasm'))}`).join('\n')}\n`);
