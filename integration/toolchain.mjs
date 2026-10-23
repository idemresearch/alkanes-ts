// Record the exact installed stock compiler used by the integration build.
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
export function stockToolchain(root){
 const read=path=>JSON.parse(readFileSync(path,'utf8'));
 const sha=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
 const configured=read(join(root,'package.json')).devDependencies;
 const packages=Object.fromEntries(['scriptc','@scriptc/runtime-wasm32-wasi','@scriptc/types'].map(name=>{
  const installed=read(join(root,'node_modules',name,'package.json'));
  if(installed.version!==configured[name])throw new Error(`${name}: installed ${installed.version} differs from pinned ${configured[name]}`);
  return[name,installed.version];
 }));
 if(new Set(Object.values(packages)).size!==1)throw new Error('scriptc compiler/runtime/types must have matching versions');
 const cli=read(join(root,'node_modules/scriptc/package.json'));
 const executable=realpathSync(join(root,'node_modules/scriptc',cli.bin.scriptc));
 const executableSHA256=sha(executable);
 let nativePackage;
 for(const name of Object.keys(cli.optionalDependencies??{})){
  const directory=join(root,'node_modules',name),manifest=join(directory,'package.json');
  const binary=join(directory,'dist/bin',process.platform==='win32'?'scriptc.exe':'scriptc');
  if(existsSync(manifest)&&existsSync(binary)&&read(manifest).version===packages.scriptc&&sha(binary)===executableSHA256){nativePackage=name;break;}
 }
 if(!nativePackage)throw new Error('installed scriptc executable does not match an official native package');
 const lock=read(join(root,'package-lock.json'));
 return{mode:'stock scriptc CLI',compilerPatches:[],packages,nativePackage,executableSHA256,nativePackageIntegrity:lock.packages['node_modules/'+nativePackage]?.integrity,packageLockSHA256:sha(join(root,'package-lock.json')),node:process.version};
}
