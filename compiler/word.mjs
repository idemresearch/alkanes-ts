// An optional, fail-closed lowering for straight-line word contracts. The
// normal frontend checks the source first. Unsupported syntax uses its bigint
// backend; no selector/name-specific contract implementation exists here.
import ts from 'typescript';
import {resolve,dirname} from 'node:path';
// Builds a constant buffer in place. An array literal would first build a
// temporary f64 array whose freed memory the initialization snapshot keeps.
const fill=(name,data)=>[`const ${name}=new Uint8Array(${data.length});`,...[...data].flatMap((b,i)=>b?[`${name}[${i}]=${b};`]:[])].join('\n');
const operators=new Map([['+',0],['-',1],['===',2],['!==',3],['<',4],['<=',5],['>',6],['>=',7]]);
export function lowerWords({filename,source,manifest,abi,sdkDirectory}){
 const unsupported=Symbol('unsupported word subset');
 try{
  const file=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true);
  const cls=file.statements.find(n=>ts.isClassDeclaration(n));
  const fields=new Map(manifest.state.map(f=>[f.field,f]));
  const methods=new Map(manifest.methods.map(m=>[m.name,m]));
  const no=()=>{if(process.env.ALKANES_DEBUG_LOWERING)console.error(new Error('word lowering fallback').stack);throw unsupported;};
  // Byte strings and u128 literals are pure, so each distinct value becomes
  // one module constant built during (snapshotted) module initialization.
  // Word handles are immutable and C leaves only read byte arguments.
  const constants=new Map(),hoist=(key,emit)=>{if(!constants.has(key))constants.set(key,{name:'__alk_lit_'+constants.size,emit});return constants.get(key).name;};
  const bytes=s=>hoist('bytes:'+s,name=>fill(name,Buffer.from(s,'utf8')));
  // ---- word-v1 extension state: u128.ts math imports, private helpers,
  // custody/division error codes and the helper call graph. ----
  const mathOps=new Map([['mulDiv',['op3',0,3]],['mulDivUp',['op3',1,3]],['mulSqrt',['op3',2,2]],['sqrt',['op3',3,1]],['min',['op3',7,2]],['max',['op3',8,2]]]);
  const math=new Set(),helpers=new Map(),calls=new Map(),used=new Set();
  // Only unaliased named imports of the listed sdk/u128.ts functions.
  const mathImport=node=>{
   if(resolve(dirname(filename),node.moduleSpecifier.text)!==resolve(sdkDirectory,'u128.ts'))return false;
   const clause=node.importClause;
   if(!clause||clause.isTypeOnly||clause.name||!clause.namedBindings||!ts.isNamedImports(clause.namedBindings))return false;
   for(const b of clause.namedBindings.elements){if(b.propertyName||b.isTypeOnly||!mathOps.has(b.name.text))return false;math.add(b.name.text);}
   return true;
  };
  // height() and the AlkaneId, Cellpack and AlkaneTransferParcel
  // constructors, as unaliased named value imports from a module exporting them.
  const sdkValues=new Map([['height',['runtime.ts','index.ts']],['AlkaneId',['types.ts','index.ts']],['Cellpack',['types.ts','index.ts']],['AlkaneTransferParcel',['types.ts','index.ts']]]),sdkNames=new Set();
  const sdkImport=node=>{
   const from=resolve(dirname(filename),node.moduleSpecifier.text),clause=node.importClause;
   if(!clause||clause.isTypeOnly||clause.name||!clause.namedBindings||!ts.isNamedImports(clause.namedBindings))return false;
   for(const b of clause.namedBindings.elements){if(b.propertyName||b.isTypeOnly||!sdkValues.get(b.name.text)?.some(m=>from===resolve(sdkDirectory,m)))return false;sdkNames.add(b.name.text);}
   return true;
  };
  // Undecorated methods are helpers; their types come from the declaration.
  const helper=member=>{
   if(!ts.isMethodDeclaration(member)||ts.getDecorators(member)?.length||!ts.isIdentifier(member.name)||!member.body||member.typeParameters||member.asteriskToken||member.questionToken)return false;
   const returns=member.type?.getText(file),params=[];
   if(!['u128','AlkaneId','boolean','void'].includes(returns))return false;
   for(const p of member.parameters){
    const t=p.type?.getText(file);
    if(!ts.isIdentifier(p.name)||!['u128','AlkaneId','boolean'].includes(t)||p.initializer||p.questionToken||p.dotDotDotToken)return false;
    params.push({name:p.name.text,type:t});
   }
   helpers.set(member.name.text,{name:member.name.text,params,returns});
   return true;
  };
  // ---- end extension state ----
  for(const node of file.statements)if(ts.isImportDeclaration(node)&&resolve(dirname(filename),node.moduleSpecifier.text)!==resolve(sdkDirectory,'authoring.ts')&&!mathImport(node)&&!sdkImport(node))no();
  for(const member of cls.members){
   if(ts.isPropertyDeclaration(member)){if(member.name.getText(file)!=='incomingAssets'&&!fields.has(member.name.getText(file)))no();}
   else if(!ts.isMethodDeclaration(member)||!(methods.has(member.name.getText(file))||helper(member)))no();
  }
  if(manifest.methods.some(m=>m.returns==='CallResponse'))no();
  const literal=n=>{const v=BigInt(String(n).replaceAll('_','')),words=[];for(let i=0;i<4;i++)words.push(Number((v>>BigInt(i*32))&0xffff_ffffn));return hoist('u128:'+v,name=>`const ${name}=__alk_word.literal(${words.join(',')});`);};
  const code=[];
  for(const member of cls.members.filter(ts.isMethodDeclaration)){
   const method=methods.get(member.name.getText(file))??helpers.get(member.name.getText(file));
   // Imported names are never shadowed, so each use below is the import.
   {const visit=n=>{if((ts.isVariableDeclaration(n)||ts.isParameter(n))&&ts.isIdentifier(n.name)&&(sdkNames.has(n.name.text)||math.has(n.name.text)))no();ts.forEachChild(n,visit);};visit(member);}
   const names=new Map(method.params.map(p=>[p.name,p.type]));
   const type=n=>{
    const extended=typeExt(n);if(extended)return extended;
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
    const extended=exprExt(n);if(extended!==undefined)return extended;
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
    const extended=statementExt(n);if(extended!==undefined)return extended;
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
   // ---- word-v1 extensions: checked * / %, u128.ts math, custody, myself,
   // ternaries, boolean equality, private helpers and let reassignment. Every
   // emitted operation is a C leaf that no-ops after the first latched error,
   // and every statement checks the latch, so the first failure wins. ----
   const ctx='this.__alk_ctx',check=`if(__alk_word.failed(${ctx}))return 0;`;
   // Wide kinds go through op3 so the hot op() leaf keeps its small frame.
   const arithmetic=new Map([['*',4],['/',5],['%',6]]);
   const lets=new Set();
   const imported=(n,name)=>ts.isIdentifier(n)&&n.text===name&&sdkNames.has(name)&&!names.has(name);
   // AlkaneId.equals: any receiver typed AlkaneId (helpers named equals are this.equals).
   const equalsCall=n=>ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='equals'&&n.expression.expression.kind!==ts.SyntaxKind.ThisKeyword;
   const isMyself=n=>ts.isPropertyAccessExpression(n)&&n.name.text==='myself'&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='context'&&n.expression.expression.kind===ts.SyntaxKind.ThisKeyword;
   const helperCall=n=>ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.expression.kind===ts.SyntaxKind.ThisKeyword&&helpers.has(n.expression.name.text)?helpers.get(n.expression.name.text):null;
   const args=(n,types)=>{if(n.arguments.length!==types.length||n.arguments.some((a,i)=>type(a)!==types[i]))no();return n.arguments.map(a=>expr(a));};
   const typeExt=n=>{
    if(isMyself(n))return'AlkaneId';
    if(ts.isNewExpression(n)&&imported(n.expression,'AlkaneId')){if(n.arguments?.length!==2||n.arguments.some(a=>type(a)!=='u128'))no();return'AlkaneId';}
    if(ts.isConditionalExpression(n)){if(type(n.condition)!=='boolean')no();const t=type(n.whenTrue);if(type(n.whenFalse)!==t)no();return t;}
    if(ts.isBinaryExpression(n)){
     const op=n.operatorToken.getText(file);
     if(arithmetic.has(op)){if(type(n.left)!=='u128'||type(n.right)!=='u128')no();if(op!=='*')used.add(13);return'u128';}
     if(['===','!=='].includes(op)&&type(n.left)==='boolean'){if(type(n.right)!=='boolean')no();return'boolean';}
     return undefined;
    }
    if(!ts.isCallExpression(n))return undefined;
    const callee=n.expression.getText(file),h=helperCall(n);
    if(ts.isIdentifier(n.expression)&&math.has(callee)&&!names.has(callee)){
     if(n.arguments.length!==mathOps.get(callee)[2]||n.arguments.some(a=>type(a)!=='u128'))no();
     if(callee==='mulDiv'||callee==='mulDivUp')used.add(13);
     return'u128';
    }
    if(callee==='this.assets.received'||callee==='this.assets.held'){
     if(n.arguments.length!==1||type(n.arguments[0])!=='AlkaneId')no();
     if(callee==='this.assets.held')used.add(16);
     return'u128';
    }
    if(h&&h.returns!=='void'){
     if(n.arguments.length!==h.params.length||n.arguments.some((a,i)=>type(a)!==h.params[i].type))no();
     if(!calls.has(method.name))calls.set(method.name,new Set());calls.get(method.name).add(h.name);
     return h.returns;
    }
    if(imported(n.expression,'height')){if(n.arguments.length)no();return'u128';}
    if(callee==='this.assets.available'){if(n.arguments.length!==1||type(n.arguments[0])!=='AlkaneId')no();return'u128';}
    if(equalsCall(n)){if(n.arguments.length!==1||type(n.expression.expression)!=='AlkaneId'||type(n.arguments[0])!=='AlkaneId')no();return'boolean';}
    no();
   };
   const exprExt=n=>{
    if(isMyself(n))return`__alk_word.myself(${ctx})`;
    if(ts.isNewExpression(n)&&imported(n.expression,'AlkaneId'))return`new __alk_word.Id(${expr(n.arguments[0])},${expr(n.arguments[1])})`;
    if(ts.isConditionalExpression(n))return`((${expr(n.condition)})?(${expr(n.whenTrue)}):(${expr(n.whenFalse)}))`;
    if(ts.isBinaryExpression(n)){
     const op=n.operatorToken.getText(file);
     if(arithmetic.has(op))return`__alk_word.op3(${ctx},${arithmetic.get(op)},${expr(n.left)},${expr(n.right)},0)`;
     if(['===','!=='].includes(op)&&type(n.left)==='boolean')return`((${expr(n.left)})${op}(${expr(n.right)}))`;
     return undefined;
    }
    if(!ts.isCallExpression(n))return undefined;
    const callee=n.expression.getText(file),h=helperCall(n);
    if(ts.isIdentifier(n.expression)&&math.has(callee)&&!names.has(callee)){
     const [fn,kind,arity]=mathOps.get(callee),values=n.arguments.map(a=>expr(a));
     while(fn==='op3'&&values.length<3)values.push('0');
     return`__alk_word.${fn}(${ctx},${kind},${values.join(',')})`;
    }
    if(callee==='this.assets.received'||callee==='this.assets.held')return`__alk_word.${n.expression.name.text}(${ctx},${expr(n.arguments[0])})`;
    if(h){const call=`this.${h.name}(${n.arguments.map(a=>expr(a)).join(',')})`;return h.returns==='boolean'?`(${call}!==0)`:h.returns==='AlkaneId'?`__alk_word.at(${call})`:call;}
    if(imported(n.expression,'height'))return`__alk_word.height(${ctx})`;
    if(callee==='this.assets.available')return`__alk_word.available(${ctx},${expr(n.arguments[0])})`;
    if(equalsCall(n))return`__alk_word.same(${ctx},${expr(n.expression.expression)},${expr(n.arguments[0])})`;
    return undefined;
   };
   const statementExt=n=>{
    if(ts.isVariableStatement(n)&&n.declarationList.flags&ts.NodeFlags.Let)for(const d of n.declarationList.declarations)if(ts.isIdentifier(d.name))lets.add(d.name.text);
    // Lowered helpers return scalars: booleans travel as 0/1.
    if(ts.isReturnStatement(n)&&method.returns==='boolean'){if(!n.expression||type(n.expression)!=='boolean')no();return`return (${expr(n.expression)})?1:0;`;}
    if(!ts.isExpressionStatement(n))return undefined;
    const e=n.expression;
    if(ts.isBinaryExpression(e)&&ts.isIdentifier(e.left)){
     const name=e.left.text,op=e.operatorToken.getText(file),t=names.get(name);
     if(!lets.has(name))no();
     if(op==='='){if(type(e.right)!==t)no();return`${name}=${expr(e.right)};${check}`;}
     const [fn,kind]={'+=':['op',0],'-=':['op',1],'*=':['op3',4],'/=':['op3',5],'%=':['op3',6]}[op]??[];
     if(kind===undefined||t!=='u128'||type(e.right)!=='u128')no();
     if(op==='/='||op==='%=')used.add(13);
     return`${name}=__alk_word.${fn}(${ctx},${kind},${name},${expr(e.right)}${fn==='op3'?',0':''});${check}`;
    }
    if(!ts.isCallExpression(e))return undefined;
    const callee=e.expression.getText(file),h=helperCall(e);
    // this.assets.call(new Cellpack(target, [u128...]), new AlkaneTransferParcel()
    // .pay(id, amount)..., fuel) with its response unused. Arguments are
    // evaluated first in JS order (target, inputs, then each pay's id and
    // amount); the fuel limit is an integer literal that crosses as a double.
    if(callee==='this.assets.call'){
     const [cellpack,parcel,budget]=e.arguments;
     if(e.arguments.length!==3||!ts.isNewExpression(cellpack)||!imported(cellpack.expression,'Cellpack')||cellpack.arguments?.length!==2||!ts.isArrayLiteralExpression(cellpack.arguments[1]))no();
     const [target,list]=cellpack.arguments;
     if(type(target)!=='AlkaneId'||list.elements.some(x=>type(x)!=='u128'))no();
     const pays=[];let node=parcel;
     while(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='pay'){
      if(node.arguments.length!==2||type(node.arguments[0])!=='AlkaneId'||type(node.arguments[1])!=='u128')no();
      pays.unshift(node.arguments);node=node.expression.expression;
     }
     if(!ts.isNewExpression(node)||!imported(node.expression,'AlkaneTransferParcel')||node.arguments?.length)no();
     const fuel=ts.isNumericLiteral(budget)?Number(budget.text):NaN;
     if(!Number.isSafeInteger(fuel)||fuel<0||list.elements.length>0xffff||pays.length>0x7fff)no();
     if(pays.length)used.add(18);
     const parts=[],temp=x=>{const name='__alk_x'+parts.length;parts.push(`const ${name}=${expr(x)};`);return name;};
     const id=temp(target),inputs=list.elements.map(temp),transfers=pays.map(([asset,amount])=>[temp(asset),temp(amount)]);
     return`{${parts.join('')}const __alk_b=__alk_word.cellpack(${ctx},${id},${inputs.length+transfers.length*65536});${inputs.map(v=>`__alk_word.arg(${ctx},__alk_b,${v});`).join('')}${transfers.map(([asset,amount])=>`__alk_word.pay(${ctx},__alk_b,${asset},${amount});`).join('')}__alk_word.invoke(${ctx},__alk_b,${literal(fuel)});}${check}`;
    }
    if(callee==='this.assets.retain'||callee==='this.assets.send'){
     const [id,amount]=args(e,['AlkaneId','u128']);
     if(callee==='this.assets.retain')used.add(14);else{used.add(15);used.add(17);}
     return`__alk_word.${e.expression.name.text}(${ctx},${id},${amount});${check}`;
    }
    if(h){
     if(e.arguments.length!==h.params.length||e.arguments.some((a,i)=>type(a)!==h.params[i].type))no();
     if(!calls.has(method.name))calls.set(method.name,new Set());calls.get(method.name).add(h.name);
     return`this.${h.name}(${e.arguments.map(a=>expr(a)).join(',')});${check}`;
    }
    return undefined;
   };
   // ---- end word-v1 extensions ----
   code.push(`${method.name}(${method.params.map(p=>`${p.name}:${p.type==='AlkaneId'?'__alk_word.Id':p.type==='boolean'?'boolean':'number'}`).join(',')}):number{${member.body.statements.map(statement).join('\n')}\nreturn 0;}`);
  }
  // The C stack and arena assume a bounded, nonrecursive helper call graph.
  {const done=new Set(),active=new Set();
   const visit=name=>{if(done.has(name))return;if(active.has(name))no();active.add(name);for(const next of calls.get(name)??[])visit(next);active.delete(name);done.add(name);};
   for(const name of calls.keys())visit(name);}
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
   const gate=manifest.initialized?(m.init?`if(__alk_word.op(__alk_c,3,__alk_word.load(__alk_c,${initKey},__alk_zero,16),__alk_zero)){${fail('ALREADY_INITIALIZED')}}__alk_word.store(__alk_c,${initKey},${literal(1)},16);`:
    `if(__alk_word.op(__alk_c,3,__alk_word.load(__alk_c,${initKey},__alk_zero,16),${literal(2)})){${fail('NOT_INITIALIZED')}}if(__alk_word.op(__alk_c,3,__alk_word.load(__alk_c,${lockKey},__alk_zero,16),__alk_zero)){${fail('REENTRANT_CALL')}}${m.view?'':`__alk_word.store(__alk_c,${lockKey},${literal(1)},16);`}`):'';
   // Selector test. The invocation has not failed here (begin and the input
   // count were checked), so op(...,2,...) is plain u128 equality. toNumber is
   // exact below 2^53 and maps larger values to at least 2^53, so numeric
   // equality takes the same branch with one conversion for the whole chain.
   const small=BigInt(m.opcode)<(1n<<53n);
   return`if(${small?`__alk_selector===${BigInt(m.opcode)}`:`__alk_word.op(__alk_c,2,__alk_opcode,${literal(m.opcode)})`}){
    if(__alk_word.count(__alk_c)<${slots}){${fail(m.abiName+' expects '+(slots-1)+' inputs')}}
    ${m.view||m.incomingAssets==='reject'?`if(__alk_word.incoming(__alk_c)!==0){${fail(m.view&&m.incomingAssets==='forward'?'view rejects incoming assets':'contract rejects incoming assets')}}`:''}
    __alk_word.forward(__alk_c,${!m.view&&m.incomingAssets==='forward'?1:0});
    ${gate}if(__alk_word.failed(__alk_c))return __alk_finish(__alk_c,0,0);__alk_word.readOnly(__alk_c,${m.view?1:0});
    const value=__alk_contract.${m.name}(${args.join(',')});
    if(__alk_word.failed(__alk_c))return __alk_finish(__alk_c,0,0);
    ${manifest.initialized?(m.init?`__alk_word.store(__alk_c,${initKey},${literal(2)},16);`:m.view?'':`__alk_word.store(__alk_c,${lockKey},__alk_zero,16);`):''}
    return __alk_finish(__alk_c,${m.returns==='void'?'0':'value'},${m.returns==='void'?0:m.returns==='AlkaneId'?32:16});
   }`;
  });
  const errors=['','unexpected end of input reading u128','u128 overflow','u128 underflow','invalid u128 storage','uninitialized or invalid AlkaneId state','view cannot mutate storage or call a mutating contract','AUTH_ASSET_REQUIRED','AUTH_REJECTED','AUTH_FUEL_OUT_OF_RANGE','Extcall failed (no details available)','Extcall failed: ','Unrecognized opcode '];
  // Codes 13+ (shim/word.c) are emitted only when the contract can raise them,
  // so contracts outside the extension keep their exact status dispatch.
  for(const [code,message] of [[13,'u128 division by zero'],[14,'INSUFFICIENT_LEDGER'],[15,'INSUFFICIENT_CUSTODY'],[16,'SELF_CUSTODY_UNSUPPORTED'],[17,'SELF_SEND_USE_MINT_SELF'],[18,'PRECOMPILE_TAKES_NO_ASSETS']])errors[code]=used.has(code)?message:'';
  const body=`function __alk_finish(__alk_c:number,value:number,len:number):number{
 const code=__alk_word.status(__alk_c);
 ${errors.flatMap((s,i)=>s?[`if(code===${i})return __alk_word.finish(__alk_c,value,len,${bytes('Error: '+s)});`]:[]).join('\n')}
 return __alk_word.finish(__alk_c,value,len,${bytes('')});
}
class __alk_program{constructor(private readonly __alk_ctx:number){}${state}\n${code.join('\n')}}
export function execute(context:Uint8Array):number{
 const __alk_c=__alk_word.begin(context,${manifest.trackedAssets?1:0});if(__alk_word.failed(__alk_c))return __alk_finish(__alk_c,0,0);
 if(__alk_word.count(__alk_c)===0){${fail('No opcode provided')}}
 const __alk_zero=${literal(0)},__alk_opcode=__alk_word.input(__alk_c,0),__alk_contract=new __alk_program(__alk_c);
 ${manifest.methods.some(m=>BigInt(m.opcode)<(1n<<53n))?'const __alk_selector=__alk_word.toNumber(__alk_opcode);':''}
 ${branches.join('\n')}
 __alk_word.unknown(__alk_c,__alk_opcode);return __alk_finish(__alk_c,0,0);
}
export function meta():Uint8Array{return ${bytes(abi)};}
`;
  return`// Generated fixed-width lowering; user methods are still compiled by scriptc.
import * as __alk_word from ${JSON.stringify(resolve(sdkDirectory,'word.ts'))};
${[...constants.values()].map(c=>c.emit(c.name)).join('\n')}
${body}`;
 }catch(error){if(error===unsupported)return null;throw error;}
}
