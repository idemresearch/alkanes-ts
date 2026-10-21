// An optional, fail-closed lowering for straight-line word contracts. The
// normal frontend checks the source first. Unsupported syntax uses its bigint
// backend; no selector/name-specific contract implementation exists here.
import ts from 'typescript';
import {resolve,dirname} from 'node:path';
const bytes=s=>`new Uint8Array([${[...Buffer.from(s,'utf8')].join(',')}])`;
const operators=new Map([['+',0],['-',1],['===',2],['!==',3],['<',4],['<=',5],['>',6],['>=',7]]);
export function lowerWords({filename,source,manifest,abi,sdkDirectory}){
 const unsupported=Symbol('unsupported word subset');
 try{
  const file=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true);
  const cls=file.statements.find(n=>ts.isClassDeclaration(n));
  const fields=new Map(manifest.state.map(f=>[f.field,f]));
  const methods=new Map(manifest.methods.map(m=>[m.name,m]));
  const no=()=>{throw unsupported;};
  for(const node of file.statements)if(ts.isImportDeclaration(node)&&resolve(dirname(filename),node.moduleSpecifier.text)!==resolve(sdkDirectory,'authoring.ts'))no();
  for(const member of cls.members){
   if(ts.isPropertyDeclaration(member)){if(member.name.getText(file)!=='incomingAssets'&&!fields.has(member.name.getText(file)))no();}
   else if(!ts.isMethodDeclaration(member)||!methods.has(member.name.getText(file)))no();
  }
  if(manifest.methods.some(m=>m.returns==='CallResponse'))no();
  const literal=n=>{const v=BigInt(String(n).replaceAll('_','')),words=[];for(let i=0;i<4;i++)words.push(Number((v>>BigInt(i*32))&0xffff_ffffn));return `__alk_word.literal(${words.join(',')})`;};
  const code=[];
  for(const member of cls.members.filter(ts.isMethodDeclaration)){
   const method=methods.get(member.name.getText(file));
   const names=new Map(method.params.map(p=>[p.name,p.type]));
   const type=n=>{
    if(ts.isParenthesizedExpression(n))return type(n.expression);
    if(ts.isBigIntLiteral(n))return'u128';
    if(ts.isIdentifier(n)&&names.has(n.text))return names.get(n.text);
    if(ts.isPropertyAccessExpression(n)){
     if(n.expression.kind===ts.SyntaxKind.ThisKeyword&&fields.has(n.name.text))return fields.get(n.name.text).type;
     if(['block','tx'].includes(n.name.text)&&type(n.expression)==='AlkaneId')return'u128';
    }
    if(ts.isBinaryExpression(n)){
     const op=n.operatorToken.getText(file);
     if(['&&','||'].includes(op)&&type(n.left)==='boolean'&&type(n.right)==='boolean')return'boolean';
     if(operators.has(op)&&type(n.left)==='u128'&&type(n.right)==='u128')return operators.get(op)<2?'u128':'boolean';
    }
    if(n.kind===ts.SyntaxKind.TrueKeyword||n.kind===ts.SyntaxKind.FalseKeyword)return'boolean';
    if(ts.isPrefixUnaryExpression(n)&&n.operator===ts.SyntaxKind.ExclamationToken&&type(n.operand)==='boolean')return'boolean';
    no();
   };
   const expr=n=>{
    const t=type(n);
    if(ts.isParenthesizedExpression(n))return `(${expr(n.expression)})`;
    if(ts.isBigIntLiteral(n))return literal(n.text.replace(/n$/,''));
    if(ts.isIdentifier(n))return n.text;
    if(ts.isPropertyAccessExpression(n))return n.expression.kind===ts.SyntaxKind.ThisKeyword?`this.${n.name.text}`:`${expr(n.expression)}.${n.name.text}`;
    if(ts.isBinaryExpression(n)){
     const op=n.operatorToken.getText(file);
     if(['&&','||'].includes(op))return`(${expr(n.left)} ${op} ${expr(n.right)})`;
     return `__alk_word.op(this.__alk_ctx,${operators.get(op)},${expr(n.left)},${expr(n.right)})${t==='boolean'?'!==0':''}`;
    }
    if(ts.isPrefixUnaryExpression(n))return`!(${expr(n.operand)})`;
    return n.getText(file);
   };
   const fail=message=>`__alk_word.fail(this.__alk_ctx,${bytes('Error: '+message)});return 0;`;
   const statement=n=>{
    if(ts.isBlock(n))return`{${n.statements.map(statement).join('\n')}}`;
    if(ts.isIfStatement(n)){if(type(n.expression)!=='boolean')no();return`if(${expr(n.expression)}){${statement(n.thenStatement)}}${n.elseStatement?'else {'+statement(n.elseStatement)+'}':''}`;}
    if(ts.isVariableStatement(n)){
     if(!(n.declarationList.flags&ts.NodeFlags.BlockScoped))no();
     const declarations=n.declarationList.declarations.map(d=>{if(!ts.isIdentifier(d.name)||!d.initializer||names.has(d.name.text))no();const t=type(d.initializer);names.set(d.name.text,t);return`${d.name.text}=${expr(d.initializer)}`;});
     return`let ${declarations.join(',')};if(__alk_word.failed(this.__alk_ctx))return 0;`;
    }
    if(ts.isReturnStatement(n)){if(!n.expression)return'return 0;';if(type(n.expression)!==method.returns)no();return method.returns==='AlkaneId'?`{const __alk_result=${expr(n.expression)};return __alk_word.id(this.__alk_ctx,__alk_result.block,__alk_result.tx);}`:`return ${expr(n.expression)};`;}
    if(ts.isThrowStatement(n)&&ts.isNewExpression(n.expression)&&n.expression.expression.getText(file)==='Error'&&n.expression.arguments?.length===1&&ts.isStringLiteral(n.expression.arguments[0]))return fail(n.expression.arguments[0].text);
    if(ts.isExpressionStatement(n)){
     const e=n.expression;
     if(ts.isBinaryExpression(e)&&ts.isPropertyAccessExpression(e.left)&&e.left.expression.kind===ts.SyntaxKind.ThisKeyword&&fields.has(e.left.name.text)){
      const field=fields.get(e.left.name.text),op=e.operatorToken.getText(file);
      if(!['=','+=','-='].includes(op)||type(e.right)!==field.type||(op!=='='&&field.type!=='u128'))no();
      return`this.${field.field}=${op==='='?expr(e.right):`__alk_word.op(this.__alk_ctx,${op==='+='?0:1},this.${field.field},${expr(e.right)})`};if(__alk_word.failed(this.__alk_ctx))return 0;`;
     }
     if(ts.isCallExpression(e)){
      const callee=e.expression.getText(file);
      if(callee==='assert'&&e.arguments.length===2&&ts.isStringLiteral(e.arguments[1])&&type(e.arguments[0])==='boolean')return`if(!(${expr(e.arguments[0])})){${fail(e.arguments[1].text)}}if(__alk_word.failed(this.__alk_ctx))return 0;`;
      if(callee==='this.auth.require'&&e.arguments.length===1&&type(e.arguments[0])==='AlkaneId')return`{const __alk_id=${expr(e.arguments[0])};__alk_word.auth(this.__alk_ctx,__alk_id.block,__alk_id.tx);}if(__alk_word.failed(this.__alk_ctx))return 0;`;
      if(callee==='this.assets.mintSelf'&&e.arguments.length===1&&type(e.arguments[0])==='u128')return`__alk_word.mint(this.__alk_ctx,${expr(e.arguments[0])});if(__alk_word.failed(this.__alk_ctx))return 0;`;
     }
    }
    no();
   };
   code.push(`${method.name}(${method.params.map(p=>`${p.name}:${p.type==='AlkaneId'?'__alk_word.Id':'number'}`).join(',')}):number{${member.body.statements.map(statement).join('\n')}\nreturn 0;}`);
  }
  const state=[...fields.values()].map(f=>{
   const key=bytes(f.key),size=f.type==='AlkaneId'?32:16;
   return`private get ${f.field}():${size===32?'__alk_word.Id':'number'}{const p=__alk_word.load(this.__alk_ctx,${key},${literal(f.default??0)},${size});if(__alk_word.failed(this.__alk_ctx))__alk_word.explain(this.__alk_ctx,${bytes('Error: '+(size===32?'uninitialized or invalid AlkaneId state: ':'invalid u128 storage: ')+f.key)});return ${size===32?'new __alk_word.Id(p,p+16)':'p'};}
   private set ${f.field}(value:${size===32?'__alk_word.Id':'number'}){__alk_word.store(this.__alk_ctx,${key},${size===32?'__alk_word.id(this.__alk_ctx,value.block,value.tx)':'value'},${size});}`;
  }).join('\n');
  const initKey=bytes('/__alkanes/init'),lockKey=bytes('/__alkanes/lock');
  const fail=(msg)=>`__alk_word.fail(__alk_c,${bytes('Error: '+msg)});return __alk_finish(__alk_c,0,0);`;
  const branches=manifest.methods.map(m=>{
   const slots=m.params.reduce((n,p)=>n+(p.type==='AlkaneId'?2:1),1);
   let i=1;const args=m.params.map(p=>p.type==='AlkaneId'?`new __alk_word.Id(__alk_word.input(__alk_c,${i++}),__alk_word.input(__alk_c,${i++}))`:`__alk_word.input(__alk_c,${i++})`);
   const gate=manifest.initialized?(m.init?`if(__alk_word.op(__alk_c,3,__alk_word.load(__alk_c,${initKey},__alk_zero,16),__alk_zero)){${fail('ALREADY_INITIALIZED')}}__alk_word.store(__alk_c,${initKey},__alk_word.literal(1,0,0,0),16);`:
    `if(__alk_word.op(__alk_c,3,__alk_word.load(__alk_c,${initKey},__alk_zero,16),__alk_word.literal(2,0,0,0))){${fail('NOT_INITIALIZED')}}if(__alk_word.op(__alk_c,3,__alk_word.load(__alk_c,${lockKey},__alk_zero,16),__alk_zero)){${fail('REENTRANT_CALL')}}${m.view?'':`__alk_word.store(__alk_c,${lockKey},__alk_word.literal(1,0,0,0),16);`}`):'';
   return`if(__alk_word.op(__alk_c,2,__alk_opcode,${literal(m.opcode)})){
    if(__alk_word.count(__alk_c)<${slots}){${fail(m.abiName+' expects '+(slots-1)+' inputs')}}
    ${m.view||m.incomingAssets==='reject'?`if(__alk_word.incoming(__alk_c)!==0){${fail(m.view&&m.incomingAssets==='forward'?'view rejects incoming assets':'contract rejects incoming assets')}}`:''}
    __alk_word.forward(__alk_c,${!m.view&&m.incomingAssets==='forward'?1:0});
    ${gate}if(__alk_word.failed(__alk_c))return __alk_finish(__alk_c,0,0);__alk_word.readOnly(__alk_c,${m.view?1:0});
    const value=__alk_contract.${m.name}(${args.join(',')});
    if(__alk_word.failed(__alk_c))return __alk_finish(__alk_c,0,0);
    ${manifest.initialized?(m.init?`__alk_word.store(__alk_c,${initKey},__alk_word.literal(2,0,0,0),16);`:m.view?'':`__alk_word.store(__alk_c,${lockKey},__alk_zero,16);`):''}
    return __alk_finish(__alk_c,${m.returns==='void'?'0':'value'},${m.returns==='void'?0:m.returns==='AlkaneId'?32:16});
   }`;
  });
  const errors=['','unexpected end of input reading u128','u128 overflow','u128 underflow','invalid u128 storage','uninitialized or invalid AlkaneId state','view cannot mutate storage or call a mutating contract','AUTH_ASSET_REQUIRED','AUTH_REJECTED','AUTH_FUEL_OUT_OF_RANGE','Extcall failed (no details available)','Extcall failed: ','Unrecognized opcode '];
  return`// Generated fixed-width lowering; user methods are still compiled by scriptc.
import * as __alk_word from ${JSON.stringify(resolve(sdkDirectory,'word.ts'))};
function __alk_finish(__alk_c:number,value:number,len:number):number{
 const code=__alk_word.status(__alk_c);
 ${errors.flatMap((s,i)=>s?[`if(code===${i})return __alk_word.finish(__alk_c,value,len,${bytes('Error: '+s)});`]:[]).join('\n')}
 return __alk_word.finish(__alk_c,value,len,new Uint8Array());
}
class __alk_program{constructor(private readonly __alk_ctx:number){}${state}\n${code.join('\n')}}
export function execute(context:Uint8Array):number{
 const __alk_c=__alk_word.begin(context,${manifest.trackedAssets?1:0});if(__alk_word.failed(__alk_c))return __alk_finish(__alk_c,0,0);
 if(__alk_word.count(__alk_c)===0){${fail('No opcode provided')}}
 const __alk_zero=__alk_word.literal(0,0,0,0),__alk_opcode=__alk_word.input(__alk_c,0),__alk_contract=new __alk_program(__alk_c);
 ${branches.join('\n')}
 __alk_word.unknown(__alk_c,__alk_opcode);return __alk_finish(__alk_c,0,0);
}
export function meta():Uint8Array{return ${bytes(abi)};}
`;
 }catch(error){if(error===unsupported)return null;throw error;}
}
