#!/usr/bin/env node
// Prepare an isolated, pinned release checkout and apply the reviewable patch.
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../..'),base=join(root,'build/scriptc-native'),up=join(base,'upstream'),toolchain=join(base,'toolchain');
const revision='4d049fbb8cc719e20cb52cd444b0d54db89f638a',patch=join(root,'patches/scriptc/0.4.2-alkanes.patch');
mkdirSync(toolchain,{recursive:true});
for(const file of ['package.json','package-lock.json'])copyFileSync(join(import.meta.dirname,file),join(toolchain,file));
execFileSync('npm',['ci','--no-audit','--no-fund'],{cwd:toolchain,stdio:'inherit'});
if(!existsSync(join(up,'.git')))execFileSync('git',['clone','--depth','1','--branch','v0.4.2','https://github.com/vercel-labs/scriptc.git',up],{cwd:root,stdio:'inherit'});
if(execFileSync('git',['rev-parse','HEAD'],{cwd:up,encoding:'utf8'}).trim()!==revision)throw new Error('unexpected scriptc revision');
if(spawnSync('git',['apply','--reverse','--check',patch],{cwd:up,stdio:'ignore'}).status!==0){
 execFileSync('git',['apply','--check',patch],{cwd:up,stdio:'inherit'});
 execFileSync('git',['apply',patch],{cwd:up,stdio:'inherit'});
}
console.log('scriptc v0.4.2 native patch ready at',up);
